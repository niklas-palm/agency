/**
 * Wire types shared across the platform (control-plane API, agent-runtime, web).
 *
 * This package is intentionally dependency-free so it can be bundled into the
 * browser as-is. It is the single source of truth for the shapes that cross
 * process boundaries.
 */

// The model catalog lives in a leaf module (models.ts) so `openapi.ts` can read
// MODEL_KEYS without importing `index.ts` - which re-exports openapi.ts, and the
// resulting cycle once crashed the control-plane Lambda at init. Re-exported here
// so consumers keep importing everything from `@agency/shared`; also imported for
// this file's own use (e.g. `ModelKey` in AgentConfig below).
import type { ModelKey, TokenUsage } from "./models.js";
export { MODELS, MODEL_KEYS, MODEL_INFO, MODEL_PRICING, costFor, tokenTotal, zeroTokens, isModelAllowedInNetworkMode } from "./models.js";
export type { ModelKey, ModelProvider, ModelFamily, ModelInfo, ModelPrice, TokenUsage } from "./models.js";

// Authorization scopes - another leaf module (see scopes.ts), re-exported so
// consumers import them from `@agency/shared` alongside everything else.
import type { Scope } from "./scopes.js";
export { SCOPES, ALL_SCOPES, DEFAULT_SCOPES, isScope } from "./scopes.js";
export type { Scope } from "./scopes.js";
export { ROLES, ALL_ROLES, isRole, scopesForRole } from "./org.js";
// The SSRF policy table (a plain address list, no node APIs) - imported by BOTH
// outbound guards' tests so they can't assert different policies. See ssrf-policy.ts.
export { BLOCKED_ADDRESSES, ALLOWED_ADDRESSES } from "./ssrf-policy.js";
export {
  SLACK_BOT_SCOPES,
  slackAppName,
  slackBotName,
  slackNameProblem,
  slackRequestUrl,
  slackManifest,
} from "./slack-manifest.js";
export type { SlackManifestInput } from "./slack-manifest.js";
export type { Role, Org, Membership, OrgMembership, Member, Invite, Me } from "./org.js";

/**
 * What can trigger an agent. A discriminated union so new managed triggers
 * (Slack, GitHub, …) slot in as new members without reshaping config. An agent
 * carries a *list* of triggers and can have several at once.
 *
 * - `api`      - invocable via the agent's API key. Always present; the baseline.
 * - `schedule` - a recurring cron/rate that fires the agent unattended. `expression`
 *   is an EventBridge Scheduler schedule expression (`cron(...)` or `rate(...)`);
 *   `prompt` is the message delivered on each tick; `timezone` is an IANA zone.
 *
 * Future members will follow the same shape: `{ type, …provider fields, prompt? }`.
 */
export type TriggerType = "api" | "schedule" | "slack";

export interface ApiTrigger {
  type: "api";
}

export interface ScheduleTrigger {
  type: "schedule";
  /** EventBridge Scheduler expression, e.g. `rate(1 hour)` or `cron(0 9 * * ? *)`. */
  expression: string;
  /** IANA timezone the cron is evaluated in (default `UTC`). */
  timezone?: string;
  /** The prompt delivered to the agent on each scheduled tick. */
  prompt: string;
}

/**
 * Slack: the agent is invoked when someone @-mentions its bot in an allowed channel.
 *
 * ONE Slack app per agent, because the app IS the agent's identity in Slack - its name,
 * avatar and bot user are what people @-mention. The user creates it by pasting a manifest
 * we generate (see `slackManifest`), so we never hold a Slack app-configuration token: that
 * credential could reshape any app in their workspace, and its single-use/12h rotation
 * semantics need a retrying agent to survive, not a self-service form.
 *
 * `appId` is the routing key we care about operationally, but the webhook URL carries the
 * agentId in its path instead - at `url_verification` time (which Slack fires when the app
 * is CREATED, before any install) we don't yet know the appId, so the path is the only way
 * to know which agent a challenge belongs to.
 *
 * The two secrets (signing secret, bot token) live on the agent record, never here.
 */
export interface SlackTrigger {
  type: "slack";
  /** Slack's app id (`A…`), recorded once the app exists. Absent until then. */
  appId?: string;
  /** Slack's workspace id (`T…`), learned from `auth.test` after the bot token lands. */
  teamId?: string;
  /** The workspace name, for display only - so the UI can say WHICH workspace is connected. */
  teamName?: string;
  /** Our bot's user id (`U…`), from `auth.test`. Used to drop the bot's own events (loop guard). */
  botUserId?: string;
  /**
   * Channel ids (`C…`/`G…`) the agent will answer in. Empty = answer nowhere (fail closed),
   * unless `allChannels` is set.
   */
  /**
   * What the bot is called in Slack, if it should differ from the agent's name.
   *
   * The agent's name is a sensible default but not the same thing: the agent name is for the
   * roster, this is the handle people type after `@`. Slack constrains a handle far more
   * (`a-z 0-9 - _ .`, no spaces or capitals) and reserves anything starting `slack`, so a good
   * agent name is often a poor handle - the deployer has to be able to say so.
   *
   * Set before the app is created and not meaningfully changeable after: Slack fixes the handle at
   * app-creation time, so editing this later only makes our manifest disagree with the live app.
   */
  botName?: string;
  channels: string[];
  /**
   * Answer in ANY channel the bot is invited to, ignoring `channels`.
   *
   * The allowlist exists because anyone who can `/invite` the bot can direct the agent, so this
   * deliberately hands that gate to whoever can invite. It's the right choice for a private
   * workspace or a low-privilege agent, and the wrong one for an agent with powerful
   * integrations - which is why it's opt-in and labelled rather than the default.
   */
  allChannels?: boolean;
  /** Scopes Slack actually GRANTED, read from `auth.test`'s `x-oauth-scopes`. Display only. */
  grantedScopes?: string[];
  /** True once Slack's `url_verification` challenge has been answered for this agent. */
  urlVerified?: boolean;
}

export type Trigger = ApiTrigger | ScheduleTrigger | SlackTrigger;

/** The Slack trigger on a config, if any. */
export function slackOf(config: AgentConfig): SlackTrigger | undefined {
  return config.triggers.find((t): t is SlackTrigger => t.type === "slack");
}

/**
 * Where a Slack setup has got to. Derived from the trigger + whether the secrets exist,
 * never stored - so it can't go stale, and a user who abandons setup halfway resumes
 * exactly where they left off.
 */
export type SlackSetupState =
  | "manifest_ready"
  | "url_verified"
  | "needs_bot_token"
  | "verified"
  | "live";

/**
 * The creator-controlled configuration of an agent. Stored verbatim in the
 * agents table and sent to the agent-runtime in each invoke payload, so a change
 * here takes effect on the agent's next invoke with no redeploy.
 */
export interface AgentConfig {
  /** Human-readable name. Also used to derive the AgentCore runtime name. */
  name: string;
  /** The creator's system prompt - appended to the platform "harness" base prompt. */
  systemPrompt: string;
  /** Which model the agent runs on. */
  model: ModelKey;
  /** Whether the base coding toolset (read/write/edit/bash/...) is available. */
  baseTools: boolean;
  /** Whether the built-in web search tool is available (requires network). */
  webSearch: boolean;
  /**
   * Whether the agent's web tools (search + fetch) are wired. Requires public
   * egress, so it's only meaningful in `networkMode: "public"` - forced off in
   * isolated mode (there's no internet for them to reach).
   */
  networkAccess: boolean;
  /**
   * Which shared runtime backs this agent, and therefore its network posture:
   * - `"public"` (default): runs on the public runtime with outbound internet.
   * - `"isolated"`: runs on a VPC runtime with NO public egress. The only path
   *   out is a private (PrivateLink) connection to bedrock-runtime for model
   *   inference, so **only Anthropic models work** - OpenAI runs via Bedrock
   *   Mantle, which is us-east-1-only with no cross-region PrivateLink, and
   *   `isModelAllowedInNetworkMode` rejects that combination at config time. Web
   *   search + fetch are unavailable (no internet), and `run_bash` cannot reach
   *   the internet either - isolation is enforced at the network, not just by
   *   un-wiring tools. Absent means `"public"`.
   */
  networkMode?: "public" | "isolated";
  /** What can trigger the agent. Always includes an `api` trigger. */
  triggers: Trigger[];
  /**
   * Ids of skills attached to this agent (see `Skill`). Versioned: attaching or
   * detaching a skill is a behavior change. The skill *content* is not copied
   * here - it's resolved from the skills table at invoke time - so editing a
   * skill's content flows to every agent using it on the next session without
   * bumping any agent version. Absent/empty means no skills.
   */
  skillIds?: string[];
  /**
   * Per-agent environment variables (key → value), injected into the runtime so
   * the agent's tools (e.g. bash) can read them and the model is told which keys
   * exist. For things like third-party API keys. Absent/empty means none.
   */
  env?: Record<string, string>;
  /**
   * Ids of integrations attached to this agent (see `Integration`). Versioned,
   * like `skillIds`: attaching/detaching an integration is a behavior change.
   * The credential is NEVER copied here (or anywhere the agent can read) - the
   * agent calls the control-plane integrations proxy, which holds the secret and
   * authorizes the call against these ids (carried in the per-session token).
   * Absent/empty means no integrations.
   */
  integrationIds?: string[];
}

/** The single schedule trigger, if the agent has one (at most one is allowed). */
export function scheduleOf(config: AgentConfig): ScheduleTrigger | undefined {
  return config.triggers.find((t): t is ScheduleTrigger => t.type === "schedule");
}

/** Operational counters surfaced on the agent list/detail. */
/**
 * The counters kept ON the agent record. Deliberately minimal: only what the
 * invoke path can cheaply increment. Error counts, durations, token usage and
 * cost come from the per-session summaries instead (`GET /agents/:id/metrics`,
 * see MetricsSummary) - the runtime writes those, and they carry the version +
 * model context these flat counters never could. `errors`/`lastRuntimeMs` used to
 * live here but nothing ever wrote them, so they reported a permanent zero.
 */
export interface AgentMetrics {
  invocations: number;
  /** ISO timestamp of the last invocation, or null if never invoked. */
  lastInvokedAt: string | null;
}

/** An agent as returned by the control-plane API (never includes the API key). */
export interface Agent {
  id: string;
  /** The org this agent lives in. */
  orgId: string;
  /** userId of the creator - drives attribution + the shared/private visibility rule. */
  createdBy: string;
  /** true = visible to the whole org; false = visible only to its creator. */
  shared: boolean;
  /**
   * Additional org members (userIds) who may manage (edit/delete) this resource,
   * beyond the creator + org admins (who always can). A grant, never a lock-out.
   * Absent/empty means "creator + admins only". See docs/auth.md.
   */
  managers?: string[];
  config: AgentConfig;
  /**
   * The agent's invoke key, in plaintext, for callers who may WRITE this agent.
   *
   * A deliberate, documented trade: the platform's own DX is the priority here. There is one key
   * per agent and a deployment has many agents, so a key you can only see once means re-pasting
   * a different secret for every agent, on every browser - which in practice means people keep
   * them in worse places than we would. Prefilling the Run tab and the integration samples is
   * what makes an agent testable in one click.
   *
   * Two things bound it: it is returned ONLY to a principal who can already write the agent
   * (a viewer of a shared agent gets it redacted, exactly like `config.env` values), and it
   * authorizes invoking THIS one agent - nothing else. See SECURITY.md.
   */
  apiKey?: string;
  /**
   * A short human description shown on the roster. NOT part of the config, so
   * editing it does not create a new version - it's metadata about the agent,
   * not behavior. Optional.
   */
  description?: string;
  /**
   * The current config version (monotonic, starts at 1). Every config change
   * appends a new version and bumps this; invokes always run the latest. The
   * prior config is retained as a version so it can be inspected or restored.
   */
  version: number;
  /** The URL clients POST to in order to trigger this agent. */
  invokeUrl: string;
  createdAt: string;
  updatedAt: string;
  metrics: AgentMetrics;
}

/**
 * One immutable config snapshot in an agent's history. Appended on every config
 * change (and on create as version 1). `note` records how it came to be, e.g.
 * "restored from v2".
 */
export interface AgentVersion {
  agentId: string;
  version: number;
  config: AgentConfig;
  createdAt: string;
  note?: string;
}

/** Request body for creating an agent. The config, plus non-versioned metadata
 *  read off the raw body: `description` and `shared` (default true). */
export type CreateAgentRequest = AgentConfig & {
  description?: string;
  shared?: boolean;
  managers?: string[];
};

/** Request body for updating an agent (partial config + optional metadata). */
export type UpdateAgentRequest = Partial<AgentConfig> & { description?: string; shared?: boolean; managers?: string[] };

/**
 * Response to creating an agent. The API key is returned exactly once, here,
 * and is never retrievable again (only rotatable).
 */
export interface CreateAgentResponse {
  agent: Agent;
  apiKey: string;
}

/** Response to rotating an agent's API key. */
export interface RotateKeyResponse {
  apiKey: string;
}

/** Request body for invoking an agent. */
export interface InvokeRequest {
  /**
   * Optional session id. If omitted, the server generates a compliant one. If
   * provided, it must match `[a-zA-Z0-9_-]{33,100}` (AgentCore's rule) - the
   * server rejects non-compliant ids rather than coercing them (coercion could
   * merge distinct conversations onto one session).
   */
  sessionId?: string;
  /** The message/prompt for the agent. */
  prompt: string;
}

/** Outcome of an invoke, shared by the runtime ack and the API response. */
export type InvokeStatus = "triggered" | "injected" | "rejected";

/**
 * Response to an invoke. Returns immediately (the agent works async).
 * - `triggered`: started a fresh turn (session was idle or brand new).
 * - `injected`:  the session was already working, so the message was injected
 *   into the running agent's context mid-turn.
 * - `rejected`:  the session's mailbox is at capacity (flood protection); the
 *   message was not accepted - back off and retry.
 */
export interface InvokeResponse {
  sessionId: string;
  status: InvokeStatus;
}

// The event-type catalog lives in a leaf module (trajectory-types.ts) so
// `openapi.ts` can derive its enum from it without importing this file - same
// reason as models.ts. Re-exported here so `@agency/shared` stays the one import.
export { TRAJECTORY_EVENT_TYPES, type TrajectoryEventType } from "./trajectory-types.js";
import type { TrajectoryEventType } from "./trajectory-types.js";

/** A single logged action in an agent's trajectory. */
export interface TrajectoryEvent {
  /** Monotonic cursor (UUIDv7). Sorts chronologically; used for delta polling. */
  cursor: string;
  type: TrajectoryEventType;
  /** ISO timestamp. */
  ts: string;
  /** Assistant text (type=text) or final answer (type=session_end). */
  content?: string;
  /** Tool name (type=tool_input | tool_result). */
  toolName?: string;
  /** Correlates a tool_input with its tool_result. */
  toolUseId?: string;
  /** Tool input args (type=tool_input). */
  input?: unknown;
  /** Tool result, truncated (type=tool_result). */
  result?: string;
  /** Error message (type=error). */
  error?: string;
}

/**
 * Response to polling a session. `status` reflects whether the agent is
 * currently working. `events` is the delta since the `after` cursor the client
 * passed (or the full trajectory if none). `cursor` is the newest cursor seen -
 * pass it back as `after` on the next poll.
 */
export interface PollResponse {
  sessionId: string;
  status: "working" | "idle";
  events: TrajectoryEvent[];
  cursor: string | null;
}

/**
 * One past run, for the run list under an agent's Monitor tab. A projection of the
 * durable session-summary row (see `SessionSummary`) - just enough to render a row and
 * open it. `runId` identifies the runtime lifetime and is what opens the run's
 * trajectory; `sessionId` is the client-supplied conversation id, which a caller may
 * reuse across runs, so it does NOT identify a run on its own.
 */
export interface AgentRun {
  runId: string;
  sessionId: string;
  /** The config version this run executed. */
  version: number;
  model?: ModelKey;
  startedAt: string;
  endedAt: string;
  /** Whole-lifetime span in ms, including idle gaps between invocations. */
  durationMs: number;
  invocations: number;
  turns: number;
  toolUses: number;
  outcome: SessionSummary["outcome"];
  /** Total tokens across the run (the four billing drivers summed). */
  totalTokens: number;
  /** Dollar cost, priced at the run's own model's rate. */
  costUsd: number;
}

/** Response listing an agent's past runs, newest first. */
export interface AgentRunsResponse {
  runs: AgentRun[];
}

/**
 * One past run's trajectory. Served from the trajectory table while the run is recent
 * and from the S3 archive after the table's 30-day TTL expires it - `archived` says
 * which, so the UI can be honest when a very old run has no events at all.
 */
export interface AgentRunTrace {
  runId: string;
  /** The conversation this run belonged to (may be shared with other runs). */
  sessionId: string;
  events: TrajectoryEvent[];
  archived: boolean;
  /**
   * Set when the run was too large to return whole: `events` holds the oldest that fit.
   * A very long run would otherwise exceed the response size limit and fail outright.
   */
  truncated?: boolean;
}

/**
 * An archived run trace as STORED in the traces bucket (`traces/<agentId>/<runId>.json`).
 *
 * The events are wrapped in a small envelope so the object stands alone: traces are kept
 * forever, long outliving the trajectory rows and potentially the agent record itself, so
 * an object that was just a bare event array couldn't say which agent, config version, or
 * model produced it. Everything here is copied from the run's session summary.
 *
 * The API's `AgentRunTrace` is a separate shape (it also serves live runs); this type is
 * only the on-disk format.
 */
export interface StoredTrace {
  agentId: string;
  runId: string;
  sessionId: string;
  /** The config version this run executed. */
  version: number;
  /** The model it ran on, when the summary recorded one. */
  model?: ModelKey;
  startedAt: string;
  endedAt: string;
  outcome: "ok" | "error";
  /** When this object was written (a run re-archives at each idle point). */
  archivedAt: string;
  events: TrajectoryEvent[];
}

/**
 * The payload the control-plane sends to the agent-runtime's /invocations
 * endpoint (and that the runtime receives via AgentCore). The control-plane
 * loads the agent record on every invoke anyway (to check the API key), so it
 * passes the config here - the runtime needs no DynamoDB read of the agents
 * table (which keeps the runtime's IAM off that table entirely). `agentId` is
 * still included as the trajectory-write key.
 */
export interface RuntimePayload {
  agentId: string;
  config: AgentConfig;
  /** The config version being run, so the runtime can stamp its session summary. */
  version: number;
  /**
   * The agent's skills, resolved from `config.skillIds` at invoke time (name +
   * description + markdown content). Resolved by the control-plane so the runtime
   * needs no skills-table read (keeps the runtime's IAM off that table). Absent
   * or empty when the agent has no skills.
   */
  skills?: ResolvedSkill[];
  /**
   * The agent's integrations, resolved from `config.integrationIds` at invoke
   * time - metadata + the operation manifest ONLY, never the credential. The
   * runtime uses these to tell the model which integrations + operations exist
   * (discovery); the actual call goes through the control-plane proxy, which
   * holds the secret. Absent or empty when the agent has no integrations.
   */
  integrations?: ResolvedIntegration[];
  /**
   * The CLIENT's session id - the one the caller polls and the trajectory is keyed by.
   *
   * Distinct from AgentCore's `context.sessionId`, which is derived from
   * `(agentId, clientSessionId)` so one agent's session can never route into another's
   * microVM (see the control-plane's `runtimeSessionIdFor`). The runtime must report
   * telemetry under THIS id: it's what the ingest capability token is scoped to and what
   * the poll API reads. Absent only on a legacy payload, where the runtime falls back to
   * the AgentCore context id.
   */
  sessionId?: string;
  prompt: string;
  /**
   * A short-lived capability token scoped to this (agentId, sessionId), minted by
   * the control-plane. The runtime sends it as the `X-Agency-Ingest-Token` header
   * on its telemetry POSTs and on integration proxy calls (the same header); the
   * control-plane verifies it + that the body/claims match. The
   * token also carries the granted `integrationIds`, so the proxy authorizes an
   * integration call statelessly (no agents-table read). The runtime holds NO
   * long-lived secret, so a token leaked from the microVM only authorizes the
   * session the agent already is, and only the integrations it was granted.
   */
  ingestToken?: string;
  /**
   * True when this run was started by a Slack mention. The runtime wires its Slack tools and
   * prompt block from this flag alone - the trigger IS the signal, exactly as integration
   * tools are wired from `integrations` being present. Nothing Slack-specific (no channel, no
   * token) needs to reach the runtime: the control-plane derives the reply target from the
   * session id, so the agent has no way to name a different one.
   */
  fromSlack?: boolean;
}

/** A skill as delivered to the runtime: enough to build a Strands `Skill`. */
export interface ResolvedSkill {
  name: string;
  description: string;
  content: string;
}

/** The runtime's immediate response to an invocation. */
export interface RuntimeAck {
  status: InvokeStatus;
  sessionId: string;
}

/**
 * Telemetry the runtime POSTs to the control-plane's internal ingest API instead
 * of writing DynamoDB directly. This keeps the runtime's AWS role off the
 * trajectory/sessions tables (Bedrock-only role) - the agent can't reach DDB even
 * if it steals the role creds via MMDS. Authed by a per-session capability token
 * (see `session-token.ts`), NOT a user credential - the runtime holds no long-lived
 * secret. See docs/runtime.md.
 */

/** One trajectory event as posted to `POST /internal/trajectory`. The runtime
 *  generates the UUIDv7 `cursor` so write-order (delta polling) is preserved. */
export interface TrajectoryEventInput {
  sessionId: string;
  agentId: string;
  cursor: string;
  /**
   * The runtime lifetime (run) this event belongs to. A client may reuse one
   * sessionId across runs, and every run writes into the SAME trajectory partition -
   * so without this a run's events can't be told apart from its neighbour's.
   * Absent on the control-plane-written `prompt` event (which is recorded before the
   * runtime has minted a runId) and on events predating run history.
   */
  runId?: string;
  type: TrajectoryEventType;
  content?: string;
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
  result?: string;
  error?: string;
}

/** A session summary as posted to `POST /internal/session-summary` (upsert by
 *  agentId+runId). Reuses SessionSummary + the runId sort key. */
export type SessionSummaryInput = SessionSummary & { runId: string };

/**
 * A Personal Access Token as returned by the API (never includes the secret).
 * Users mint these to let a coding assistant call the management API on their
 * behalf, non-interactively. Each carries a scope subset (see `Scope`).
 */
export interface AccessToken {
  id: string;
  /** userId of the token owner (a PAT belongs to a person, not an org). */
  ownerId: string;
  /** The org this token acts within (chosen at mint; must be one the owner is in).
   *  Effective authority = the token's scopes ∩ the owner's role in this org. */
  orgId: string;
  /** A human label so the user can tell tokens apart ("my-assistant"). */
  name: string;
  scopes: Scope[];
  createdAt: string;
  /** ISO timestamp of the last time this token authenticated, or null if unused. */
  lastUsedAt: string | null;
}

/**
 * Request body for creating a Personal Access Token. There is NO `orgId` field: the
 * token binds to the caller's active org (the `X-Agency-Org` header) at mint time, so
 * sending one would be silently ignored. `scopes` can't exceed the minter's role.
 */
export interface CreateAccessTokenRequest {
  name: string;
  scopes: Scope[];
}

/**
 * Response to creating a token. The plaintext `token` (`agpat_…`) is returned
 * exactly once, here, and is never retrievable again.
 */
export interface CreateAccessTokenResponse {
  accessToken: AccessToken;
  token: string;
}

/**
 * A durable, per-session metric summary. The source of truth for operational
 * metrics: every dashboard number is a query + aggregate over these (no fragile
 * counters). Stamped with the config `version` that ran it.
 *
 * One row per RUNTIME LIFETIME, not per client-supplied session id. A session is
 * one microVM that lives across many back-and-forth triggers (up to 8h); the
 * runtime accumulates in memory and overwrites this row each time it goes idle,
 * so repeated triggers on a live session stay one row. If a client reuses a
 * session id after its microVM has exited, a fresh microVM starts a NEW row - so
 * "sessions" counts runtime lifetimes (the real unit of work), never
 * double-counting a live session nor clobbering a prior lifetime's metrics.
 */
export interface SessionSummary {
  agentId: string;
  sessionId: string;
  /** The config version this session ran on. */
  version: number;
  /** The model key this session ran on (for per-model cost pricing). Absent on
   *  rows written before token/cost tracking - cost is then 0. */
  model?: ModelKey;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /**
   * Invocations in this session: the opening trigger plus each accepted
   * injection. `invocations - 1` is how many follow-up messages were sent, so
   * `invocations / sessions` gives the sense of messages-per-session.
   */
  invocations: number;
  /**
   * Duration (ms) of each invocation in this session - one continuous working
   * span (agent runs → idle). An injected message folds into the span it arrived
   * in; a re-trigger after idle is a new span. This is the timing unit for the
   * dashboard's duration percentiles (NOT `durationMs`, which is the whole-lifetime
   * span incl. idle gaps). Absent on rows written before per-invocation timing.
   */
  invocationDurationsMs?: number[];
  /** Model turns (assistant messages) in the session. */
  turns: number;
  /** Total tool calls across the session. */
  toolUses: number;
  /**
   * Tool call counts by tool name, e.g. `{ run_bash: 3, web_search: 1 }`.
   * Activating a skill counts here too (the AgentSkills `skills` tool). An integration
   * call is counted under `call_integration:<integration name>` - one key per downstream
   * API rather than one for all of them (see docs/runtime.md); rows written before that
   * labelling shipped carry the bare `call_integration` key.
   */
  toolBreakdown: Record<string, number>;
  /** Mid-turn messages injected into the session. */
  injections: number;
  /** Whether the session ended cleanly or errored. */
  outcome: "ok" | "error";
  /**
   * Token usage across the whole session lifetime (all model calls on this
   * microVM), captured from the Strands Agent's accumulated usage. The four
   * fields are the LLM cost drivers (input / output / cache read / cache write).
   * Absent on rows written before token tracking shipped - treat as 0.
   */
  tokens?: TokenUsage;
}

/** Token usage counters - the four billing drivers. All default to 0 if absent. */
/** Time-bucket granularity for the metrics series. */
export type MetricsGranularity = "hour" | "day";

/** One bucket's aggregated metrics (a point in the time series). */
export interface MetricsBucket {
  /** Bucket start, UTC. `YYYY-MM-DDTHH` for hourly, `YYYY-MM-DD` for daily. */
  bucket: string;
  sessions: number;
  invocations: number;
  errors: number;
  toolUses: number;
  /** Tool call counts by tool name in this bucket (for the per-tool series). */
  toolBreakdown: Record<string, number>;
  /** Sum of session durations in this bucket, in ms (for averaging). */
  durationMsTotal: number;
  /** Total tokens (input+output+cache) across sessions in this bucket. */
  tokens: number;
  /** Dollar cost across sessions in this bucket (tokens × per-model price). */
  costUsd: number;
}

/**
 * Aggregated operational metrics for an agent over a window, optionally scoped to
 * one version. `series` is the time series (for charts; empty buckets filled so
 * the axis is continuous); top-level fields are window totals (readout strip);
 * `toolBreakdown` is window-wide. Duration percentiles are per INVOCATION in
 * the window.
 */
export interface MetricsSummary {
  /** Inclusive window bounds (UTC ISO), the bucket granularity, and version filter. */
  from: string;
  to: string;
  granularity: MetricsGranularity;
  version: number | null;
  sessions: number;
  invocations: number;
  errors: number;
  toolUses: number;
  /** Mean per-INVOCATION working duration over the window, in ms (0 if none). */
  avgDurationMs: number;
  /**
   * Per-INVOCATION duration percentiles over the window, in ms (0 if none). An
   * invocation is one working span (run→idle); a session includes the idle gaps
   * between them, so these are NOT per-session.
   */
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  toolBreakdown: Record<string, number>;
  /** Token usage totals over the window (the four billing drivers). */
  tokens: TokenUsage;
  /** Total tokens over the window (sum of the four drivers). */
  totalTokens: number;
  /** Total dollar cost over the window (per-model priced, summed). */
  costUsd: number;
  /** Mean per-session dollar cost over the window (0 if no sessions). */
  avgCostUsd: number;
  /** Per-session cost percentiles over the window, in USD (0 if no sessions). */
  p50CostUsd: number;
  p95CostUsd: number;
  p99CostUsd: number;
  series: MetricsBucket[];
}

/** Response listing an agent's config versions (newest first). */
export interface VersionsResponse {
  versions: AgentVersion[];
}

/**
 * A reusable skill: a named Markdown document (SKILL.md-style) a user owns and
 * can attach to many agents. Attaching stores only the skill id on the agent, so
 * editing a skill's content updates every agent that uses it on their next
 * session. `usedByAgentCount` is populated on list/get for the management UI.
 */
export interface Skill {
  id: string;
  /** The org this skill lives in. */
  orgId: string;
  /** userId of the creator - attribution + the shared/private visibility rule. */
  createdBy: string;
  /** true = usable by the whole org; false = usable only by its creator. */
  shared: boolean;
  /** Extra org members (userIds) who may manage this skill, beyond creator + admins. */
  managers?: string[];
  /**
   * The skill's name + description, PARSED from the `content` frontmatter (the
   * markdown is the source of truth). `name` is also the Strands skill name shown
   * to the model.
   */
  name: string;
  description: string;
  /** The full SKILL.md document (frontmatter + body) - what the user authors. */
  content: string;
  createdAt: string;
  updatedAt: string;
  /** How many of the org's agents currently attach this skill. */
  usedByAgentCount?: number;
}

/**
 * Request body to create or update a skill: the SKILL.md markdown, plus the
 * optional `shared` flag (default true). The name + description are parsed from
 * the content frontmatter (see parseSkillDoc).
 */
export interface SkillInput {
  content: string;
  /** Visible to the whole org (default true) or creator-only (false). */
  shared?: boolean;
  /** Extra org members (userIds) who may manage this skill, beyond creator + admins. */
  managers?: string[];
}

/** Response listing a user's skills. */
export interface SkillsResponse {
  skills: Skill[];
}

/**
 * How the proxy authenticates to a downstream integration API. A discriminated
 * union on `kind` so new mechanisms (token exchange, 3-legged OAuth) slot in as
 * new members without reshaping the agent-facing contract - the agent never sees
 * any of this; it just names an operation. This is the NON-secret shape (how to
 * apply the credential); the credential itself is the separate write-only
 * `secret` (the static token for `bearer`/`apiKey`, the client secret for
 * `oauth2Client`).
 *
 * - `none`         - no credential (public APIs / local test services).
 * - `bearer`       - a static long-lived token: `Authorization: Bearer <secret>`.
 * - `apiKey`       - the static secret in a custom header (`<header>: <secret>`).
 * - `oauth2Client` - OAuth2 client-credentials (m2m): the proxy mints a short-lived
 *   access token from `tokenUrl` using `clientId` + the `secret` (client secret),
 *   caches it until near expiry, and injects `Authorization: Bearer <token>`. The
 *   agent never sees the client secret OR the minted token.
 */
export type IntegrationAuth =
  | { kind: "none" }
  | { kind: "bearer" }
  | { kind: "apiKey"; header: string }
  | {
      kind: "oauth2Client";
      /** The token endpoint the proxy POSTs `grant_type=client_credentials` to. */
      tokenUrl: string;
      /** The OAuth client id (non-secret; the client secret is the write-only `secret`). */
      clientId: string;
      /** Optional space-delimited scopes requested when minting. */
      scope?: string;
      /** Optional audience (some providers, e.g. Auth0, require it). */
      audience?: string;
      /**
       * How the client secret is sent to the token endpoint: HTTP Basic auth
       * header (`basic`, the OAuth2 default) or in the form body (`body`). Some
       * providers accept only one; make it explicit.
       */
      authStyle: "basic" | "body";
    };

/** The auth mechanisms available today (for validation + the UI selector). */
export const INTEGRATION_AUTH_KINDS = ["none", "bearer", "apiKey", "oauth2Client"] as const;
export type IntegrationAuthKind = (typeof INTEGRATION_AUTH_KINDS)[number];

/** HTTP methods an integration operation can use. */
export const INTEGRATION_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type IntegrationMethod = (typeof INTEGRATION_METHODS)[number];

/**
 * The runtime tool that invokes an integration operation.
 *
 * Shared because the name crosses the wire: the runtime records a call as
 * `call_integration:<integration name>` on the trajectory event and in the session's
 * tool breakdown (so metrics say WHICH downstream API ran, not just that one did), and
 * the console splits that prefix back off to render the name. Two hardcoded copies
 * would drift silently - the label would still look right, just never match.
 */
export const INTEGRATION_CALL_TOOL = "call_integration";

/**
 * One declared operation of an integration - the unit the agent calls by id and
 * the unit the proxy authorizes at (granularity). Authored content, like a skill
 * doc: the platform (not generated code) is the source of truth, so a downstream
 * API change is a manifest edit, never a code fix. The `path` is relative to the
 * integration's `baseUrl` and may contain `{param}` placeholders.
 */
export interface IntegrationOperation {
  /** Stable id the agent names when calling, e.g. `listPets`. */
  operationId: string;
  /** One-line model-facing summary of what the operation does. */
  summary: string;
  method: IntegrationMethod;
  /** Path relative to `baseUrl`, e.g. `/pets` or `/pets/{id}`. */
  path: string;
}

/** The discovery mechanisms available today (for validation + the UI). Extend as new providers land (GraphQL introspection, MCP tool-listing). */
export const DISCOVERY_PROVIDERS = ["openapi"] as const;
export type DiscoveryProviderKind = (typeof DISCOVERY_PROVIDERS)[number];

/**
 * One operation in a discovered catalog: a normal operation plus whether the user
 * has it enabled. `enabled` is the selection state that survives a refresh - a
 * re-fetch keeps each known operation's flag and defaults a newly-appeared one to
 * OFF, so an evolving API never silently grants the agent new capabilities.
 */
export interface DiscoveredOperation extends IntegrationOperation {
  enabled: boolean;
}

/**
 * Auto-discovered operations for an integration. `operations` is the FULL last-seen
 * catalog with per-op selection; the integration's top-level `operations` is the
 * materialized *enabled* subset (the agent-facing grant unit - discovery is
 * invisible to the runtime). Kept non-secret so the UI can render the picker.
 */
export interface IntegrationDiscovery {
  /** The spec URL fetched (e.g. an OpenAPI JSON document). */
  url: string;
  /** Which provider parsed it - the first in the registry that recognized the URL. */
  provider: DiscoveryProviderKind;
  /** ISO timestamp of the last successful fetch + parse. */
  syncedAt: string;
  /** Full catalog + per-op selection (the source of truth for reconcile on refresh). */
  operations: DiscoveredOperation[];
}

/**
 * A reusable downstream-API integration a user owns and can attach to many agents
 * (mirrors `Skill`). The agent never receives the credential: it calls the
 * control-plane proxy, which holds the `secret`, authorizes the call against the
 * agent's granted `integrationIds`, and forwards ONLY to `baseUrl`. `operations`
 * is the manifest the agent discovers. The `secret` is write-only - never on this
 * type; `hasSecret` reports whether one is set.
 */
export interface Integration {
  id: string;
  /** The org this integration lives in. */
  orgId: string;
  /** userId of the creator - attribution + the shared/private visibility rule. */
  createdBy: string;
  /** true = usable by the whole org; false = usable only by its creator. */
  shared: boolean;
  /** Extra org members (userIds) who may manage this integration, beyond creator + admins. */
  managers?: string[];
  name: string;
  description: string;
  /** Base URL every operation is relative to; the proxy forwards ONLY here. */
  baseUrl: string;
  /** How the proxy authenticates downstream (non-secret shape). */
  auth: IntegrationAuth;
  /**
   * The agent's discovery surface + the proxy's grant unit. When `discovery` is
   * set (operations auto-imported from a spec), this is the *enabled* subset of
   * `discovery.operations`, materialized so the runtime + proxy never need to know
   * discovery exists. When manual, it's the hand-authored list.
   */
  operations: IntegrationOperation[];
  /**
   * Present when operations were auto-discovered from a spec URL (the full catalog
   * + per-op selection + last sync time). Absent for hand-authored integrations.
   */
  discovery?: IntegrationDiscovery;
  createdAt: string;
  updatedAt: string;
  /** Whether a credential secret is set (never the secret itself). */
  hasSecret?: boolean;
  /** How many of the org's agents currently attach this integration. */
  usedByAgentCount?: number;
}

/**
 * An integration as delivered to the runtime + returned by the proxy's discovery
 * endpoint: metadata + the operation manifest, NEVER the credential or even the
 * `baseUrl` (the runtime doesn't need it - the proxy forwards). This is what makes
 * discovery work: the agent learns which integrations + operations it CAN call.
 */
export interface ResolvedIntegration {
  id: string;
  name: string;
  description: string;
  operations: IntegrationOperation[];
}

/**
 * Request body to create or update an integration. `secret` is write-only: set or
 * rotate it here (never returned). On update, omit `secret` to leave the stored
 * credential unchanged.
 */
export interface IntegrationInput {
  name: string;
  description: string;
  baseUrl: string;
  auth: IntegrationAuth;
  /**
   * Hand-authored operations (manual mode). Required + non-empty UNLESS `discovery`
   * is set, in which case the server derives operations from the spec and this is
   * ignored. Sending `operations` without `discovery` (re)sets the integration to
   * manual mode ("detach to manual").
   */
  operations?: IntegrationOperation[];
  /**
   * Discovery mode: the server fetches + parses the spec at `url` and materializes
   * the operations. `enabledOperationIds` is the user's selection: OMIT it to enable
   * ALL discovered operations (the first-import default - "all selected, then
   * deselect"); send an array (even empty) to enable exactly those. A later refresh
   * (`POST /integrations/:id/refresh`) reconciles against the stored selection
   * instead, so new operations added upstream stay OFF until deliberately enabled.
   */
  discovery?: { url: string; enabledOperationIds?: string[] };
  secret?: string;
  /** Visible to the whole org (default true) or creator-only (false). */
  shared?: boolean;
  /** Extra org members (userIds) who may manage this integration, beyond creator + admins. */
  managers?: string[];
}

/** Response listing a user's integrations. */
export interface IntegrationsResponse {
  integrations: Integration[];
}

/**
 * Body the runtime POSTs to the proxy (`POST /internal/integrations/call`). Carries
 * `agentId`/`sessionId` so the proxy verifies the session token against them (same
 * pattern as telemetry ingest) and checks `integrationId` is in the token's grant.
 * (Discovery - "what CAN I call?" - needs no endpoint: the operation manifest rides
 * the invoke payload as `RuntimePayload.integrations`, server-authoritative like
 * skills, so the runtime surfaces it to the model locally.)
 * `pathParams` fill `{param}` placeholders in the operation path; `query` becomes the
 * query string; `body` is the JSON request body for write operations.
 *
 * `largeResponse`: the small default body cap exists to protect the LLM context window.
 * When the runtime is going to persist the body to a file in the agent's workspace
 * (the `outputPath` option on `call_integration`) instead of returning it into context,
 * it sets this so the proxy uses a much larger cap - letting an agent fetch a sizeable
 * dataset and compute over it with `run_bash` rather than re-typing it from memory. The
 * response shape is unchanged (`{status, body}`); only the cap differs. (Bounded by the
 * Lambda/API-Gateway response ceiling, so it's still a buffered response, not unbounded.)
 */
export interface IntegrationCallRequest {
  agentId: string;
  sessionId: string;
  integrationId: string;
  operationId: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  largeResponse?: boolean;
}

/**
 * The proxy's response: the downstream API's status + body (as text, size-capped).
 * `truncated` is true when the body exceeded the cap and was cut off - the caller must
 * treat the data as partial (page the API), not compute over it as if complete.
 */
export interface IntegrationCallResponse {
  status: number;
  body: string;
  truncated?: boolean;
}

// The public API described as an OpenAPI 3.1 document (built from these types).
export { buildOpenApiSpec } from "./openapi.js";

// The coding-agent skill: a self-contained Markdown guide (built from the same
// scope + model source of truth so it can't drift).
export { buildSkill } from "./skill.js";

// SKILL.md parsing/validation + the editor template (name/description live in the
// markdown frontmatter, parsed out - the document is the source of truth).
export { parseSkillDoc, ensureSkillFrontmatter, SKILL_TEMPLATE, SKILL_NAME_RE } from "./skill-doc.js";
export {
  BASE_PROMPT,
  CODING_TOOLS_PROMPT,
  ISOLATED_PROMPT,
  webToolsPrompt,
  envPrompt,
  integrationsPrompt,
  platformPromptBlocks,
  composeSystemPrompt,
} from "./prompt.js";
export type { PromptContext } from "./prompt.js";
export type { ParsedSkillDoc } from "./skill-doc.js";
