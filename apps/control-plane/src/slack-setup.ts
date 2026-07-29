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
  // allChannels means the agent WILL answer somewhere, so it's live without an explicit list.
  return t.allChannels || t.channels.length ? "live" : "verified";
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
  /** Whether the bot is in the channel. Slack delivers a mention ONLY to an app that is. */
  isMember?: boolean;
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

/**
 * The channels the bot can see, for the picker.
 *
 * `conversations.list` needs `channels:read`/`groups:read` - the same scopes
 * `conversations.info` needs, so the picker costs no extra permission and no re-install.
 *
 * `exclude_archived` because an archived channel can't receive a mention, and a single page of
 * 200 (Slack's practical default) rather than paging: a picker is for choosing among the
 * channels you actually work in, and a workspace with more than that is better served by
 * pasting an id. The reply says whether it was truncated so the UI can say so honestly rather
 * than silently showing a subset.
 */
export async function slackChannelList(
  botToken: string,
): Promise<{ channels: SlackChannelInfo[]; truncated: boolean } | SlackSetupError> {
  const params = new URLSearchParams({
    limit: "200",
    exclude_archived: "true",
    types: "public_channel,private_channel",
  });
  let res: Response;
  try {
    res = await fetch(`${SLACK_API}/conversations.list?${params}`, {
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
        channels?: Array<{ id?: string; name?: string; is_private?: boolean; is_member?: boolean }>;
        response_metadata?: { next_cursor?: string };
      }
    | null;
  if (!body?.ok) {
    const err = body?.error ?? `http ${res.status}`;
    return {
      ok: false,
      error: `Slack couldn't list channels: ${err}`,
      hint:
        err === "missing_scope"
          ? "The app needs channels:read and groups:read - re-install it with the current manifest."
          : "You can still paste a channel id directly.",
    };
  }
  const channels = (body.channels ?? [])
    .filter((c): c is { id: string; name?: string; is_private?: boolean; is_member?: boolean } =>
      typeof c.id === "string",
    )
    .map((c) => ({
      id: c.id,
      name: c.name ?? c.id,
      isPrivate: Boolean(c.is_private),
      // Slack only delivers app_mention to an app that's IN the conversation, so this is the
      // difference between a channel that will work and one that looks configured and won't.
      isMember: Boolean(c.is_member),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { channels, truncated: Boolean(body.response_metadata?.next_cursor) };
}

/**
 * Scopes without which the feature is broken rather than degraded.
 *
 * `app_mentions:read` is the load-bearing one: Slack will not DELIVER `app_mention` without it, so
 * the agent is unreachable and nothing is logged anywhere - the webhook is never called. The other
 * two are what the platform itself does on every run (👀 + status circles, and posting the answer),
 * so an agent missing them looks connected and produces silence.
 *
 * Everything else degrades honestly: no `*:history` means `slack_read_thread` fails with a hint the
 * agent can relay, no `files:*` means uploads fail the same way. Those we let through.
 */
const REQUIRED_SCOPES = ["app_mentions:read", "chat:write", "reactions:write"] as const;

/**
 * Which required scopes are missing from what Slack actually granted.
 *
 * This exists because the whole class of failure in this feature has been "the manifest was right,
 * the token wasn't". A token predating a manifest change, or pasted from an older app of the same
 * name, carries the OLD scopes - and Slack neither warns nor errors. We asked `auth.test` what was
 * granted, stored it, showed it in the UI, and then made no decision with it, so setup reported
 * "live" for an agent that could never receive a mention.
 */
export function missingRequiredScopes(granted: string[]): string[] {
  return REQUIRED_SCOPES.filter((s) => !granted.includes(s));
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
