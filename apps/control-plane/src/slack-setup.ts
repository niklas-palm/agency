/**
 * The Slack setup API - what the UI drives.
 *
 * Setup is a resumable state machine, not a wizard, because the user must leave to click
 * Install in Slack and may come back much later (or never). Every state is DERIVED from the
 * trigger + whether the secrets exist, never stored, so it cannot go stale and a half-finished
 * setup resumes exactly where it left off.
 *
 * Two of these calls are what make the setup feel managed rather than hopeful:
 *   - `auth.test` reports what Slack ACTUALLY granted (and which workspace), not what our
 *     manifest asked for. Config drift between the two is invisible otherwise.
 *   - `conversations.info` validates a channel against the workspace actually installed into.
 *     Channel ids are workspace-scoped, and a mismatch presents as the agent silently
 *     ignoring every mention - the single most confusing failure mode there is.
 */
import { slackOf, type SlackSetupState, type SlackTrigger } from "@agency/shared";
import type { AgentRecord } from "./repo/agents.js";

const SLACK_API = "https://slack.com/api";
const TIMEOUT_MS = 10_000;

/**
 * Where setup has got to. Ordered: each state implies the previous ones are done.
 *
 * `live` requires a channel, because an agent with no allowed channel answers nowhere - it
 * would look connected and do nothing, which is exactly the state we want to be loud about.
 */
export function slackSetupState(record: AgentRecord): SlackSetupState | null {
  const t = slackOf(record.config);
  if (!t) return null;
  if (!record.slackSecrets?.botToken) return t.urlVerified ? "url_verified" : "manifest_ready";
  if (!t.teamId) return "needs_bot_token";
  return t.channels.length ? "live" : "verified";
}

export interface SlackAuthTestResult {
  ok: true;
  teamId: string;
  teamName: string;
  botUserId: string;
  /** What Slack actually granted - from the `x-oauth-scopes` response header. */
  grantedScopes: string[];
}

export type SlackSetupError = { ok: false; error: string; hint: string };

/**
 * Verify a bot token and learn the workspace it belongs to.
 *
 * The granted scopes come from a response HEADER, not the body - which is why this can't be a
 * generic "call Slack" helper.
 */
export async function slackAuthTest(botToken: string): Promise<SlackAuthTestResult | SlackSetupError> {
  let res: Response;
  try {
    res = await fetch(`${SLACK_API}/auth.test`, {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "could not reach Slack", hint: "Transient - try again." };
  }
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; error?: string; team_id?: string; team?: string; user_id?: string }
    | null;
  if (!body?.ok) {
    const err = body?.error ?? `http ${res.status}`;
    return {
      ok: false,
      error: `Slack rejected the token: ${err}`,
      hint:
        err === "invalid_auth" || err === "not_authed"
          ? "Copy the Bot User OAuth Token (starts xoxb-) from OAuth & Permissions after installing."
          : "Check the app is installed to your workspace, then paste the token again.",
    };
  }
  if (!body.team_id || !body.user_id) {
    return { ok: false, error: "Slack's reply was missing the workspace id", hint: "Try again." };
  }
  const granted = (res.headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    ok: true,
    teamId: body.team_id,
    teamName: body.team ?? body.team_id,
    botUserId: body.user_id,
    grantedScopes: granted,
  };
}

export interface SlackChannelInfo {
  id: string;
  name: string;
  isPrivate: boolean;
}

/**
 * Confirm a channel exists in the workspace this token belongs to, and return its name.
 *
 * The `teamId` check is the point: a channel id from ANOTHER workspace can be well-formed and
 * even exist there. Accepting it would produce an agent that starts fine and then silently
 * ignores every mention, because the webhook drops the event before doing anything.
 */
export async function slackChannelInfo(
  botToken: string,
  channelId: string,
  expectedTeamId: string,
): Promise<SlackChannelInfo | SlackSetupError> {
  let res: Response;
  try {
    res = await fetch(`${SLACK_API}/conversations.info?channel=${encodeURIComponent(channelId)}`, {
      headers: { authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "could not reach Slack", hint: "Transient - try again." };
  }
  const body = (await res.json().catch(() => null)) as
    | {
        ok?: boolean;
        error?: string;
        channel?: { id?: string; name?: string; is_private?: boolean; context_team_id?: string };
      }
    | null;
  const ch = body?.ok ? body.channel : undefined;
  const id = ch?.id;
  if (!id) {
    const err = body?.error ?? `http ${res.status}`;
    return {
      ok: false,
      error: `Slack couldn't resolve that channel: ${err}`,
      hint:
        err === "channel_not_found"
          ? "The id must be a channel in the workspace you installed into, and the app must be able to see it. For a private channel, invite the app first."
          : "Check the channel id.",
    };
  }
  // `context_team_id` is present on the modern payload; when absent we can't cross-check here,
  // and the token itself already scopes us to one workspace, so don't invent a failure.
  if (ch.context_team_id && ch.context_team_id !== expectedTeamId) {
    return {
      ok: false,
      error: "that channel is in a different workspace",
      hint: "Channel ids are workspace-specific. Copy the id from the workspace you installed the app into.",
    };
  }
  return { id, name: ch.name ?? id, isPrivate: Boolean(ch.is_private) };
}

/** Apply verified workspace details to the Slack trigger, leaving other triggers untouched. */
export function withSlackVerification(
  trigger: SlackTrigger,
  auth: SlackAuthTestResult,
): SlackTrigger {
  return {
    ...trigger,
    teamId: auth.teamId,
    teamName: auth.teamName,
    botUserId: auth.botUserId,
    grantedScopes: auth.grantedScopes,
  };
}
