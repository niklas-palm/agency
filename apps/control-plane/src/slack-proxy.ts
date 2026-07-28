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

/** Reactions the agent may set, and what each means. A closed set keeps the protocol legible. */
export const SLACK_STATUS_EMOJI = {
  working: "hourglass_flowing_sand",
  done: "white_check_mark",
  failed: "x",
  needs_input: "question",
} as const;

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
  action: "reply" | "set_status";
  /** For `reply`: the message text. */
  text?: string;
  /** For `set_status`: which status reaction to set. */
  status?: SlackStatus;
}

export type SlackCallResult = { ok: true; ts?: string } | { error: string; hint: string };

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
  if (!trigger.channels.includes(target.channel)) {
    return {
      error: "this channel is no longer allowed",
      hint: "The agent's Slack channel allowlist no longer includes this channel.",
    };
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
  return post("reactions.add", botToken, {
    channel: target.channel,
    timestamp: replyToTs || target.threadTs,
    name,
  });
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
