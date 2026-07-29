/**
 * The Slack proxy: how an agent talks back to Slack WITHOUT holding the bot token.
 *
 * Same shape as the integrations proxy, and for the same reason - the platform's load-bearing
 * property is that a compromised microVM has no credential to steal. `run_bash` can read
 * `/proc/1/environ`, so keeping the token out of the runtime's env isn't a nicety.
 *
 * The capability scoping here is unusually tight, and it falls out of the session id rather
 * than being enforced by a check: the agent's per-session token carries `sessionId`, and a
 * Slack session id IS `slack-<channel>-<threadTs>`. So the target channel and thread are
 * *derived from the token*, and the agent has no parameter with which to name a different
 * one. A prompt-injected agent cannot post to another channel, because there is no argument
 * for it to poison.
 */
import { slackOf } from "@agency/shared";
import { getAgent } from "./repo/agents.js";

/** Slack's Web API origin. Fixed - this is not a tenant-supplied URL, so no SSRF surface. */
const SLACK_API = "https://slack.com/api";

/** Outer deadline for a Slack call. Slack is normally fast; a hang would hold an agent turn. */
const SLACK_TIMEOUT_MS = 10_000;

/** Messages returned by `read_thread`. Enough for context; not enough to flood the model. */
const THREAD_LIMIT = 50;

/**
 * The status reactions, and what each means.
 *
 * MUTUALLY EXCLUSIVE: setting one removes the others, so the message carries exactly one status
 * rather than accumulating a history of them. Matched to the sibling slack-dev agent's protocol so
 * the two read identically in a workspace that runs both.
 *
 * 👀 is separate and is added by the WEBHOOK on receipt, before the agent starts - see
 * `acknowledgeMention`. It answers "did it hear me?", which is the question a user has in the two
 * seconds before anything else happens, and it's the difference between a bot that feels alive and
 * one that looks broken.
 */
export const SLACK_STATUS_EMOJI = {
  working: "large_yellow_circle",
  done: "large_green_circle",
  failed: "red_circle",
  needs_input: "question",
} as const;

/** 👀, added the moment a mention arrives. Not a status - it never gets cleared. */
export const SLACK_ACK_EMOJI = "eyes";

export type SlackStatus = keyof typeof SLACK_STATUS_EMOJI;

/** Parse `slack-<channel>-<threadTs>` back into its parts. Returns null if not a Slack session. */
export function parseSlackSessionId(sessionId: string): { channel: string; threadTs: string } | null {
  // The prefix is `slack`, possibly zero-padded to clear the session-id length floor.
  if (!/^slack0*-/.test(sessionId)) return null;
  // Strip the (possibly zero-padded) prefix up to the first `-`; see slackSessionId.
  const rest = sessionId.slice(sessionId.indexOf("-") + 1);
  // The channel id contains no `-`; the thread ts is `1234567890_123456` (the dot is encoded as
  // `_` to keep the id AgentCore-compliant - see slackSessionId). Split on the FIRST `-` so a ts
  // containing anything unexpected lands in threadTs rather than truncating the channel.
  const dash = rest.indexOf("-");
  if (dash <= 0) return null;
  const channel = rest.slice(0, dash);
  const threadTs = rest.slice(dash + 1).replace("_", ".");
  if (!threadTs) return null;
  return { channel, threadTs };
}

export interface SlackCallRequest {
  action: "reply" | "set_status" | "read_thread";
  /** For `reply`: the message text. */
  text?: string;
  /** For `set_status`: which status reaction to set. */
  status?: SlackStatus;
}

export type SlackCallResult =
  | {
      ok: true;
      ts?: string;
      messages?: Array<{ user: string; text: string; ts: string }>;
      truncated?: boolean;
    }
  | { error: string; hint: string };

/**
 * Execute a Slack action on behalf of an agent, for the thread its session is bound to.
 *
 * `agentId` and `sessionId` come from the VERIFIED session token, never from the request body -
 * so this function cannot be aimed at another agent or another thread.
 */
export async function callSlack(
  agentId: string,
  sessionId: string,
  req: SlackCallRequest,
  /**
   * The ts of the message that invoked the agent, from the VERIFIED token. Reactions target this,
   * not the thread root: for a mention inside a thread the root is someone else's older message.
   * Absent on a run minted before this claim existed - then the root is the best we know.
   */
  replyToTs?: string,
): Promise<SlackCallResult> {
  const target = parseSlackSessionId(sessionId);
  if (!target) {
    return {
      error: "not a Slack session",
      hint: "Slack tools only work on a run started by a Slack mention.",
    };
  }

  const record = await getAgent(agentId);
  const trigger = record ? slackOf(record.config) : undefined;
  const botToken = record?.slackSecrets?.botToken;
  if (!record || !trigger || !botToken) {
    return {
      error: "Slack is not configured for this agent",
      hint: "Finish the Slack setup on the agent's Integrate tab.",
    };
  }

  // Defence in depth: the channel came from the token, but if the allowlist has since changed
  // (the user removed a channel while a thread was live) honour the new list.
  if (!trigger.allChannels && !trigger.channels.includes(target.channel)) {
    return {
      error: "this channel is no longer allowed",
      hint: "The agent's Slack channel allowlist no longer includes this channel.",
    };
  }

  if (req.action === "read_thread") {
    // The conversation the agent was called into. Without this it sees only the mention text, so
    // "can you fix this?" three messages deep is unanswerable - the single biggest difference
    // between a bot and something worth @-mentioning.
    return readThread(botToken, target.channel, target.threadTs);
  }

  if (req.action === "reply") {
    const text = (req.text ?? "").trim();
    if (!text) return { error: "text is required", hint: "Pass the message to post." };
    return post("chat.postMessage", botToken, {
      channel: target.channel,
      thread_ts: target.threadTs,
      text,
    });
  }

  const name = SLACK_STATUS_EMOJI[req.status as SlackStatus];
  if (!name) {
    return {
      error: "unknown status",
      hint: `Use one of: ${Object.keys(SLACK_STATUS_EMOJI).join(", ")}.`,
    };
  }
  const timestamp = replyToTs || target.threadTs;
  // Clear the other statuses first, so the message shows one state rather than a pile of them.
  // Concurrently, and failures ignored: a stale reaction that won't budge is cosmetic, and must
  // not stop the new status landing.
  await Promise.all(
    Object.values(SLACK_STATUS_EMOJI)
      .filter((e) => e !== name)
      .map((e) => post("reactions.remove", botToken, { channel: target.channel, timestamp, name: e })),
  );
  return post("reactions.add", botToken, { channel: target.channel, timestamp, name });
}

/**
 * POST to Slack. Slack answers `200 {ok:false,error:"…"}` rather than an HTTP error, so the
 * body - not the status - decides success. Never throws: the caller turns this into a tool
 * result the model can read and adapt to.
 */
async function post(
  method: string,
  botToken: string,
  payload: Record<string, unknown>,
): Promise<SlackCallResult> {
  try {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; ts?: string }
      | null;
    if (!body?.ok) {
      const err = body?.error ?? `http ${res.status}`;
      return { error: `Slack rejected the call: ${err}`, hint: hintFor(err) };
    }
    return { ok: true, ...(body.ts ? { ts: body.ts } : {}) };
  } catch {
    return { error: "could not reach Slack", hint: "Transient - try once more." };
  }
}

/** Turn Slack's terse error codes into something the model (or a human in the trace) can act on. */
function hintFor(err: string): string {
  if (err === "not_in_channel") return "The app must be invited to the channel: /invite @the-bot";
  if (err === "invalid_auth" || err === "token_revoked" || err === "account_inactive") {
    return "The bot token is no longer valid - re-install the app and paste a fresh token.";
  }
  if (err === "missing_scope") return "The app is missing a scope; re-install with the current manifest.";
  if (err === "already_reacted") return "That reaction is already set - nothing to do.";
  if (err === "ratelimited") return "Slack rate-limited us; wait a moment before retrying.";
  return "See Slack's Web API error codes for this value.";
}

/**
 * Read the thread the agent was invoked in, oldest first.
 *
 * Capped: a long thread would blow the model's context and the proxy's response budget for no
 * benefit, and the recent messages are the ones that carry the request. The cap is reported so the
 * agent can say it only saw part of a conversation rather than answering as if it saw all of it.
 */
async function readThread(
  botToken: string,
  channel: string,
  threadTs: string,
): Promise<SlackCallResult> {
  const params = new URLSearchParams({ channel, ts: threadTs, limit: String(THREAD_LIMIT) });
  try {
    const res = await fetch(`${SLACK_API}/conversations.replies?${params}`, {
      headers: { authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; messages?: Array<Record<string, unknown>>; has_more?: boolean }
      | null;
    if (!body?.ok) {
      const err = body?.error ?? `http ${res.status}`;
      return { error: `Slack rejected the read: ${err}`, hint: hintFor(err) };
    }
    const messages = (body.messages ?? []).map((m) => ({
      user: typeof m.user === "string" ? m.user : typeof m.bot_id === "string" ? "bot" : "unknown",
      text: typeof m.text === "string" ? m.text : "",
      ts: typeof m.ts === "string" ? m.ts : "",
    }));
    return { ok: true, messages, ...(body.has_more ? { truncated: true } : {}) };
  } catch {
    return { error: "could not reach Slack", hint: "Transient - try once more." };
  }
}

/**
 * Add 👀 to the message that mentioned us, immediately on receipt.
 *
 * Deliberately best-effort and never awaited by the caller's critical path: it exists so the user
 * sees acknowledgement within a second, and a failure to react must not stop the run. Logged
 * though - "no eyes" is the first symptom worth debugging, because it means the token or the
 * channel membership is wrong.
 */
export async function acknowledgeMention(
  botToken: string,
  channel: string,
  messageTs: string,
): Promise<void> {
  const res = await post("reactions.add", botToken, {
    channel,
    timestamp: messageTs,
    name: SLACK_ACK_EMOJI,
  });
  if ("error" in res) console.warn("slack ack reaction failed", channel, res.error);
}
