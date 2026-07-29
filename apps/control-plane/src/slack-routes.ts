/**
 * The Slack webhook: `POST /webhooks/slack/:agentId`.
 *
 * Public and unauthenticated - Slack cannot hold our credential - so the HMAC is the entire
 * boundary. The route is deliberately linear and ordered, because every check here is
 * load-bearing:
 *
 *   1. Resolve the agent from the PATH (not the body). Unknown → 404.
 *   2. `url_verification` → echo the challenge. The ONE unverified path (Slack fires it when
 *      the app is CREATED, before we can know its signing secret), narrowed by
 *      `isUrlVerification` so a body carrying an `event` can never take it.
 *   3. Verify the HMAC over the RAW body. Everything after this point is trusted; nothing
 *      before it is.
 *   4. Drop our own bot's events (loop guard) and anything outside the channel allowlist.
 *   5. Invoke, or inject into a live thread.
 *
 * Why the agentId is in the path: at step 2 there is no app-to-agent mapping yet, so the path
 * is the only way to know whose challenge this is. It also means a forged path selects the
 * wrong signing secret and fails step 3 - strictly safer than trusting `api_app_id` from the
 * body to pick the secret that then validates that same body.
 */
import type { Env, Hono } from "hono";
import { slackOf, type AgentConfig, type SlackTrigger } from "@agency/shared";
import { getAgent, updateAgent, type AgentRecord } from "./repo/agents.js";
import { isUrlVerification, verifySlackSignature } from "./slack-verify.js";
import { acknowledgeMention } from "./slack-proxy.js";

/** Slack retries a delivery it considers failed; the header tells us it's a retry. */
const RETRY_HEADER = "x-slack-retry-num";

/** The mention text with the leading `<@Uxxxx>` stripped - what the user actually asked for. */
export function promptFromMention(text: string, botUserId: string | undefined): string {
  const withoutMention = botUserId
    ? text.replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g"), " ")
    : text.replace(/<@[UB][A-Z0-9]+(\|[^>]*)?>/g, " ");
  return withoutMention.replace(/\s+/g, " ").trim();
}

/**
 * A Slack `app_mention` event, narrowed to the fields we use. Slack sends far more; treating
 * the rest as unknown keeps us from depending on shapes we haven't validated.
 */
interface SlackEvent {
  type?: string;
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

export interface SlackCallbackBody {
  type?: string;
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event?: SlackEvent;
  event_id?: string;
}

/**
 * Should this event drive the agent? Split out from the route so the decision is testable
 * without HTTP, and so the reasons are enumerable rather than a chain of early returns.
 */
export type SlackDropReason =
  | "not_an_event_callback"
  | "wrong_event_type"
  | "own_bot_event"
  | "channel_not_allowed"
  | "empty_prompt"
  | "no_timestamp";

export function shouldHandleMention(
  body: SlackCallbackBody,
  trigger: SlackTrigger,
):
  | {
      handle: true;
      prompt: string;
      channel: string;
      threadTs: string;
      messageTs: string;
      slackUser?: string;
    }
  | { handle: false; reason: SlackDropReason } {
  if (body.type !== "event_callback" || !body.event) return { handle: false, reason: "not_an_event_callback" };
  const e = body.event;
  if (e.type !== "app_mention") return { handle: false, reason: "wrong_event_type" };

  // Loop guard: never act on our own bot's messages, or an agent that mentions itself storms
  // the channel. `bot_id` covers any bot; the botUserId check covers OUR bot specifically.
  if (e.bot_id || (trigger.botUserId && e.user === trigger.botUserId)) {
    return { handle: false, reason: "own_bot_event" };
  }

  // The allowlist is a security control, not a filter: an agent with a bash tool that answers
  // anywhere it's invited means anyone who can /invite it can direct it. Empty = nowhere, unless
  // the operator has explicitly opted into answering wherever the bot is invited.
  if (!e.channel || !(trigger.allChannels || trigger.channels.includes(e.channel))) {
    return { handle: false, reason: "channel_not_allowed" };
  }

  const prompt = promptFromMention(e.text ?? "", trigger.botUserId);
  if (!prompt) return { handle: false, reason: "empty_prompt" };

  // A mention with no ts at all can't be replied to OR reacted to, and the session key would be
  // degenerate - drop it rather than start a run that can never answer.
  if (!e.ts) return { handle: false, reason: "no_timestamp" };

  // One THREAD is one session, so the session key is the thread root: a mention that starts a
  // thread has no thread_ts, and its own ts becomes that root (exactly what Slack does when we
  // reply with it). `messageTs` is separately the message that invoked us - for a mention INSIDE
  // a thread those differ, and reacting to the thread root would decorate someone else's older
  // message instead of the one that called us.
  return {
    handle: true,
    prompt,
    channel: e.channel,
    threadTs: e.thread_ts ?? e.ts,
    messageTs: e.ts,
    ...(e.user ? { slackUser: e.user } : {}),
  };
}

/** Slack app ids are `A` + uppercase alphanumerics. Shape-checked before it reaches the record. */
function isSlackAppId(value: unknown): value is string {
  return typeof value === "string" && /^A[A-Z0-9]{2,30}$/.test(value);
}

/**
 * Apply a partial update to the config's Slack trigger, leaving every other trigger untouched.
 * The webhook only ever learns things ABOUT the connection (that Slack reached us, which app it
 * is), never the user's choices - so it must never rewrite the whole trigger.
 */
function withSlackPatch(config: AgentConfig, patch: Partial<SlackTrigger>): AgentConfig {
  return {
    ...config,
    triggers: config.triggers.map((t) => (t.type === "slack" ? { ...t, ...patch } : t)),
  };
}

export interface SlackRouteDeps {
  /**
   * Start a run, or inject into the live session for this thread. Returns the sessionId. The
   * route stays free of invoke mechanics so it can be read as a security boundary.
   */
  dispatch(args: {
    record: AgentRecord;
    prompt: string;
    sessionId: string;
    channel: string;
    threadTs: string;
    /** The ts of the message that invoked the agent - the correct reaction target. */
    messageTs: string;
    /** Who mentioned the agent, so the turn can name them. */
    slackUser?: string;
  }): Promise<void>;
  /** Unix seconds; injectable for tests. */
  nowSeconds?(): number;
}

/**
 * Slack's session id for a thread. `thread_ts` is stable for the life of a thread, which makes
 * it a natural conversation key - and because our invoke path hashes (agentId, sessionId) into
 * the runtime-facing id, two agents in one thread still can't collide on a microVM.
 *
 * The id is kept **AgentCore-compliant** (`[a-zA-Z0-9_-]{33,100}`, see session-id.ts) even
 * though the webhook doesn't go through `isValidSessionId`: Slack's `thread_ts` contains a DOT
 * and a short channel id would fall under the 33-char floor, so a raw join would produce ids
 * the platform's own validator rejects. They'd work today (the runtime-facing id is a hash, and
 * the poll route doesn't validate) and break the day anything downstream starts validating -
 * which is exactly the kind of latent trap that is cheap to avoid and expensive to diagnose.
 *
 * The dot becomes `_` (a Slack ts has exactly one, so it round-trips). Any padding needed to
 * clear the 33-char floor goes in the PREFIX, never near a ts - padding the tail would be
 * indistinguishable from a ts that genuinely ends in zeros.
 */
export function slackSessionId(channel: string, threadTs: string): string {
  const tail = `${channel}-${threadTs.replace(".", "_")}`;
  const prefix = "slack".padEnd(Math.max(5, 33 - 1 - tail.length), "0");
  return `${prefix}-${tail}`;
}

export function mountSlackRoutes<E extends Env>(app: Hono<E>, deps: SlackRouteDeps): void {
  const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  app.post("/webhooks/slack/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    // Read the RAW body: the signature covers the exact bytes, so re-serializing the parsed
    // JSON would break verification.
    const rawBody = await c.req.text();

    const record = await getAgent(agentId);
    const trigger = record ? slackOf(record.config) : undefined;
    // A 404 for an unknown or non-Slack agent. Path ids aren't secrets, and the HMAC - not
    // this lookup - is the boundary; this just avoids doing work for nothing.
    if (!record || !trigger) return c.json({ error: "not found" }, 404);

    let body: SlackCallbackBody | null = null;
    try {
      body = JSON.parse(rawBody) as SlackCallbackBody;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    // The one unverified path. Safe: the reply echoes only what the caller sent and starts no
    // work. `isUrlVerification` refuses any body that also carries an `event`, so this cannot
    // become a way to reach the invoke path unsigned.
    if (isUrlVerification(body)) {
      // Record the handshake so the UI can show "Slack reached us" without the user acting.
      if (!trigger.urlVerified) {
        await updateAgent(record.id, {
          config: withSlackPatch(record.config, { urlVerified: true }),
        });
      }
      return c.text(body.challenge);
    }

    const verdict = verifySlackSignature({
      rawBody,
      timestamp: c.req.header("x-slack-request-timestamp"),
      signature: c.req.header("x-slack-signature"),
      signingSecret: record.slackSecrets?.signingSecret ?? "",
      nowSeconds: now(),
    });
    if (!verdict.ok) {
      // LOG the reason as well as returning it. Slack discards our response body, so a reason only
      // in the body is a reason nobody ever reads - and `bad_signature` vs `stale_timestamp` is
      // exactly the distinction that separates "wrong signing secret" from "clock skew". Not
      // logging it cost an afternoon of guessing at a 401.
      console.warn("slack request unverified", record.id, verdict.reason);
      return c.json({ error: "unverified", reason: verdict.reason }, 401);
    }

    // Learn the app id from the first verified callback. It only reaches us on the payload, and
    // recording it makes the UI's "open the app's settings" link land on the right app instead of
    // Slack's app index. Only after verification: an unverified body must never write anything.
    if (!trigger.appId && isSlackAppId(body.api_app_id)) {
      await updateAgent(record.id, {
        config: withSlackPatch(record.config, { appId: body.api_app_id }),
      });
    }

    // A retry means our previous 200 didn't land, but the run may well have started. Acking
    // without re-dispatching is the safe side of that trade: a duplicate run would double-post
    // to the thread and double-bill.
    if (c.req.header(RETRY_HEADER)) return c.body(null, 200);

    const decision = shouldHandleMention(body, trigger);
    if (!decision.handle) {
      // 200, not an error: Slack retries non-2xx, and a deliberate drop is not a failure. Logged
      // because a silent drop makes "I mentioned it and nothing happened" undebuggable - this is
      // the first thing to look for in CloudWatch when a mention does nothing.
      console.log("slack event dropped", record.id, decision.reason, body.event?.channel ?? "-");
      return c.json({ ok: true, dropped: decision.reason });
    }

    const sessionId = slackSessionId(decision.channel, decision.threadTs);

    // 👀 FIRST, before the run. This is the whole difference between "it heard me" and "it's
    // broken" in the seconds before the agent produces anything, and it costs one Slack call.
    // Awaited (not fire-and-forget) because a Lambda freezes on response - the same trap that
    // silently dropped the dispatch - but its failure never blocks the run.
    const botToken = record.slackSecrets?.botToken;
    if (botToken) {
      await acknowledgeMention(botToken, decision.channel, decision.messageTs).catch(() => {});
    }
    // AWAIT the dispatch. This ran as fire-and-forget and silently did nothing in prod: a Lambda
    // freezes the moment it returns its response, so the pending promise was killed before the
    // invoke completed - the webhook 200'd in 2ms and no run ever started. Awaiting is safe
    // within Slack's 3s budget because invoking is itself an async handoff (the runtime acks
    // immediately and streams telemetry separately), which is exactly what the API invoke route
    // does at routes.ts.
    try {
      await deps.dispatch({
        record,
        prompt: decision.prompt,
        sessionId,
        channel: decision.channel,
        threadTs: decision.threadTs,
        messageTs: decision.messageTs,
        slackUser: decision.slackUser,
      });
    } catch (e) {
      // Still 200: Slack would retry a non-2xx into the same failure, and the retry path acks
      // without re-dispatching anyway. Log it - this is the only record that the mention arrived
      // and failed, since a failed dispatch may never have written a trajectory event.
      console.error("slack dispatch failed", record.id, sessionId, e);
    }
    return c.body(null, 200);
  });
}
