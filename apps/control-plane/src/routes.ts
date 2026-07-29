/**
 * Control-plane routes.
 *
 * Management endpoints (create/list/detail/update/rotate) require a Cognito JWT or a
 * Personal Access Token, and are scoped to the caller's ACTIVE ORG - visibility then
 * applies per resource (`canView`/`authorize`, see docs/auth.md), so "your own" is a
 * property of the org + share flags, not of the credential. The invoke endpoint is
 * authed by that agent's API key (not a JWT), so external clients can trigger exactly
 * one agent without platform credentials. The poll endpoint reads trajectory deltas.
 */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { v4 as uuidv4 } from "uuid";
import type {
  AgentConfig,
  CreateAgentResponse,
  CreateAccessTokenResponse,
  IntegrationAuth,
  IntegrationCallRequest,
  IntegrationCallResponse,
  IntegrationDiscovery,
  IntegrationInput,
  IntegrationOperation,
  InvokeResponse,
  PollResponse,
  ResolvedIntegration,
  ResolvedSkill,
  RotateKeyResponse,
  AgentRun,
  AgentRunsResponse,
  AgentRunTrace,
  Scope,
  TrajectoryEvent,
  TrajectoryEventInput,
  SessionSummaryInput,
  TokenUsage,
} from "@agency/shared";
import { costFor, tokenTotal } from "@agency/shared";
import { buildOpenApiSpec, buildSkill, isScope, isRole, isModelAllowedInNetworkMode, parseSkillDoc, scopesForRole, TRAJECTORY_EVENT_TYPES } from "@agency/shared";
import type { Org, Membership, Invite, Me, OrgMembership, Member } from "@agency/shared";
import { v7 as uuidv7 } from "uuid";
import type { Deps } from "./app.js";
import { requireAuth, requireScope, requireUser, type Principal } from "./auth.js";
import { putOrg, getOrg, deleteOrg } from "./repo/orgs.js";
import {
  getMembership,
  putMembership,
  listMembersByOrg,
  listMembershipsByUser,
  deleteMembership,
  demoteAdminIfWitnessRemains,
  updateMembershipRole,
  backfillMembershipEmail,
} from "./repo/memberships.js";
import {
  putInvite,
  getInvite,
  listInvitesByEmail,
  listInvitesByOrg,
  deleteInvite,
  normalizeEmail,
} from "./repo/invites.js";
import { mintSessionToken, verifySessionToken } from "./session-token.js";
import { mountSlackRoutes } from "./slack-routes.js";
import { dispatchSlackRun } from "./slack-dispatch.js";
import { callSlack, type SlackCallRequest } from "./slack-proxy.js";
import {
  slackSetupState,
  slackAuthTest,
  slackChannelInfo,
  slackChannelList,
  withSlackVerification,
} from "./slack-setup.js";
import { slackManifest, slackRequestUrl, SLACK_BOT_SCOPES, slackOf } from "@agency/shared";
import { generateApiKey, verifyApiKey } from "./apikey.js";
import { generateAccessToken } from "./token.js";
import {
  putToken,
  listTokensByOwner,
  deleteTokenById,
  toPublicToken,
  type TokenRecord,
} from "./repo/tokens.js";
import { newSessionId, isValidSessionId } from "./session-id.js";
import { scheduleOf } from "@agency/shared";
import { parseConfigDetailed, withDefaults } from "./config-validation.js";
import {
  putAgent,
  getAgent,
  listAgentsByOrg,
  updateAgent,
  deleteAgent,
  toPublic,
  normalizeConfig,
  freshMetrics,
  type AgentRecord,
} from "./repo/agents.js";
import { canView, canWrite, authorize, visibleToCreator } from "./authz.js";
import { readSession, readEvents, recordPrompt, recordEvent } from "./repo/trajectory.js";
import { archiveTrace, readArchivedTrace } from "./repo/traces.js";
import { bumpInvocation } from "./repo/metrics.js";
import { putVersion, listVersions, highestVersion } from "./repo/versions.js";
import { metricsFor, writeSummary, listRuns, getRun } from "./repo/sessions.js";
import {
  putSkill,
  getSkill,
  listSkills,
  deleteSkill,
  getSkillsByIds,
  type SkillRecord,
} from "./repo/skills.js";
import {
  putIntegration,
  getIntegration,
  listIntegrations,
  deleteIntegration,
  getIntegrationsByIds,
  updateDiscoveryResult,
  toPublicIntegration,
  type IntegrationRecord,
} from "./repo/integrations.js";
import { parseIntegrationBody, parseAuth } from "./integration-validation.js";
import { forwardCall } from "./integration-proxy.js";
import { syncDiscovery, refreshDiscovery, reselect, enabledOperations, credentialForSpec } from "./discover-operations.js";
import { validateOutboundUrl } from "./outbound.js";
import { isAmbiguousOutcome } from "./invoker/agentcore.js";
import { resolveSkills, resolveIntegrations } from "./resolve-attachments.js";
import { PUBLIC_API_URL } from "./config.js";

type Env = { Variables: { principal: Principal } };

/** Upper bound on a single invoke/inject prompt (cost/DoS guard). */
const MAX_PROMPT = 100_000;

/** Valid trajectory event types, for validating internal ingest posts. */
const TRAJECTORY_EVENT_TYPES_SET = new Set<string>(TRAJECTORY_EVENT_TYPES);

/** Runs returned by the run list when the caller doesn't ask, and the ceiling. */
const DEFAULT_RUN_LIMIT = 50;
const MAX_RUN_LIMIT = 200;

/**
 * Most extra managers a resource may name. Each costs a membership read on the write
 * path, and the list is stored on the item, so it has to be bounded somewhere.
 */
const MAX_MANAGERS = 50;

/** A canonical UUID. Guards ids that become storage keys (`runId`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Budget for one run's serialized events. A run accrues events across every invocation on
 * its microVM (the per-turn budget bounds one invocation, not the run), and the response is
 * one JSON body, so an unbounded trace would blow the Lambda's ~6 MB payload ceiling - an
 * opaque 502 that makes the run unopenable forever.
 * Sized (like the integrations proxy's cap) to leave room for JSON escaping.
 */
const MAX_TRACE_BYTES = 2_500_000;

/**
 * Assemble a run's trace, dropping events past the size budget.
 *
 * Truncation keeps the OLDEST events: a trace is read top-down, and the prompt plus the
 * first steps are what explain a run. `truncated` tells the UI to say so, so a clipped
 * trace never reads as a complete one.
 */
function traceOf(
  runId: string,
  sessionId: string,
  events: TrajectoryEvent[],
  archived: boolean,
): AgentRunTrace {
  let bytes = 0;
  const kept: TrajectoryEvent[] = [];
  for (const e of events) {
    // byteLength, not .length: JSON.stringify emits non-ASCII raw, so one CJK char is
    // 3 UTF-8 bytes. Counting code units let a non-English trace reach ~3x the budget
    // and blow the very payload ceiling this cap exists to respect.
    bytes += Buffer.byteLength(JSON.stringify(e), "utf8");
    // Keep the first event unconditionally: a single oversized event would otherwise
    // yield an empty list, which the UI reads as "this run's steps are gone".
    if (bytes > MAX_TRACE_BYTES && kept.length > 0) break;
    kept.push(e);
  }
  const truncated = kept.length < events.length;
  return { runId, sessionId, events: kept, archived, ...(truncated ? { truncated } : {}) };
}

/** The 400 for an OpenAI model in isolated mode - raised on both create and edit. */
const ISOLATED_MODEL_400 =
  "OpenAI models aren't available in isolated network mode (Mantle is reachable only with public egress) - pick an Anthropic model or use public mode";

/**
 * Project a stored session-summary row into a run-list entry.
 *
 * Every numeric is defaulted. Some fields genuinely postdate the table (legacy rows
 * have no `tokens`/`invocations`/`model`), and the rest are defended because a summary
 * is SELF-REPORTED by the runtime and the ingest route doesn't validate its shape -
 * so a missing field must render as `0`, not as "undefined turns".
 */
function runFor(r: SessionSummaryInput): AgentRun {
  // A summary is self-reported, so a PARTIAL tokens object (say only inputTokens) must
  // not put NaN on the wire - JSON renders NaN as `null`, violating the spec's required
  // integers - and costFor/tokenTotal harden their own inputs as a second layer.
  // Coerced, not just defaulted: `tokenTotal` and `costFor` both harden their own
  // inputs, but this bundle is also spread onto the response, so normalize once here.
  const tokens: TokenUsage = {
    inputTokens: Number(r.tokens?.inputTokens) || 0,
    outputTokens: Number(r.tokens?.outputTokens) || 0,
    cacheReadTokens: Number(r.tokens?.cacheReadTokens) || 0,
    cacheWriteTokens: Number(r.tokens?.cacheWriteTokens) || 0,
  };
  return {
    runId: r.runId,
    sessionId: r.sessionId,
    version: r.version,
    ...(r.model ? { model: r.model } : {}),
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMs: r.durationMs ?? 0,
    invocations: r.invocations ?? 1,
    turns: r.turns ?? 0,
    toolUses: r.toolUses ?? 0,
    outcome: r.outcome,
    totalTokens: tokenTotal(tokens),
    costUsd: costFor(r.model ?? "", tokens),
  };
}

/** Max length of the (non-versioned) agent description. */
const MAX_DESCRIPTION = 280;

/** Normalize a raw `description` body field: trim, cap length, drop empties. */
function cleanDescription(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().slice(0, MAX_DESCRIPTION);
  return trimmed || undefined;
}

/**
 * Read the `shared` flag off a raw create body. Discoverability defaults to TRUE
 * (a resource is org-visible unless the creator opts out) - so anything but an
 * explicit `false` is `true`. Metadata, not versioned config.
 */
function parseShared(raw: unknown): boolean {
  return (raw as { shared?: unknown } | null)?.shared !== false;
}

/**
 * The `shared` value for a PATCH: flip it when the body carries the flag, else keep
 * the existing value. (Different from create's `parseShared`, which defaults true -
 * a PATCH must not silently re-share a private resource just because the field was
 * omitted.)
 */
function patchShared(raw: unknown, existing: boolean): boolean {
  const body = raw as { shared?: unknown } | null;
  return body && "shared" in body ? body.shared !== false : existing;
}

/**
 * Resolve the `managers` list from a create/update body: keep only distinct
 * userIds that are actual members of `orgId`, and drop the creator (they always
 * manage - listing them would be redundant + could imply they can be removed).
 * Returns undefined when the body omits `managers` (so a PATCH leaves the stored
 * list untouched) or when nothing valid remains. Silently dropping non-members is
 * intentional: a stale/removed member in the list is a no-op, not a 400.
 */
async function resolveManagers(
  raw: unknown,
  orgId: string,
  createdBy: string,
): Promise<string[] | undefined> {
  const body = raw as { managers?: unknown } | null;
  if (!body || !("managers" in body) || !Array.isArray(body.managers)) return undefined;
  // Capped, then membership-checked: each id costs one DynamoDB read, so an
  // unbounded list is a request that does unbounded work (and a stored list that can
  // outgrow the item-size limit). A grant list is a handful of colleagues; anything
  // past the cap is a mistake or an attack, so the excess is dropped rather than
  // 400ing an otherwise-valid edit.
  const ids = [
    ...new Set(body.managers.filter((m): m is string => typeof m === "string" && m !== createdBy)),
  ].slice(0, MAX_MANAGERS);
  const found = await Promise.all(ids.map(async (id) => ((await getMembership(orgId, id)) ? id : null)));
  const valid = found.filter((id): id is string => id !== null);
  return valid.length ? valid : undefined;
}

/**
 * The `managers` value for a PATCH: re-resolve when the body carries the field,
 * else keep as-is. ONLY the creator or an org admin may change the list - a plain
 * granted manager can edit the resource's content but must not re-delegate the
 * grant (add allies / prune peers), so for them the field is ignored and the
 * stored list is preserved. (canWrite lets a manager reach this handler; this is
 * the finer gate on the grant itself.)
 */
async function patchManagers(
  principal: Principal,
  raw: unknown,
  record: { orgId: string; createdBy: string; managers?: string[] },
): Promise<string[] | undefined> {
  const body = raw as { managers?: unknown } | null;
  if (!body || !("managers" in body)) return record.managers;
  const isOwnerOrAdmin = principal.userId === record.createdBy || principal.role === "admin";
  if (!isOwnerOrAdmin) return record.managers; // a manager can't re-delegate the grant
  return resolveManagers(raw, record.orgId, record.createdBy);
}

/**
 * Public agent for a principal, with `config.env` VALUES redacted for anyone who can't
 * WRITE the agent (a viewer, or a co-member of a shared agent). Key names are kept -
 * they're already surfaced to the model and drive the UI.
 */
function publicAgentFor(principal: Principal, record: AgentRecord) {
  const pub = toPublic(record);
  if (!canWrite(principal, record)) {
    // `config.env` is where users put per-agent third-party secrets, so redact the
    // VALUES for a non-writer (a viewer, or a co-member of a shared agent). The
    // agent's own API key needs no redaction: it is returned once at create/rotate
    // and never stored, so it isn't on the record to leak.
    if (pub.config.env) {
      pub.config = { ...pub.config, env: redactEnvValues(pub.config.env) };
    }
  }
  return pub;
}

/** Replace each env value with a placeholder, preserving the key names. */
function redactEnvValues(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(env).map((k) => [k, REDACTED]));
}

/** Marker returned instead of an env value a caller isn't allowed to read. */
const REDACTED = "***";

/**
 * Validate a skill create/update body. The body is a single SKILL.md document
 * (`{ content }`); the name + description are parsed from its frontmatter. On a
 * valid, standard doc returns the parsed fields; otherwise the structural errors
 * (so the client learns exactly what's missing).
 */
function parseSkillBody(
  raw: unknown,
): { ok: true; name: string; description: string; content: string } | { ok: false; errors: string[] } {
  const content = typeof (raw as Record<string, unknown> | null)?.content === "string"
    ? (raw as { content: string }).content
    : "";
  if (!content.trim()) return { ok: false, errors: ["content is required (a SKILL.md document)"] };
  const parsed = parseSkillDoc(content);
  if (parsed.errors.length) return { ok: false, errors: parsed.errors };
  return { ok: true, name: parsed.name, description: parsed.description, content };
}

/** Count how many of an org's agents attach a given skill id. */
function countAgentsUsingSkill(agents: { config: AgentConfig }[], skillId: string): number {
  return agents.filter((a) => a.config.skillIds?.includes(skillId)).length;
}

/**
 * Whether the org already has a skill named `name` (case-insensitive), other than
 * `exceptId` (the skill being updated). Name uniqueness is per-ORG and spans both
 * shared AND private skills (a bare name must be unambiguous at runtime).
 */
async function nameTaken(orgId: string, name: string, exceptId: string | null): Promise<boolean> {
  const skills = await listSkills(orgId);
  const lower = name.toLowerCase();
  return skills.some((s) => s.id !== exceptId && s.name.toLowerCase() === lower);
}

/** Count how many of an org's agents attach a given integration id. */
function countAgentsUsingIntegration(agents: { config: AgentConfig }[], integrationId: string): number {
  return agents.filter((a) => a.config.integrationIds?.includes(integrationId)).length;
}

/**
 * Whether the org already has an integration named `name` (case-insensitive),
 * other than `exceptId` (the one being updated). Name uniqueness is per-ORG and
 * spans both shared AND private integrations.
 */
async function integrationNameTaken(orgId: string, name: string, exceptId: string | null): Promise<boolean> {
  const integrations = await listIntegrations(orgId);
  const lower = name.toLowerCase();
  return integrations.some((i) => i.id !== exceptId && i.name.toLowerCase() === lower);
}

/**
 * The set of origins the stored `secret` is transmitted to, so a PATCH can't silently
 * redirect the write-only credential to an attacker host while keeping it. Two sinks:
 * `baseUrl` (bearer/apiKey ride the proxy's forward there; a discovery fetch too), and -
 * for `oauth2Client` - the `tokenUrl` the client secret is POSTed to when minting. A
 * change to ANY of these origins requires re-entering the secret.
 */
function credentialSinkOrigins(baseUrl: string, auth: IntegrationAuth): string[] {
  const origins = [baseUrl];
  if (auth.kind === "oauth2Client") origins.push(auth.tokenUrl);
  return origins.map((u) => {
    try {
      return new URL(u).origin;
    } catch {
      return u; // unparseable → compare verbatim (won't match a valid origin)
    }
  });
}

/**
 * Turn a validated integration input into the operations to store: either the
 * hand-authored `operations` (manual mode), or - when `discovery` is set - the
 * catalog fetched + parsed from the spec URL, reconciled against the prior state.
 *
 * Discovery has a fast path: when the URL is UNCHANGED from what's stored, we don't
 * re-fetch (a name edit or a pure enable/disable toggle shouldn't hit the network,
 * or fail because the spec host is briefly down) - we just re-apply the selection to
 * the stored catalog. A changed (or first) URL fetches. Returns the operations +
 * the `discovery` block to store (absent in manual mode), or a DiscoveryError.
 */
async function resolveOperations(
  input: IntegrationInput,
  existing: IntegrationRecord | undefined,
): Promise<{ operations: IntegrationOperation[]; discovery?: IntegrationDiscovery } | { error: string }> {
  if (!input.discovery) return { operations: input.operations ?? [] }; // manual mode
  const prior = existing?.discovery;
  const now = new Date().toISOString();
  // Same URL as stored → re-select against the cached catalog, no network fetch.
  if (prior && prior.url === input.discovery.url) {
    const catalog = reselect(prior.operations, input.discovery.enabledOperationIds);
    return {
      operations: enabledOperations(catalog),
      discovery: { ...prior, syncedAt: now, operations: catalog },
    };
  }
  // New or changed URL → fetch + parse; first-import selection semantics apply. The
  // spec is often gated by the integration's own credential, so authenticate the fetch
  // with it (just-entered secret, else stored) - but ONLY if the spec is under baseUrl,
  // so a caller can't aim the credentialed fetch at an arbitrary host to read the secret.
  // When the secret comes from the STORED record (not re-entered), anchor to the STORED
  // baseUrl - the PATCH guard already blocks a stored-secret + baseUrl-origin change, and
  // this makes the anchor correct independently of that guard (defense in depth).
  const usingStoredSecret = input.secret === undefined && existing?.secret !== undefined;
  const anchorBase = usingStoredSecret ? existing!.baseUrl : input.baseUrl;
  const cred = credentialForSpec(input.discovery.url, anchorBase, input.auth, input.secret ?? existing?.secret);
  const synced = await syncDiscovery(input.discovery.url, undefined, input.discovery.enabledOperationIds, now, cred);
  return synced;
}

/**
 * Apply a new config to an agent as the next version: bump the version, append
 * the config to the version history, persist both on the agent, reconcile the
 * schedule. Shared by PATCH (edit) and restore. Returns the updated in-memory
 * record. Ownership is checked by the caller.
 *
 * Note: config takes effect on the next invoke because it rides the invoke
 * payload to the shared runtime - there is nothing to re-provision (the runtime
 * image + env are platform-owned, updated on deploy, not per agent).
 */
async function applyNewVersion(
  deps: Deps,
  record: AgentRecord,
  config: AgentConfig,
  note?: string,
): Promise<AgentRecord> {
  // Reconcile the schedule BEFORE persisting: if EventBridge rejects the change
  // (bad expression, throttling), fail the request without leaving the DB and the
  // live schedule diverging.
  //
  // The reverse order of failure is real too - reconcile succeeds, then the config
  // write loses (CAS contention, throttling) - which would leave EventBridge running
  // the NEW schedule while the stored config still says the old one. So a failed
  // persist restores the schedule to whatever config is actually stored. Best-effort:
  // the caller gets the original error either way, and a schedule tick against a
  // stale-but-real config is far better than a 500 that hides the divergence.
  const previousSchedule = scheduleOf(record.config) ?? null;
  await deps.scheduler.reconcile(record.id, scheduleOf(config) ?? null);
  const restoreSchedule = async () => {
    const stored = await getAgent(record.id).catch(() => null);
    const target = stored ? (scheduleOf(stored.config) ?? null) : previousSchedule;
    await deps.scheduler
      .reconcile(record.id, target)
      .catch((e) => console.error("schedule restore failed", record.id, e));
  };

  // The bump is a read-modify-write, so it's a COMPARE-AND-SWAP with retry rather
  // than a blind write: two concurrent PATCHes that both read version=5 would both
  // compute 6, one config would vanish from history, and the agent's live config
  // could end up being a different config than the v6 snapshot claims. putVersion
  // claims the (agentId, version) slot and updateAgent guards on the expected
  // current version; losing either race means someone else bumped first, so we
  // re-read and recompute against their version. (Two edits to the SAME field still
  // resolve last-write-wins - what this guarantees is that every applied config is
  // in history exactly once, under the version the agent actually points at.)
  let current = record;
  // The next slot to CLAIM, tracked separately from the agent's current version. They
  // differ when history is ahead of the record (an orphaned row - see below): the claim
  // must skip past it, while `expectedVersion` must stay the record's real version or
  // the agent guard can never match and the edit could never land.
  let claim = (current.version ?? 1) + 1;
  for (let attempt = 0; attempt < VERSION_BUMP_ATTEMPTS; attempt++) {
    const version = claim;
    try {
      // Append the version first, then bump the agent to it: if the append fails we
      // never advance `version` past a snapshot that isn't in history.
      await putVersion({ agentId: current.id, version, config, createdAt: new Date().toISOString(), note });
      await updateAgent(current.id, { config, version, expectedVersion: current.version });
      return { ...current, config, version };
    } catch (e) {
      if (!isConditionalCheckFailed(e)) {
        await restoreSchedule();
        throw e;
      }
      if (attempt === VERSION_BUMP_ATTEMPTS - 1) {
        await restoreSchedule();
        throw contention(e);
      }
      // Back off before re-reading: the winner claimed the slot but may not have
      // bumped the agent yet, so an immediate re-read would see the OLD version,
      // recompute the same number, and lose again - burning every attempt in
      // microseconds instead of waiting the millisecond it takes to land.
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
      const fresh = await getAgent(current.id);
      if (!fresh) throw e; // deleted under us - let the caller surface it
      // Reconcile against HISTORY, not just the agent record. They can diverge: a
      // putVersion that succeeded followed by an updateAgent that failed
      // non-conditionally leaves an ORPHANED row at a version the agent doesn't point
      // at. Recomputing from the agent alone would then re-claim that same taken slot
      // on every attempt, so the agent would 503 on every config edit forever.
      current = fresh;
      // Claim above BOTH the agent record and history's high-water mark. A putVersion
      // that succeeded followed by an updateAgent that failed non-conditionally leaves
      // an orphaned row at a version the agent doesn't point at; recomputing from the
      // record alone would re-claim that taken slot on every attempt, so every config
      // edit and restore would 503 forever with no way to recover.
      const claimed = await highestVersion(current.id);
      claim = Math.max(current.version ?? 1, claimed) + 1;
    }
  }
  // Unreachable: the loop either returns or throws on the last attempt.
  throw new Error("version bump exhausted its attempts");
}

/** How many times a losing version bump re-reads and retries before giving up. */
const VERSION_BUMP_ATTEMPTS = 4;
/** Base backoff between version-bump retries (multiplied by the attempt number). */
const RETRY_BACKOFF_MS = 25;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Losing every attempt means sustained write contention on one agent, not a broken
 * request - surface it as transient (`isTransient` → 503 "retry shortly") rather
 * than a generic 500, so the caller knows retrying is the right move.
 */
function contention(cause: unknown): Error {
  return Object.assign(new Error("agent is being updated concurrently, retry shortly"), {
    name: "ConflictException",
    cause,
  });
}

/** True for a DynamoDB conditional-write failure (someone else won the race). */
function isConditionalCheckFailed(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: string }).name === "ConditionalCheckFailedException";
}

/**
 * Resolve an agent by id + its API key (from the Authorization header) for the
 * invoke/poll endpoints. Returns null on either a missing agent OR a bad key -
 * the caller returns an identical 401 for both, so an unauthenticated caller
 * can't use the status code to tell which agent ids exist.
 */
/**
 * The 401 for invoke/poll. Names BOTH causes because the check deliberately can't
 * distinguish them: pasting the docs' `AGENT_ID` placeholder and using another
 * agent's key produce the same response, and a bare "invalid api key" sent a real
 * user hunting the key when the URL was the problem.
 */
const AGENT_KEY_401 =
  "invalid api key for this agent - check BOTH the agent id in the URL and that the key is " +
  "this agent's current key (rotating replaces it). This same error is returned when no " +
  "agent with that id exists, so that ids can't be enumerated.";

async function authAgentByKey(id: string, authHeader?: string): Promise<AgentRecord | null> {
  const record = await getAgent(id);
  if (!record) return null;
  const key = (authHeader ?? "").replace(/^Bearer\s+/, "");
  return key && verifyApiKey(key, record.apiKeyHash) ? record : null;
}

export function buildRoutes(deps: Deps): Hono<Env> {
  const app = new Hono<Env>();

  // ---- OpenAPI spec (public) ----------------------------------------------
  // The machine-readable API contract, generated from the shared wire types.
  // Public (no auth) so a code assistant or SDK generator can fetch it. Served
  // with the deployed origin as the `servers` URL so generated clients hit the
  // right host.
  app.get("/openapi.json", (c) => c.json(buildOpenApiSpec(PUBLIC_API_URL)));

  // The coding-agent skill: a single self-contained Markdown guide. Public (no
  // auth) so a user can point their coding agent straight at it. Served as
  // Markdown with the deployed origin baked into every URL + recipe.
  app.get("/skill.md", (c) => c.text(buildSkill(PUBLIC_API_URL), 200, { "Content-Type": "text/markdown; charset=utf-8" }));

  // ---- Internal telemetry ingest (runtime → control-plane) ----------------
  // The runtime posts trajectory events + session summaries here instead of
  // writing DynamoDB directly, so its AWS role needs no table write (Bedrock-only
  // role - the agent can't reach DDB even via stolen MMDS creds). Auth is a
  // PER-SESSION capability token (X-Agency-Ingest-Token) minted at invoke and
  // scoped to one (agentId, sessionId): we verify the token AND that the body's
  // agentId/sessionId match its claims. So the runtime holds NO long-lived secret,
  // and a token leaked from the microVM (e.g. via /proc) only lets the agent write
  // ITS OWN session's telemetry - never another tenant's. `type` is validated
  // against the known event types so a leaked token can't forge a bogus event
  // shape. Writes are best-effort on the runtime side; we 400 on garbage / 401 on
  // a bad token, and a 5xx just makes the runtime log + move on.
  const tokenOf = (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header("X-Agency-Ingest-Token") ?? "";

  // Authenticate BEFORE validating the rest of the body: the token is scoped to
  // (agentId, sessionId), so we only need those two identifiers to verify it, and
  // an unauthenticated caller shouldn't be able to probe the body schema. A type
  // guard: returns true only when the body carries string ids AND the token
  // verifies against them; both call sites 401 on false (missing ids and a bad
  // token are indistinguishable to an unauthenticated caller, by design).
  const authIngest = <T extends { agentId?: unknown; sessionId?: unknown }>(
    c: Parameters<typeof tokenOf>[0],
    body: T | null,
  ): body is T & { agentId: string; sessionId: string } => {
    if (!body || typeof body.agentId !== "string" || typeof body.sessionId !== "string") return false;
    const claims = verifySessionToken(tokenOf(c));
    return claims !== null && claims.agentId === body.agentId && claims.sessionId === body.sessionId;
  };

  app.post("/internal/trajectory", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<TrajectoryEventInput> | null;
    if (!authIngest(c, body)) return c.json({ error: "invalid ingest token" }, 401);
    if (typeof body.cursor !== "string" || typeof body.type !== "string" ||
        !TRAJECTORY_EVENT_TYPES_SET.has(body.type)) {
      return c.json({ error: "invalid trajectory event" }, 400);
    }
    await recordEvent(body as TrajectoryEventInput);
    return c.body(null, 204);
  });

  app.post("/internal/session-summary", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<SessionSummaryInput> | null;
    if (!authIngest(c, body)) return c.json({ error: "invalid ingest token" }, 401);
    // The runId is the sessions-table sort key AND the trace object's key, so it must
    // be the UUID the runtime mints - not an arbitrary string that could shape a key.
    // typeof first: RegExp.test coerces, so an array like ["<uuid>"] would pass and
    // then hit DynamoDB as a List sort key (a 500 the runtime retries) instead of a
    // clean 400.
    if (typeof body.runId !== "string" || !UUID_RE.test(body.runId)) {
      return c.json({ error: "invalid session summary" }, 400);
    }
    const summary = body as SessionSummaryInput;
    await writeSummary(summary);
    // Archive the run's trajectory so it outlives the trajectory table's 30-day TTL
    // and stays openable in the run list. The runtime posts a summary at EVERY idle
    // point, so this re-archives as a session grows - the events are append-only, so
    // each write is a superset of the last.
    //
    // Best-effort, and the try must wrap the READ as well as the write: the summary is
    // already durable by now, so a throttled trajectory read must not turn this into a
    // 500 the runtime retries (re-posting the summary and re-reading the trajectory,
    // amplifying the very throttling that caused it). Awaited rather than floating - an
    // unhandled rejection after the response would take down the Lambda.
    try {
      await archiveTrace(
        summary,
        await readEvents(summary.agentId, summary.sessionId, undefined, summary.runId),
      );
    } catch (e) {
      console.error("trace archive failed", summary.agentId, summary.runId, e);
    }
    return c.body(null, 204);
  });

  // ---- Integrations proxy (runtime → downstream API) ----------------------
  // The agent never holds a downstream credential: to call an integration it POSTs
  // here, we hold the secret and forward. Authorization is STATELESS - entirely
  // from the session token (no agents-table read, so the ingest Lambda needs no
  // agents access): the token verifies against the body's agentId/sessionId AND
  // the requested integrationId must be in the token's granted set. The token's
  // orgId scopes the integration lookup (org-isolated) and its agentCreatedBy
  // re-runs the visibility check, so a leaked token can only call the integrations
  // THIS session was granted, in its own org. The proxy composes the URL from the
  // stored baseUrl + operation path only (no agent-supplied host), injects the
  // credential, and returns status + capped body.
  /**
   * The Slack proxy - the agent's only way to reach Slack. Authed by the same per-session
   * capability token as telemetry ingest, and the target thread is derived from that token's
   * `sessionId`, NOT from the body: there is no channel parameter for a prompt-injected agent
   * to aim elsewhere.
   */
  app.post("/internal/slack/call", async (c) => {
    const body = (await c.req.json().catch(() => null)) as (Partial<SlackCallRequest> & {
      agentId?: string;
      sessionId?: string;
    }) | null;
    const claims = verifySessionToken(tokenOf(c));
    if (!claims) return c.json({ error: "invalid ingest token" }, 401);
    if (body?.action !== "reply" && body?.action !== "set_status") {
      return c.json({ error: "action must be reply or set_status" }, 400);
    }
    // agentId + sessionId come from the VERIFIED token, never the body - so the call cannot be
    // aimed at another agent or another thread.
    const result = await callSlack(claims.agentId, claims.sessionId, body as SlackCallRequest, claims.replyToTs);
    // Always 200: a Slack-side failure is a TOOL result the model must read and adapt to
    // ({error, hint}), not an HTTP error the runtime would retry blindly.
    return c.json(result);
  });

  app.post("/internal/integrations/call", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<IntegrationCallRequest> | null;
    if (!authIngest(c, body)) return c.json({ error: "invalid ingest token" }, 401);
    const claims = verifySessionToken(tokenOf(c))!; // authIngest already verified it
    if (typeof body.integrationId !== "string" || typeof body.operationId !== "string") {
      return c.json({ error: "integrationId and operationId are required" }, 400);
    }
    // Authorization: the integration must be in this session's granted set. This is
    // the whole access check - stateless, from the signed token, no DB read.
    if (!claims.integrationIds.includes(body.integrationId)) {
      return c.json({ error: "this agent is not authorized to use that integration" }, 403);
    }
    // Org-scoped lookup (the token's orgId): resolves the baseUrl + secret. A
    // granted-but-since-deleted integration is a 404.
    const record = await getIntegration(claims.orgId, body.integrationId);
    if (!record) return c.json({ error: "integration not found" }, 404);
    // Q4 recheck: even though the grant listed this id, refuse if the integration is
    // no longer visible to the agent's creator (un-shared since attach). Graceful:
    // the agent's other integrations keep working; only this one is refused.
    if (!visibleToCreator(record, claims.agentCreatedBy)) {
      return c.json({ error: "this integration is no longer available to the agent" }, 403);
    }

    const result = await forwardCall(record, body as IntegrationCallRequest);
    if ("error" in result) return c.json(result, 400);
    const res: IntegrationCallResponse = result;
    return c.json(res);
  });

  // ---- Management endpoints (JWT or Personal Access Token) ----------------
  // Scoped precisely: management routes require an authenticated principal, but
  // the invoke and poll routes below are authed by the agent's own API key, so
  // they must NOT be caught by this middleware. Hono runs middleware registered
  // before a matching handler, so we attach requireAuth per management route.
  // Per-route capability (read / write / delete) is enforced with requireScope inside
  // each handler chain below (see auth.ts + docs/auth.md).
  app.use("/agents", requireAuth);
  app.use("/agents/:id", requireAuth);
  app.use("/agents/:id/rotate-key", requireAuth);
  app.use("/agents/:id/versions", requireAuth);
  app.use("/agents/:id/versions/:version/restore", requireAuth);
  app.use("/agents/:id/metrics", requireAuth);
  app.use("/agents/:id/runs", requireAuth);
  app.use("/agents/:id/runs/:runId", requireAuth);
  // Nested paths need their own line - the /agents/:id prefix does NOT cover them (same reason
  // integrations/:id/refresh needs one). Omitting these left the Slack setup routes reaching
  // requireScope with no principal: a 500 rather than a 401, and one null-guard away from an
  // unauthenticated credential write.
  app.use("/agents/:id/slack", requireAuth);
  app.use("/agents/:id/slack/credentials", requireAuth);
  app.use("/agents/:id/slack/channels", requireAuth);
  app.use("/skills", requireAuth);
  app.use("/skills/:id", requireAuth);
  app.use("/integrations", requireAuth);
  app.use("/integrations/:id", requireAuth);
  app.use("/integrations/:id/refresh", requireAuth); // nested path isn't covered by the :id prefix
  app.use("/tokens", requireAuth);
  app.use("/tokens/:id", requireAuth);
  // Org model: identity bootstrap, org CRUD, members, invites. All authed; the
  // admin-only + JWT-only gates are applied per-handler (requireOrgRole/requireUser).
  app.use("/me", requireAuth);
  app.use("/orgs", requireAuth);
  app.use("/orgs/:id", requireAuth);
  app.use("/orgs/:id/members", requireAuth);
  app.use("/orgs/:id/members/:userId", requireAuth);
  app.use("/orgs/:id/invites", requireAuth);
  app.use("/orgs/:id/invites/:email", requireAuth);
  app.use("/invites", requireAuth);
  app.use("/invites/:orgId/accept", requireAuth);
  app.use("/invites/:orgId/decline", requireAuth);

  // Create an agent: persist config (+ version 1 + schedule reconcile), return
  // the agent + its API key (shown exactly once). No runtime to provision - the
  // shared runtime is platform-owned; an agent is pure config.
  app.post("/agents", requireScope("write"), async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const check = parseConfigDetailed(raw, false);
    // `details` names each bad field + its rule, so the caller can fix it without
    // guessing (same shape the skills routes already return).
    if (!check.ok) return c.json({ error: "invalid config", details: check.errors }, 400);
    const parsed = check.config;
    // normalizeConfig enforces the networkMode invariants (isolated ⇒ web off).
    const config = normalizeConfig(withDefaults(parsed));
    if (!isModelAllowedInNetworkMode(config.model, config.networkMode)) {
      return c.json({ error: ISOLATED_MODEL_400 }, 400);
    }
    const description = cleanDescription(raw?.description);

    const id = uuidv4();
    const { apiKey, hash } = generateApiKey();
    const now = new Date().toISOString();

    // An agent is pure config - there's no per-agent runtime to provision (the
    // shared runtime is platform-owned). Creating one is a DynamoDB write plus a
    // schedule reconcile. It lives in the caller's active org, attributed to them,
    // shared with the org unless they opted out.
    const managers = await resolveManagers(raw, c.var.principal.orgId, c.var.principal.userId);
    const record: AgentRecord = {
      id,
      orgId: c.var.principal.orgId,
      createdBy: c.var.principal.userId,
      shared: parseShared(raw),
      ...(managers ? { managers } : {}),
      config,
      description,
      version: 1,
      invokeUrl: `${PUBLIC_API_URL}/agents/${id}/invoke`,
      apiKeyHash: hash,
      createdAt: now,
      updatedAt: now,
      metrics: freshMetrics(),
    };

    let persisted = false;
    try {
      await putAgent(record);
      persisted = true;
      // Record version 1 as the first history entry (config is the source of
      // truth on the agent item; this is the archive for inspect/restore).
      await putVersion({ agentId: id, version: 1, config, createdAt: now });
      // Reconcile the recurring trigger (no-op locally / when there's no schedule).
      // Inside the try so a schedule failure rolls the whole create back rather
      // than leaving an agent the client believes was never created.
      await deps.scheduler.reconcile(id, scheduleOf(config) ?? null);
    } catch (err) {
      // Roll back the record so a half-failed create (e.g. a bad schedule) leaves
      // nothing behind - the client got no API key, so a lingering agent is dead.
      if (persisted) {
        await deleteAgent(id).catch((e) => console.error("failed to clean up orphaned agent record", id, e));
      }
      throw err;
    }

    const res: CreateAgentResponse = { agent: toPublic(record), apiKey };
    return c.json(res, 201);
  });

  app.get("/agents", requireScope("read"), async (c) => {
    // Org partition, then the visibility filter: shared agents + the caller's own
    // private ones (a co-member's private agent is invisible - Q2).
    const agents = await listAgentsByOrg(c.var.principal.orgId);
    const visible = agents.filter((a) => canView(c.var.principal, a));
    // publicAgentFor (not toPublic): it redacts `config.env` VALUES for a caller who
    // can't write the agent - the same rule the single-get applies. Don't swap in
    // toPublic; that would hand a viewer the creator's downstream secrets.
    return c.json({ agents: visible.map((a) => publicAgentFor(c.var.principal, a)) });
  });

  app.get("/agents/:id", requireScope("read"), async (c) => {
    const record = await getAgent(c.req.param("id"));
    if (!record || !canView(c.var.principal, record)) return c.json({ error: "not found" }, 404);
    // publicAgentFor redacts `config.env` values for a non-writer (see its docblock).
    return c.json({ agent: publicAgentFor(c.var.principal, record) });
  });

  // Update config. Every field takes effect on the agent's next invoke - the
  // control-plane sends the current config (+ resolved skills + resolved integration
  // manifests + version) in the invoke payload to the shared runtime. No re-bake:
  // there's no per-agent image.
  app.patch("/agents/:id", requireScope("write"), async (c) => {
    const auth = authorize(c.var.principal, await getAgent(c.req.param("id")), "write", "you can't edit this shared agent");
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);

    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const check = parseConfigDetailed(raw, true);
    if (!check.ok) return c.json({ error: "invalid config", details: check.errors }, 400);
    const parsed = check.config;

    let current = auth.record;

    // Validate the MERGED config before writing anything. The metadata write below and
    // the version bump are separate writes, so a gate that sat between them let a
    // rejected request (400) still persist the metadata half - the caller saw a failure
    // while `shared` had already flipped.
    const merged = normalizeConfig({ ...normalizeConfig(current.config), ...parsed } as AgentConfig);
    if (!isModelAllowedInNetworkMode(merged.model, merged.networkMode)) {
      return c.json({ error: ISOLATED_MODEL_400 }, 400);
    }

    // Description, shared, and managers are metadata (not behavior): persist in ONE
    // write, NO version bump. Managers is gated - only the creator/admin may change
    // the list (a granted manager reaches this handler via canWrite but must not
    // re-delegate the grant; patchManagers preserves the stored list for them).
    const meta: Parameters<typeof updateAgent>[1] = {};
    // An emptied description is `null` (clear it), not undefined (which updateAgent
    // reads as "not sent"), so a description can actually be removed once set.
    if (raw && "description" in raw) meta.description = cleanDescription(raw.description) ?? null;
    if (raw && "shared" in raw) meta.shared = patchShared(raw, current.shared);
    if (raw && "managers" in raw) meta.managers = (await patchManagers(c.var.principal, raw, current)) ?? null;
    if (Object.keys(meta).length > 0) {
      await updateAgent(current.id, meta);
      current = {
        ...current,
        // null means we just cleared it, so mirror that as absent in the response.
        ...(meta.description !== undefined ? { description: meta.description ?? undefined } : {}),
        ...(meta.shared !== undefined ? { shared: meta.shared } : {}),
        ...("managers" in meta ? { managers: meta.managers ?? undefined } : {}),
      };
    }

    // Config change → new version. Only when the merged config actually differs
    // from the current one, so a description-only edit (or a no-op) doesn't mint
    // a spurious version. Both sides run through normalizeConfig so empty
    // skillIds/env the UI always sends canonicalize away and diff equal.
    if (JSON.stringify(merged) !== JSON.stringify(normalizeConfig(current.config))) {
      current = await applyNewVersion(deps, current, merged);
    }

    return c.json({ agent: toPublic(current) });
  });

  // List an agent's config versions (newest first). Org-scoped + visibility via the agent.
  app.get("/agents/:id/versions", requireScope("read"), async (c) => {
    const record = await getAgent(c.req.param("id"));
    if (!record || !canView(c.var.principal, record)) return c.json({ error: "not found" }, 404);
    const versions = await listVersions(record.id);
    // Each version is a full config SNAPSHOT, so it carries `env` too - redact the
    // values for a non-writer, exactly as publicAgentFor does for the live config
    // (else the history would be a way around that redaction).
    if (!canWrite(c.var.principal, record)) {
      return c.json({
        versions: versions.map((v) =>
          v.config.env ? { ...v, config: { ...v.config, env: redactEnvValues(v.config.env) } } : v,
        ),
      });
    }
    return c.json({ versions });
  });

  // Restore a prior version: append its config as a NEW version (linear history,
  // so "latest = live" is never ambiguous). Same apply path as a PATCH.
  app.post("/agents/:id/versions/:version/restore", requireScope("write"), async (c) => {
    const auth = authorize(c.var.principal, await getAgent(c.req.param("id")), "write", "you can't edit this shared agent");
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    const agent = auth.record;
    const target = Number(c.req.param("version"));
    const versions = await listVersions(agent.id);
    const source = versions.find((v) => v.version === target);
    if (!source) return c.json({ error: "version not found" }, 404);
    const updated = await applyNewVersion(deps, agent, source.config, `restored from v${target}`);
    return c.json({ agent: toPublic(updated) });
  });

  // Past runs, newest first - the durable run history behind the Monitor tab's run
  // list. Reads the retained session-summary rows (one per runtime lifetime), so this
  // works for runs far older than the trajectory table's 30-day TTL.
  app.get("/agents/:id/runs", requireScope("read"), async (c) => {
    const record = await getAgent(c.req.param("id"));
    if (!record || !canView(c.var.principal, record)) return c.json({ error: "not found" }, 404);
    // Truncate: a fractional Limit is a DynamoDB validation error, and clamping alone
    // would forward `?limit=1.5` verbatim.
    const asked = Math.trunc(Number(c.req.query("limit"))) || DEFAULT_RUN_LIMIT;
    const limit = Math.min(Math.max(asked, 1), MAX_RUN_LIMIT);
    const runs: AgentRun[] = (await listRuns(record.id, limit)).map(runFor);
    const res: AgentRunsResponse = { runs };
    return c.json(res);
  });

  // One past run's trajectory, keyed by the `runId` the run list returns - NOT by
  // sessionId, which a client may reuse across runs. Reads the trajectory table first
  // (the hot store) and falls back to the S3 archive once the TTL has expired those
  // rows; `archived` tells the client which it got, so a run older than the archive can
  // say its steps are gone instead of rendering as an empty run.
  app.get("/agents/:id/runs/:runId", requireScope("read"), async (c) => {
    const record = await getAgent(c.req.param("id"));
    if (!record || !canView(c.var.principal, record)) return c.json({ error: "not found" }, 404);
    const runId = c.req.param("runId");
    // Resolve the run within THIS agent - so an unknown run is a 404 rather than an
    // empty trace, and the id used below is one we wrote, not one the caller invented.
    const run = await getRun(record.id, runId);
    if (!run) return c.json({ error: "not found" }, 404);
    // readEvents, not readSession: this is a finished run, so we want the events
    // without deriving status or writing a synthetic terminal event. Scoped to THIS
    // run - a reused sessionId holds several runs in one partition.
    const live = await readEvents(record.id, run.sessionId, undefined, runId);
    if (live.length > 0) {
      return c.json(traceOf(runId, run.sessionId, live, false));
    }
    const archived = await readArchivedTrace(record.id, runId);
    return c.json(traceOf(runId, run.sessionId, archived ?? [], archived !== null));
  });

  // Operational metrics for an agent, aggregated over a window. `?hours=N`
  // (default 24, max 1 year) sets the window; granularity is hourly for windows
  // up to 7 days and daily above (so long windows don't return thousands of
  // buckets). `?version=N` scopes to one config version. Owner-scoped.
  app.get("/agents/:id/metrics", requireScope("read"), async (c) => {
    const record = await getAgent(c.req.param("id"));
    if (!record || !canView(c.var.principal, record)) return c.json({ error: "not found" }, 404);
    const hours = Math.min(Math.max(Number(c.req.query("hours")) || 24, 1), 24 * 365);
    const versionParam = c.req.query("version");
    // Reject a non-numeric version rather than coercing it: `?version=abc` becomes
    // NaN, which matches no session, so the dashboard would confidently render
    // all-zeros for a filter the caller mistyped.
    const version = versionParam !== undefined && versionParam !== "" ? Number(versionParam) : null;
    if (version !== null && !Number.isInteger(version)) {
      return c.json({ error: "version must be an integer" }, 400);
    }
    const granularity = hours <= 24 * 7 ? "hour" : "day";
    const to = new Date();
    const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
    const summary = await metricsFor(record.id, from.toISOString(), to.toISOString(), granularity, version);
    return c.json(summary);
  });

  // Rotate the API key. Returns the new plaintext once.
  app.post("/agents/:id/rotate-key", requireScope("write"), async (c) => {
    const auth = authorize(c.var.principal, await getAgent(c.req.param("id")), "write", "you can't rotate this agent's key");
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    const { apiKey, hash } = generateApiKey();
    // Only the hash is stored - the plaintext is returned once, here, and never persisted.
    await updateAgent(auth.record.id, { apiKeyHash: hash });
    const res: RotateKeyResponse = { apiKey };
    return c.json(res);
  });

  // ---- Skills (org-scoped, reusable across agents) ------------------------
  // A skill is a named Markdown doc attachable to many agents. Agents store only
  // skill ids, so editing a skill updates every agent that uses it next session.
  // Read/write gated by the resource scopes; per-resource visibility by shared.
  app.post("/skills", requireScope("write"), async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = parseSkillBody(raw);
    if (!parsed.ok) return c.json({ error: "invalid skill", details: parsed.errors }, 400);
    // Names are unique per ORG: agents reference skills, and two skills sharing a
    // name would be ambiguous to pick + collide as Strands skill names at runtime.
    if (await nameTaken(c.var.principal.orgId, parsed.name, null)) {
      return c.json({ error: `your org already has a skill named "${parsed.name}"` }, 409);
    }
    const now = new Date().toISOString();
    const managers = await resolveManagers(raw, c.var.principal.orgId, c.var.principal.userId);
    const record: SkillRecord = {
      id: uuidv7(),
      orgId: c.var.principal.orgId,
      createdBy: c.var.principal.userId,
      shared: parseShared(raw),
      ...(managers ? { managers } : {}),
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      createdAt: now,
      updatedAt: now,
    };
    await putSkill(record);
    return c.json({ skill: record }, 201);
  });

  app.get("/skills", requireScope("read"), async (c) => {
    const [skills, agents] = await Promise.all([
      listSkills(c.var.principal.orgId),
      listAgentsByOrg(c.var.principal.orgId),
    ]);
    // Visible = shared + the caller's own private ones. Newest first (UUIDv7 ids
    // sort chronologically), with the usage count over the agents the caller can SEE -
    // counting all of the org's would tell a viewer how many co-members' PRIVATE agents
    // use this skill, which is a fact about resources they can't see.
    const visibleAgents = agents.filter((a) => canView(c.var.principal, a));
    const withCounts = skills
      .filter((s) => canView(c.var.principal, s))
      .map((s) => ({ ...s, usedByAgentCount: countAgentsUsingSkill(visibleAgents, s.id) }))
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    return c.json({ skills: withCounts });
  });

  app.get("/skills/:id", requireScope("read"), async (c) => {
    const skill = await getSkill(c.var.principal.orgId, c.req.param("id"));
    if (!skill || !canView(c.var.principal, skill)) return c.json({ error: "not found" }, 404);
    // Counted over the agents the caller can SEE (see the list route).
    const agents = (await listAgentsByOrg(c.var.principal.orgId)).filter((a) => canView(c.var.principal, a));
    return c.json({ skill: { ...skill, usedByAgentCount: countAgentsUsingSkill(agents, skill.id) } });
  });

  app.patch("/skills/:id", requireScope("write"), async (c) => {
    const auth = authorize(c.var.principal, await getSkill(c.var.principal.orgId, c.req.param("id")), "write", "you can't edit this shared skill");
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    const existing = auth.record;
    const raw = await c.req.json().catch(() => null);
    const parsed = parseSkillBody(raw);
    if (!parsed.ok) return c.json({ error: "invalid skill", details: parsed.errors }, 400);
    // Renaming to another skill's name is a collision (excluding this one).
    if (await nameTaken(c.var.principal.orgId, parsed.name, existing.id)) {
      return c.json({ error: `your org already has a skill named "${parsed.name}"` }, 409);
    }
    const managers = await patchManagers(c.var.principal, raw, existing);
    // Destructure the old managers out of the spread so the key is simply absent
    // when cleared (mirrors the integration PATCH; no post-hoc delete needed).
    const { managers: _priorManagers, ...base } = existing;
    const updated: SkillRecord = {
      ...base,
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      // `shared` is metadata; flip it when the body carries it, else keep as-is.
      shared: patchShared(raw, existing.shared),
      // Re-resolve managers when the body carries the field; drop the key when empty.
      ...(managers ? { managers } : {}),
      updatedAt: new Date().toISOString(),
    };
    await putSkill(updated);
    return c.json({ skill: updated });
  });

  // Delete a skill. Detaching it from agents is left to the user (a dangling id
  // is simply skipped at resolve time) - we surface the usage count in the UI so
  // they can decide. Deleting doesn't bump agent versions.
  app.delete("/skills/:id", requireScope("delete"), async (c) => {
    const auth = authorize(c.var.principal, await getSkill(c.var.principal.orgId, c.req.param("id")), "write", "you can't delete this shared skill");
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    await deleteSkill(c.var.principal.orgId, auth.record.id);
    return c.body(null, 204);
  });

  // ---- Integrations (org-scoped, reusable across agents) ----------------
  // An integration is a downstream API + credential the user onboards once and
  // attaches to many agents by id (config.integrationIds). The agent never sees
  // the secret: it calls the proxy (below), which holds the credential, checks the
  // session token's grant, and forwards to baseUrl. The credential is write-only -
  // toPublicIntegration strips it on every read. Read/write gated by the agents
  // scopes (integrations are part of agent authoring, like skills).
  app.post("/integrations", requireScope("write"), async (c) => {
    const parsed = parseIntegrationBody(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: "invalid integration", details: parsed.errors }, 400);
    // Names are unique per ORG: agents reference integrations, and two sharing a
    // name would be ambiguous to pick + confusing in the model's discovery view.
    if (await integrationNameTaken(c.var.principal.orgId, parsed.value.name, null)) {
      return c.json({ error: `your org already has an integration named "${parsed.value.name}"` }, 409);
    }
    // Operations come from discovery (fetch + parse the spec now) or the manual list.
    const ops = await resolveOperations(parsed.value, undefined);
    if ("error" in ops) return c.json({ error: ops.error }, 400);
    const now = new Date().toISOString();
    const managers = await resolveManagers(parsed.value, c.var.principal.orgId, c.var.principal.userId);
    const record: IntegrationRecord = {
      id: uuidv7(),
      orgId: c.var.principal.orgId,
      createdBy: c.var.principal.userId,
      shared: parsed.value.shared !== false,
      ...(managers ? { managers } : {}),
      name: parsed.value.name,
      description: parsed.value.description,
      baseUrl: parsed.value.baseUrl,
      auth: parsed.value.auth,
      operations: ops.operations,
      createdAt: now,
      updatedAt: now,
      ...(ops.discovery ? { discovery: ops.discovery } : {}),
      ...(parsed.value.secret ? { secret: parsed.value.secret } : {}),
    };
    await putIntegration(record);
    return c.json({ integration: toPublicIntegration(record) }, 201);
  });

  // Preview a discovery URL WITHOUT saving: fetch + parse the spec and return the
  // full operation catalog (all enabled) so the editor can render the pick-a-subset
  // UI before the user commits. The spec is often gated by the integration's own
  // credential, so the body carries `auth` + `secret` (+ `baseUrl`) and the fetch
  // authenticates with it (falling back to the stored secret when editing an existing
  // integration without re-entering it). The credential is only attached when the spec
  // URL is under the integration's `baseUrl` origin - since the secret is write-only
  // and the URL is caller-chosen, this stops a caller from aiming the credentialed
  // fetch at their own host to read the secret out of the outbound header (the same
  // exfil anchor `resolveOperations` applies on save). Nearly stateless.
  app.post("/integrations/discover", requireScope("write"), async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { url?: unknown; auth?: unknown; secret?: unknown; integrationId?: unknown; baseUrl?: unknown }
      | null;
    const url = typeof body?.url === "string" ? validateOutboundUrl(body.url.trim()) : null;
    if (!url) return c.json({ error: "url must be a valid https URL" }, 400);
    // auth is optional (a public spec needs none); if present it must be valid.
    let cred: { auth: IntegrationAuth; secret: string | undefined } | undefined;
    if (body?.auth !== undefined) {
      const auth = parseAuth(body.auth);
      if (!auth) return c.json({ error: "invalid auth" }, 400);
      const inlineSecret = typeof body.secret === "string" && body.secret ? body.secret : undefined;
      if (inlineSecret) {
        // The caller supplied their own secret, so they hold it - honor their auth
        // (incl. tokenUrl), anchored to the entered baseUrl so the spec fetch can't be
        // aimed off-host.
        const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : undefined;
        cred = baseUrl ? credentialForSpec(url, baseUrl, auth, inlineSecret) : { auth, secret: undefined };
      } else if (typeof body.integrationId === "string") {
        // Reusing a STORED secret the caller may not know: the caller must NOT get to
        // redirect where it's sent. Use the stored record's OWN auth + baseUrl entirely
        // (ignore the request-body auth/tokenUrl), and only if the spec is under its base.
        // This closes the tokenUrl-exfil parallel to the PATCH sink guard.
        const stored = await getIntegration(c.var.principal.orgId, body.integrationId);
        // Only reuse a stored secret the caller can actually see (their own private,
        // or a shared integration) - never a co-member's private credential.
        if (stored?.secret && canView(c.var.principal, stored)) {
          cred = credentialForSpec(url, stored.baseUrl, stored.auth, stored.secret);
        }
      }
      // else: auth given but no secret available → fetch unauthenticated (cred stays undefined).
    }
    const synced = await syncDiscovery(url, undefined, undefined, new Date().toISOString(), cred);
    if ("error" in synced) return c.json({ error: synced.error }, 502);
    return c.json({ provider: synced.discovery.provider, operations: synced.discovery.operations });
  });

  app.get("/integrations", requireScope("read"), async (c) => {
    const [integrations, agents] = await Promise.all([
      listIntegrations(c.var.principal.orgId),
      listAgentsByOrg(c.var.principal.orgId),
    ]);
    // Visible = shared + the caller's own private. Newest first, with the usage count
    // over the agents the caller can SEE (see the skills list route for why).
    const visibleAgents = agents.filter((a) => canView(c.var.principal, a));
    const withCounts = integrations
      .filter((i) => canView(c.var.principal, i))
      .map((i) => ({ ...toPublicIntegration(i), usedByAgentCount: countAgentsUsingIntegration(visibleAgents, i.id) }))
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    return c.json({ integrations: withCounts });
  });

  app.get("/integrations/:id", requireScope("read"), async (c) => {
    const integration = await getIntegration(c.var.principal.orgId, c.req.param("id"));
    if (!integration || !canView(c.var.principal, integration)) return c.json({ error: "not found" }, 404);
    // Counted over the agents the caller can SEE (see the skills list route).
    const agents = (await listAgentsByOrg(c.var.principal.orgId)).filter((a) => canView(c.var.principal, a));
    const usedByAgentCount = countAgentsUsingIntegration(agents, integration.id);
    return c.json({ integration: { ...toPublicIntegration(integration), usedByAgentCount } });
  });

  app.patch("/integrations/:id", requireScope("write"), async (c) => {
    const auth = authorize(c.var.principal, await getIntegration(c.var.principal.orgId, c.req.param("id")), "write", "you can't edit this shared integration");
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    const prior = auth.record;
    const parsed = parseIntegrationBody(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: "invalid integration", details: parsed.errors }, 400);
    if (await integrationNameTaken(c.var.principal.orgId, parsed.value.name, prior.id)) {
      return c.json({ error: `your org already has an integration named "${parsed.value.name}"` }, 409);
    }
    // Root-cause exfil guard: the write-only `secret` is preserved when the caller omits
    // it, but the URLs it's sent to (`baseUrl`, and `tokenUrl` for oauth2Client) are
    // caller-supplied. Moving any credential sink to a new ORIGIN while keeping the stored
    // secret would ship that secret to the new host - via the proxy forward, the discovery
    // fetch, or the OAuth mint. So a sink-origin change requires re-entering the secret
    // (proving the caller holds it), which an attacker who only knows `hasSecret` cannot do.
    if (prior.secret && !parsed.value.secret) {
      const before = new Set(credentialSinkOrigins(prior.baseUrl, prior.auth));
      const after = credentialSinkOrigins(parsed.value.baseUrl, parsed.value.auth);
      if (after.some((o) => !before.has(o))) {
        return c.json(
          { error: "changing the base URL or token URL to a different origin requires re-entering the credential" },
          400,
        );
      }
    }
    const ops = await resolveOperations(parsed.value, prior);
    if ("error" in ops) return c.json({ error: ops.error }, 400);
    // secret is write-only + optional: omitting it leaves the stored credential
    // untouched (so the UI can edit metadata without re-entering the secret).
    // `discovery` is replaced (or dropped when switching to manual), never merged.
    const { discovery: _priorDiscovery, managers: _priorManagers, ...base } = prior;
    const managers = await patchManagers(c.var.principal, parsed.value, prior);
    const updated: IntegrationRecord = {
      ...base,
      name: parsed.value.name,
      description: parsed.value.description,
      baseUrl: parsed.value.baseUrl,
      auth: parsed.value.auth,
      operations: ops.operations,
      // `shared` is metadata: flip it when the body carries it, else keep as-is.
      shared: parsed.value.shared ?? prior.shared,
      // Re-resolve managers when the body carries the field; else keep prior (base
      // dropped it above so the key is absent when empty).
      ...(managers ? { managers } : {}),
      updatedAt: new Date().toISOString(),
      ...(ops.discovery ? { discovery: ops.discovery } : {}),
      ...(parsed.value.secret ? { secret: parsed.value.secret } : {}),
    };
    await putIntegration(updated);
    return c.json({ integration: toPublicIntegration(updated) });
  });

  // Refresh a discovered integration's catalog: re-fetch the spec and reconcile
  // against the stored selection (kept enabled flags win; a newly-appeared op
  // defaults OFF, so an evolving API never silently grants the agent a capability).
  // The daily sweep (discovery-sweep-lambda.ts) shares the same `refreshDiscovery`
  // primitive per integration (in-process, not via this HTTP route).
  app.post("/integrations/:id/refresh", requireScope("write"), async (c) => {
    const auth = authorize(c.var.principal, await getIntegration(c.var.principal.orgId, c.req.param("id")), "write", "you can't refresh this shared integration");
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    const rec = auth.record;
    if (!rec.discovery) {
      return c.json({ error: "this integration has no discovery URL to refresh (it's manually authored)" }, 400);
    }
    // The spec URL we're about to fetch, and the one the write conditions on.
    const specUrl = rec.discovery.url;
    // Anchor the credential to baseUrl even on refresh: a stored discovery.url could be
    // off-base (validation SSRF-checks it but doesn't bind it to baseUrl), and we must
    // not send the write-only secret to an off-base host on the automated path.
    const synced = await refreshDiscovery(
      rec.discovery,
      new Date().toISOString(),
      credentialForSpec(specUrl, rec.baseUrl, rec.auth, rec.secret),
    );
    if ("error" in synced) return c.json({ error: synced.error }, 502);
    // Update only the discovery-owned fields (never a whole-item Put): the spec fetch
    // above is slow, and a PATCH landing in that window must not be reverted by a
    // write built from this stale read - which would take `secret`, `shared`, and
    // `managers` back with it. Conditioned on the spec URL, so a refresh whose
    // integration was re-pointed meanwhile is dropped rather than applied.
    const landed = await updateDiscoveryResult(rec.orgId, rec.id, specUrl, {
      operations: synced.operations,
      discovery: synced.discovery,
      updatedAt: synced.discovery.syncedAt,
    });
    if (!landed) {
      return c.json({ error: "this integration's discovery URL changed while refreshing - reload and try again" }, 409);
    }
    const refreshed: IntegrationRecord = {
      ...rec,
      operations: synced.operations,
      discovery: synced.discovery,
      updatedAt: synced.discovery.syncedAt,
    };
    return c.json({ integration: toPublicIntegration(refreshed) });
  });

  // Delete an integration. Detaching it from agents is left to the user (a
  // dangling id is skipped at resolve time); we surface the usage count in the UI.
  // `delete` scope: this also destroys the write-only credential, which no endpoint
  // can read back.
  app.delete("/integrations/:id", requireScope("delete"), async (c) => {
    const auth = authorize(c.var.principal, await getIntegration(c.var.principal.orgId, c.req.param("id")), "write", "you can't delete this shared integration");
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    await deleteIntegration(c.var.principal.orgId, auth.record.id);
    return c.body(null, 204);
  });

  // ---- Personal Access Tokens (JWT-only) ----------------------------------
  // Users mint PATs so a coding assistant can call the management API on their
  // behalf. Guarded by requireUser: a PAT can't manage tokens (mint more or
  // escalate its own scopes) - only an interactive login can. Scoped to the
  // caller's own tokens.
  app.post("/tokens", requireUser, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; scopes?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    if (name.length > 100) return c.json({ error: "name too long" }, 400);
    // Validate scopes against the known set; reject unknowns rather than silently
    // dropping them (a client asking for a scope we don't grant should know).
    if (!Array.isArray(body?.scopes) || body.scopes.length === 0) {
      return c.json({ error: "scopes must be a non-empty array" }, 400);
    }
    const scopes = body.scopes;
    if (!scopes.every((s): s is Scope => typeof s === "string" && isScope(s))) {
      return c.json({ error: "scopes contains an unknown scope" }, 400);
    }
    // Can't stamp a scope your role lacks. The per-request intersection already makes
    // such a token inert; this stops a later promotion from silently arming it. See
    // docs/auth.md.
    const mine = new Set(scopesForRole(c.var.principal.role));
    const beyond = [...new Set(scopes)].filter((s) => !mine.has(s));
    if (beyond.length > 0) {
      return c.json(
        { error: `your role (${c.var.principal.role}) can't grant: ${beyond.join(", ")}` },
        403,
      );
    }

    const { token, hash } = generateAccessToken();
    const record: TokenRecord = {
      tokenHash: hash,
      id: uuidv7(),
      ownerId: c.var.principal.userId,
      // A PAT is bound to ONE org: the caller's active org at mint time. Its
      // authority is later intersected with the owner's role in that org.
      orgId: c.var.principal.orgId,
      name,
      scopes: [...new Set(scopes)], // de-dupe
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    await putToken(record);
    const res: CreateAccessTokenResponse = { accessToken: toPublicToken(record), token };
    return c.json(res, 201);
  });

  app.get("/tokens", requireUser, async (c) => {
    const tokens = await listTokensByOwner(c.var.principal.userId);
    // Newest first (UUIDv7 ids sort chronologically).
    tokens.sort((a, b) => (a.id < b.id ? 1 : -1));
    return c.json({ tokens: tokens.map(toPublicToken) });
  });

  app.delete("/tokens/:id", requireUser, async (c) => {
    const deleted = await deleteTokenById(c.var.principal.userId, c.req.param("id"));
    if (!deleted) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });

  // ---- Org model: identity, orgs, members, invites -----------------------
  // requireAuth already ran (bootstrapping the personal org + resolving the active
  // org + role). Management actions (rename/delete org, members, invites) add
  // requireOrgRole("admin") + requireUser (JWT-only, like token management).

  /**
   * Middleware gating an org route by the caller's role IN THE :id ORG (which may
   * differ from their active-org header - these routes name the org in the path).
   * "member" means any role; "admin" means admin. Non-members get 404 (don't leak
   * that the org exists); insufficient role gets 403. Sets no state - handlers
   * re-read membership if they need the role.
   */
  function requireOrgRole(min: "member" | "admin"): MiddlewareHandler<Env> {
    return async (c, next) => {
      const orgId = c.req.param("id") ?? "";
      const membership = await getMembership(orgId, c.var.principal.userId);
      if (!membership) return c.json({ error: "not found" }, 404);
      if (min === "admin" && membership.role !== "admin") {
        return c.json({ error: "this action requires the admin role" }, 403);
      }
      return next();
    };
  }

  /**
   * A member shaped for the wire, with their email resolved.
   *
   * The membership row caches the email, written either by the member's own self-heal
   * (auth.ts, from their verified token claim) or by this backfill - the self-heal wins,
   * by condition. A member who has never signed in has no cached email, so we ask the
   * identity store and write the answer back: one lookup per member ONCE IT RESOLVES.
   * The store may not know (deleted user, throttling), and that case caches nothing, so
   * it's re-asked on the next read. See docs/auth.md.
   */
  async function withEmail(m: Membership): Promise<Member> {
    const base: Member = { userId: m.userId, role: m.role, joinedAt: m.joinedAt };
    if (m.email) return { ...base, email: m.email };
    // `.catch` here, not only inside the provider: a label is cosmetic, so ONE member
    // the identity store can't resolve must never 500 the whole roster. Relying on the
    // provider to swallow made that invariant depend on the implementation.
    const email = await deps.identity.emailFor(m.userId).catch(() => undefined);
    if (!email) return base; // unknown (local dev, or a deleted user) - show the id
    // Narrow conditional write, NOT a whole-item Put of the row we read before the
    // lookup: that would revert a role change made during it, and recreate a
    // membership a concurrent DELETE had just removed - restoring access to someone
    // who was removed. See backfillMembershipEmail.
    // `.catch` is not optional on a floating promise: backfillMembershipEmail
    // rethrows anything that isn't a lost condition (throttling, 5xx), and an
    // unhandled rejection takes down the Lambda execution environment - after the
    // response, so it would surface as a 502 on someone else's next request. Log it:
    // a permanently failing backfill is otherwise invisible.
    void backfillMembershipEmail(m.orgId, m.userId, email).catch((e) =>
      console.error("email backfill failed", m.orgId, m.userId, e),
    );
    return { ...base, email };
  }

  /**
   * Find another admin of `orgId` besides `exceptUserId` - the WITNESS that keeps
   * the last-admin invariant true when we demote/remove that user. Null means
   * they're the only admin, so the change must be refused.
   *
   * The returned userId is passed to `demoteAdminIfWitnessRemains`, which applies
   * the change only while the witness is *still* an admin - so a concurrent
   * request demoting the witness can't team up with this one to leave the org with
   * zero admins (a state no API route could repair, since they all need an admin).
   */
  async function otherAdmin(orgId: string, exceptUserId: string): Promise<string | null> {
    const members = await listMembersByOrg(orgId);
    return members.find((m) => m.role === "admin" && m.userId !== exceptUserId)?.userId ?? null;
  }

  /**
   * True when a last-admin write lost its race: the witness admin we conditioned on
   * stopped being an admin between our read and our write, so the transaction was
   * cancelled. The caller re-reads, which is the honest outcome - by then this user
   * may genuinely be the last admin, and the retry gets the 400.
   */
  function isWitnessLost(e: unknown): boolean {
    return typeof e === "object" && e !== null && (e as { name?: string }).name === "TransactionCanceledException";
  }
  const LAST_ADMIN_CONFLICT = "the org's admins changed while you were editing - reload and try again";


  /** Assemble the caller's org memberships into the OrgMembership[] shape. */
  async function myOrgs(userId: string): Promise<OrgMembership[]> {
    const memberships = await listMembershipsByUser(userId);
    const orgs = await Promise.all(
      memberships.map(async (m) => {
        const org = await getOrg(m.orgId);
        return org ? ({ orgId: org.orgId, name: org.name, kind: org.kind, role: m.role } as OrgMembership) : null;
      }),
    );
    return orgs.filter((o): o is OrgMembership => o !== null);
  }

  // Bootstrap/identity: who am I, which orgs am I in, which is active. requireAuth
  // has already ensured the personal org + membership exist, so this always returns
  // at least the personal org.
  app.get("/me", async (c) => {
    const p = c.var.principal;
    const res: Me = {
      userId: p.userId,
      email: p.email,
      orgs: await myOrgs(p.userId),
      activeOrgId: p.orgId,
    };
    return c.json(res);
  });

  // Create a team org: the creator becomes its admin. Any authenticated user can.
  app.post("/orgs", requireUser, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    if (name.length > 100) return c.json({ error: "name too long" }, 400);
    const now = new Date().toISOString();
    const orgId = `org_${uuidv7()}`;
    const org: Org = { orgId, name, kind: "team", createdBy: c.var.principal.userId, createdAt: now };
    await putOrg(org);
    await putMembership({
      orgId,
      userId: c.var.principal.userId,
      role: "admin",
      joinedAt: now,
      ...(c.var.principal.email ? { email: c.var.principal.email } : {}),
    });
    return c.json({ org }, 201);
  });

  // Rename an org (admin only, JWT only). Personal orgs can be renamed too.
  app.patch("/orgs/:id", requireUser, requireOrgRole("admin"), async (c) => {
    const orgId = c.req.param("id");
    const org = await getOrg(orgId);
    if (!org) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    if (name.length > 100) return c.json({ error: "name too long" }, 400);
    const updated: Org = { ...org, name };
    await putOrg(updated);
    return c.json({ org: updated });
  });

  // Delete a TEAM org + cascade (agents/skills/integrations/schedules/memberships/
  // invites). A personal org can never be deleted. Admin + JWT only.
  app.delete("/orgs/:id", requireUser, requireOrgRole("admin"), async (c) => {
    const orgId = c.req.param("id");
    const org = await getOrg(orgId);
    if (!org) return c.json({ error: "not found" }, 404);
    if (org.kind === "personal") return c.json({ error: "a personal org can't be deleted" }, 400);
    // Cascade: tear down every resource in the org. Agents also drop their schedule.
    const agents = await listAgentsByOrg(orgId);
    for (const a of agents) {
      await deps.scheduler.remove(a.id).catch((e) => console.error("schedule teardown failed", a.id, e));
      await deleteAgent(a.id);
    }
    for (const s of await listSkills(orgId)) await deleteSkill(orgId, s.id);
    for (const i of await listIntegrations(orgId)) await deleteIntegration(orgId, i.id);
    for (const m of await listMembersByOrg(orgId)) await deleteMembership(orgId, m.userId);
    for (const inv of await listInvitesByOrg(orgId)) await deleteInvite(inv.email, orgId);
    await deleteOrg(orgId);
    return c.body(null, 204);
  });

  // List members of an org (any member can see the roster). Scope-gated like every
  // other read: `requireScope("read")` is the "can this credential read anything at
  // all?" gate, and a PAT whose effective set is empty (stamped `write`, owner since
  // demoted to viewer → write ∩ read = ∅) must not be an exception to it.
  //
  // NOTE the deliberate breadth: `requireOrgRole` re-reads membership for the PATH
  // org, so a member can read the roster of any org they belong to - including one
  // their PAT isn't bound to. That's inherent to naming the org in the path (the same
  // property the org-management routes rely on), and it exposes only the caller's own
  // orgs' membership; see docs/auth.md.
  app.get("/orgs/:id/members", requireScope("read"), requireOrgRole("member"), async (c) => {
    const members = await listMembersByOrg(c.req.param("id"));
    const shaped: Member[] = await Promise.all(members.map((m) => withEmail(m)));
    return c.json({ members: shaped });
  });

  // Change a member's role (admin + JWT). Guards: the target must be a member, and
  // you can't demote the LAST admin (an org must always have at least one).
  app.patch("/orgs/:id/members/:userId", requireUser, requireOrgRole("admin"), async (c) => {
    const orgId = c.req.param("id");
    const targetUserId = c.req.param("userId");
    const body = (await c.req.json().catch(() => null)) as { role?: unknown } | null;
    const role = typeof body?.role === "string" && isRole(body.role) ? body.role : null;
    if (!role) return c.json({ error: "role must be admin|editor|viewer" }, 400);
    const target = await getMembership(orgId, targetUserId);
    if (!target) return c.json({ error: "not a member" }, 404);
    const updated: Membership = { ...target, role };
    // Demoting the last admin would orphan the org - refuse. Losing the admin
    // count is a race, so the write is conditional on a witness admin surviving.
    if (target.role === "admin" && role !== "admin") {
      const witness = await otherAdmin(orgId, targetUserId);
      if (!witness) return c.json({ error: "an org must keep at least one admin" }, 400);
      try {
        await demoteAdminIfWitnessRemains(orgId, target, updated, witness);
      } catch (e) {
        if (!isWitnessLost(e)) throw e;
        return c.json({ error: LAST_ADMIN_CONFLICT }, 409);
      }
    } else if (!(await updateMembershipRole(orgId, targetUserId, role))) {
      // The membership was removed while we were deciding - report it as gone rather
      // than re-creating the row (which would restore the removed member's access).
      return c.json({ error: "not a member" }, 404);
    }
    // Annotated `Member` on purpose: this projection and the roster's must not
    // diverge, and an inline literal let `email` silently go missing here.
    const member: Member = {
      userId: updated.userId,
      role: updated.role,
      joinedAt: updated.joinedAt,
      ...(updated.email ? { email: updated.email } : {}),
    };
    return c.json({ member });
  });

  /**
   * Strip a departing user from every `managers` list in the org.
   *
   * A manager grant names a userId, and nothing re-validates it against current
   * membership at read time - so without this, removing someone leaves a live grant
   * behind: re-add them later as a mere EDITOR and they silently regain write on
   * resources they were never re-granted. (While they're out they can't act at all -
   * `resolveRole` 403s every request - and a re-added VIEWER lacks the `write`
   * scope; the editor case is the real hole.)
   *
   * Revoking on removal rather than filtering on read keeps the stored ACL the
   * truth, and matches how the org-delete cascade already tears down state.
   */
  async function revokeManagerGrants(orgId: string, userId: string): Promise<void> {
    const [agents, skills, integrations] = await Promise.all([
      listAgentsByOrg(orgId),
      listSkills(orgId),
      listIntegrations(orgId),
    ]);
    const without = (managers: string[]) => managers.filter((m) => m !== userId);
    await Promise.all([
      ...agents
        .filter((a) => a.managers?.includes(userId))
        .map((a) => updateAgent(a.id, { managers: without(a.managers!).length ? without(a.managers!) : null })),
      ...skills
        .filter((s) => s.managers?.includes(userId))
        .map((s) => putSkill({ ...s, managers: dropEmpty(without(s.managers!)) })),
      ...integrations
        .filter((i) => i.managers?.includes(userId))
        .map((i) => putIntegration({ ...i, managers: dropEmpty(without(i.managers!)) })),
    ]);
  }

  /** An empty managers list is stored as absent (== "creator + admins only"). */
  function dropEmpty(managers: string[]): string[] | undefined {
    return managers.length ? managers : undefined;
  }

  // Remove a member (admin + JWT). Can't remove the last admin; removing yourself
  // is allowed (unless you're the last admin). Their PATs bound to this org die
  // (auth re-checks membership each request). Their manager grants are revoked too.
  app.delete("/orgs/:id/members/:userId", requireUser, requireOrgRole("admin"), async (c) => {
    const orgId = c.req.param("id");
    const targetUserId = c.req.param("userId");
    const target = await getMembership(orgId, targetUserId);
    if (!target) return c.json({ error: "not a member" }, 404);
    if (target.role === "admin") {
      const witness = await otherAdmin(orgId, targetUserId);
      if (!witness) return c.json({ error: "an org must keep at least one admin" }, 400);
      try {
        await demoteAdminIfWitnessRemains(orgId, target, "delete", witness);
      } catch (e) {
        if (!isWitnessLost(e)) throw e;
        return c.json({ error: LAST_ADMIN_CONFLICT }, 409);
      }
    } else {
      await deleteMembership(orgId, targetUserId);
    }
    await revokeManagerGrants(orgId, targetUserId);
    return c.body(null, 204);
  });

  // Invite someone by email to an org (admin + JWT). One pending invite per
  // (email, org). Inviting someone who is ALREADY a member is a 409: accept()
  // overwrites the membership's role, so allowing it would turn an invite into a
  // silent role change - and would route around the last-admin guard on
  // PATCH /orgs/:id/members/:userId (invite the sole admin as viewer → they accept
  // → the org has no admins). Role changes go through that route, which enforces
  // the invariant.
  app.post("/orgs/:id/invites", requireUser, requireOrgRole("admin"), async (c) => {
    const orgId = c.req.param("id");
    const org = await getOrg(orgId);
    if (!org) return c.json({ error: "not found" }, 404);
    if (org.kind === "personal") return c.json({ error: "a personal org can't have members" }, 400);
    const body = (await c.req.json().catch(() => null)) as { email?: unknown; role?: unknown } | null;
    const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
    if (!email || !email.includes("@")) return c.json({ error: "a valid email is required" }, 400);
    const role = typeof body?.role === "string" && isRole(body.role) ? body.role : null;
    if (!role) return c.json({ error: "role must be admin|editor|viewer" }, 400);
    // Already a member (matched on the email captured at join)? Refuse - use the
    // member-role route to change a role.
    const members = await listMembersByOrg(orgId);
    if (members.some((m) => m.email && normalizeEmail(m.email) === email)) {
      return c.json({ error: "that email is already a member of this org - change their role instead" }, 409);
    }
    // Lazily provision a login: a brand-new email gets a Cognito account + the
    // temp-password invite email; an existing user is a no-op (see ensureUser).
    // So the invitee can actually sign in and accept - the invite row alone can't
    // be claimed by someone with no way to log in. Idempotent, so re-inviting is safe.
    // The outcome is deliberately NOT returned: "created" vs "exists" is a Cognito
    // user-existence oracle, at the app layer, on a caller-chosen email - re-opening what
    // the pool's `preventUserExistenceErrors` closes. Nothing consumed it.
    await deps.identity.ensureUser(email);
    const now = new Date().toISOString();
    const invite: Invite = { email, orgId, orgName: org.name, role, invitedBy: c.var.principal.userId, createdAt: now };
    await putInvite(invite);
    return c.json({ invite }, 201);
  });

  // List an org's pending invites (admin + JWT).
  app.get("/orgs/:id/invites", requireUser, requireOrgRole("admin"), async (c) => {
    const invites = await listInvitesByOrg(c.req.param("id"));
    return c.json({ invites });
  });

  // Rescind a pending invite (admin + JWT).
  app.delete("/orgs/:id/invites/:email", requireUser, requireOrgRole("admin"), async (c) => {
    await deleteInvite(c.req.param("email"), c.req.param("id"));
    return c.body(null, 204);
  });

  // My pending invites, matched to my verified email. JWT-only: an invite is
  // matched by the interactive login's email claim (a PAT carries no email, and a
  // coding assistant shouldn't be joining orgs on the user's behalf) - same
  // reasoning as token management being interactive-only.
  app.get("/invites", requireUser, async (c) => {
    const email = c.var.principal.email;
    if (!email) return c.json({ invites: [] }); // no verified email → nothing to match
    return c.json({ invites: await listInvitesByEmail(email) });
  });

  // Accept an invite → become a member with the invited role, delete the invite.
  // Matched by the caller's verified email (can't accept someone else's invite).
  app.post("/invites/:orgId/accept", requireUser, async (c) => {
    const orgId = c.req.param("orgId");
    const email = c.var.principal.email;
    if (!email) return c.json({ error: "your account has no verified email" }, 400);
    const invite = await getInvite(email, orgId);
    if (!invite) return c.json({ error: "no pending invite for you in that org" }, 404);
    // Defense-in-depth: invite creation now refuses an existing member, but an
    // invite could pre-date a membership created another way. Never let accepting
    // one DEMOTE a sitting admin (that would bypass the last-admin invariant) -
    // keep the existing membership and just clear the stale invite.
    const existing = await getMembership(orgId, c.var.principal.userId);
    if (existing) {
      await deleteInvite(email, orgId);
      return c.json({ orgId, role: existing.role });
    }
    const now = new Date().toISOString();
    // Capture the email on the membership so the org's roster + managers picker
    // show a readable name (it's the verified email the invite matched on).
    await putMembership({ orgId, userId: c.var.principal.userId, role: invite.role, joinedAt: now, email });
    await deleteInvite(email, orgId);
    return c.json({ orgId, role: invite.role });
  });

  // Decline an invite → just delete it. JWT-only (same as accept).
  app.post("/invites/:orgId/decline", requireUser, async (c) => {
    const email = c.var.principal.email;
    if (!email) return c.json({ error: "your account has no verified email" }, 400);
    await deleteInvite(email, c.req.param("orgId"));
    return c.body(null, 204);
  });

  // Delete an agent: remove its schedule (best-effort - a stale schedule is
  // harmless and swept later), then the record. There's no per-agent runtime to
  // tear down (the shared runtime is platform-owned).
  app.delete("/agents/:id", requireScope("delete"), async (c) => {
    const auth = authorize(c.var.principal, await getAgent(c.req.param("id")), "write", "you can't delete this shared agent");
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    const agent = auth.record;
    await deps.scheduler.remove(agent.id).catch((e) => console.error("schedule teardown failed", agent.id, e));
    await deleteAgent(agent.id);
    return c.body(null, 204);
  });

  // ---- Invoke endpoint (per-agent API key) --------------------------------
  // Not behind requireAuth: authenticated by the agent's own API key so external
  // clients can trigger exactly this agent.
  app.post("/agents/:id/invoke", async (c) => {
    const record = await authAgentByKey(c.req.param("id"), c.req.header("Authorization"));
    if (!record) return c.json({ error: AGENT_KEY_401 }, 401);

    const body = (await c.req.json().catch(() => ({}))) as { sessionId?: string; prompt?: string };
    if (typeof body.prompt !== "string" || !body.prompt) {
      return c.json({ error: "missing prompt" }, 400);
    }
    // Bound the per-invoke prompt (replayed into the model, also injected into a
    // running turn) - same class of cost/DoS guard as the config field caps.
    if (body.prompt.length > MAX_PROMPT) {
      return c.json({ error: `prompt exceeds ${MAX_PROMPT} chars` }, 400);
    }

    // A client-supplied session id must already be AgentCore-compliant. We reject
    // rather than coerce: lossy coercion (sanitize + pad) can map two distinct ids
    // to the same session, merging unrelated conversations. If none is given we
    // generate a fresh compliant id and return it.
    if (body.sessionId !== undefined && !isValidSessionId(body.sessionId)) {
      return c.json({ error: "sessionId must match [a-zA-Z0-9_-]{33,100}" }, 400);
    }
    const sessionId = body.sessionId ?? newSessionId();

    // Resolve the agent's attached skills to their content (org-scoped) so the
    // runtime gets them in the payload and needs no skills-table read. A skill
    // deleted since it was attached is simply skipped. Best-effort: a skills read
    // failure shouldn't block the turn - the agent just runs without them.
    // Resolve integrations to their manifest (metadata + operations, NO secret)
    // so the runtime can tell the model what it CAN call; the proxy holds the
    // secret and re-checks the grant on every call. Same best-effort as skills.
    const [skills, integrations] = await Promise.all([
      resolveSkills(record.orgId, record.createdBy, record.config.skillIds),
      resolveIntegrations(record.orgId, record.createdBy, record.config.integrationIds),
    ]);

    let ack;
    try {
      ack = await deps.invoker.invoke({
        agentId: record.id,
        config: record.config,
        version: record.version ?? 1,
        skills,
        integrations: integrations.manifests,
        sessionId,
        prompt: body.prompt,
      // Per-session capability token: scoped to this (orgId, agentCreatedBy, agentId,
      // sessionId) and the agent's VISIBLE integration ids (grantedIds, not the raw
      // config), so a token leaked from the microVM only writes this session's own
      // telemetry and calls integrations the agent can actually see.
        ingestToken: mintSessionToken(
          record.orgId,
          record.createdBy,
          record.id,
          sessionId,
          integrations.grantedIds,
        ),
      });
    } catch (e) {
      // A timed-out invoke may or may not have reached the runtime, and invoking is
      // NOT idempotent (the same sessionId is injected into a running turn). The
      // generic 503 "retry shortly" would therefore invite the client to duplicate
      // the prompt. Return 504 with the sessionId so it POLLS that session to see
      // whether the turn started, instead of blind-retrying.
      if (!isAmbiguousOutcome(e)) throw e;
      console.error("invoke outcome unknown", record.id, sessionId, e);
      return c.json(
        {
          error: "the invoke timed out and may or may not have started - poll this session to check before retrying",
          sessionId,
        },
        504,
      );
    }
    // Record the user's message in the trajectory here (control-plane), so it
    // shows in the trace for EVERY agent - not just ones whose runtime image was
    // baked after this shipped. Only for a fresh turn (`triggered`): an `injected`
    // message is already recorded as an `injected` event by the runtime hook, and
    // a `rejected` one never ran. Best-effort - never fail the invoke.
    if (ack.status === "triggered") {
      await recordPrompt(ack.sessionId, record.id, body.prompt).catch((e) =>
        console.error("recordPrompt failed", e),
      );
    }
    // Best-effort: the turn is already triggered, so a metrics-write failure
    // must not fail the response - a 500 here would make the client retry and
    // spuriously inject a duplicate prompt into the running turn.
    await bumpInvocation(record.id).catch((e) => console.error("bumpInvocation failed", e));

    const res: InvokeResponse = { sessionId: ack.sessionId, status: ack.status };
    return c.json(res);
  });

  // Poll a session: status + trajectory delta since `after`. Authed by API key
  // like invoke, so a client can poll with the same credential it triggered with.
  app.get("/agents/:id/sessions/:sessionId", async (c) => {
    const record = await authAgentByKey(c.req.param("id"), c.req.header("Authorization"));
    if (!record) return c.json({ error: AGENT_KEY_401 }, 401);

    const sessionId = c.req.param("sessionId");
    const after = c.req.query("after");
    // readSession returns the event delta + status together, and only reports
    // "idle" once the terminal event is within the delivered delta - so a client
    // is never told idle before it has received every event.
    const { delta, status } = await readSession(record.id, sessionId, after);
    const cursor = delta.length ? delta[delta.length - 1]!.cursor : (after ?? null);

    const res: PollResponse = { sessionId, status, events: delta, cursor };
    return c.json(res);
  });

  // ---- Slack setup (the UI's state machine) --------------------------------------------
  // All three are gated on WRITE of the agent: connecting a Slack app changes what can invoke
  // it, so it's a config-level act, not a read.

  /**
   * Everything the UI needs to render the current step: the derived state, the manifest to
   * paste, and what we know about the connected workspace. Never returns a secret.
   */
  app.get("/agents/:id/slack", requireScope("read"), async (c) => {
    const auth = authorize(c.var.principal, await getAgent(c.req.param("id")), "view", "you can't view this agent");
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    const record = auth.record;
    const trigger = slackOf(record.config);
    if (!trigger) return c.json({ error: "this agent has no Slack trigger" }, 404);

    return c.json({
      state: slackSetupState(record),
      manifest: slackManifest({
        agentName: record.config.name,
        description: record.description,
        apiOrigin: PUBLIC_API_URL,
        agentId: record.id,
      }),
      requestUrl: slackRequestUrl(PUBLIC_API_URL, record.id),
      requestedScopes: [...SLACK_BOT_SCOPES],
      // `hasBotToken` rather than the token: a write-only credential never comes back.
      hasBotToken: Boolean(record.slackSecrets?.botToken),
      appId: trigger.appId,
      teamId: trigger.teamId,
      teamName: trigger.teamName,
      botUserId: trigger.botUserId,
      grantedScopes: trigger.grantedScopes,
      urlVerified: Boolean(trigger.urlVerified),
      channels: trigger.channels,
      allChannels: Boolean(trigger.allChannels),
    });
  });

  /**
   * Store the bot token (+ signing secret, which the user copies from Basic Information) and
   * immediately verify with `auth.test`, so the reply tells the user which workspace they
   * actually connected and what Slack actually granted.
   */
  app.patch("/agents/:id/slack/credentials", requireScope("write"), async (c) => {
    const auth = authorize(c.var.principal, await getAgent(c.req.param("id")), "write", "you can't edit this agent");
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    const record = auth.record;
    const trigger = slackOf(record.config);
    if (!trigger) return c.json({ error: "this agent has no Slack trigger" }, 404);

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const botToken = typeof body?.botToken === "string" ? body.botToken.trim() : "";
    const signingSecret = typeof body?.signingSecret === "string" ? body.signingSecret.trim() : "";
    if (!botToken || !signingSecret) {
      return c.json({ error: "botToken and signingSecret are both required" }, 400);
    }

    // Verify BEFORE storing: a token that doesn't work should not be saved and reported as
    // connected. This is also where we learn teamId/botUserId, which routing needs.
    const verified = await slackAuthTest(botToken);
    if (!verified.ok) return c.json({ error: verified.error, hint: verified.hint }, 400);

    const triggers = record.config.triggers.map((t) =>
      t.type === "slack" ? withSlackVerification(t, verified) : t,
    );
    // The secrets are not versioned config - they're credentials, and a version snapshot is
    // a full config copy that a reader can fetch. Store them on the record; bump the version
    // for the TRIGGER change through the shared path, so connecting Slack shows in history.
    await updateAgent(record.id, { slackSecrets: { botToken, signingSecret } });
    await applyNewVersion(deps, record, { ...record.config, triggers }, "connected Slack");
    return c.json({
      teamId: verified.teamId,
      teamName: verified.teamName,
      botUserId: verified.botUserId,
      grantedScopes: verified.grantedScopes,
    });
  });

  /** The channels the bot can see, for the setup picker. Read-only; no state change. */
  app.get("/agents/:id/slack/channels", requireScope("read"), async (c) => {
    const auth = authorize(c.var.principal, await getAgent(c.req.param("id")), "view", "you can't view this agent");
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    const trigger = slackOf(auth.record.config);
    if (!trigger) return c.json({ error: "this agent has no Slack trigger" }, 404);
    const botToken = auth.record.slackSecrets?.botToken;
    if (!botToken) return c.json({ error: "connect the Slack app first" }, 409);

    const listed = await slackChannelList(botToken);
    if ("ok" in listed && listed.ok === false) {
      return c.json({ error: listed.error, hint: listed.hint }, 400);
    }
    return c.json(listed);
  });

  /**
   * Set the channel allowlist. Every channel is validated against the CONNECTED workspace
   * first: a well-formed id from another workspace would otherwise produce an agent that looks
   * configured and silently ignores every mention.
   */
  app.patch("/agents/:id/slack/channels", requireScope("write"), async (c) => {
    const auth = authorize(c.var.principal, await getAgent(c.req.param("id")), "write", "you can't edit this agent");
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    const record = auth.record;
    const trigger = slackOf(record.config);
    if (!trigger) return c.json({ error: "this agent has no Slack trigger" }, 404);
    const botToken = record.slackSecrets?.botToken;
    if (!botToken || !trigger.teamId) {
      return c.json({ error: "connect the Slack app first" }, 409);
    }

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const requested = Array.isArray(body?.channels) ? body.channels : null;
    if (!requested) return c.json({ error: "channels must be an array" }, 400);
    if (requested.length > 25) return c.json({ error: "at most 25 channels" }, 400);
    // Opt-in to answering wherever the bot is invited. The explicit list is still kept and still
    // validated, so turning this back off restores the previous allowlist rather than losing it.
    const allChannels = body?.allChannels === true;

    const resolved: Array<{ id: string; name: string; isPrivate: boolean }> = [];
    for (const raw of requested) {
      if (typeof raw !== "string") return c.json({ error: "channel ids must be strings" }, 400);
      const info = await slackChannelInfo(botToken, raw.trim(), trigger.teamId);
      if ("ok" in info && info.ok === false) {
        return c.json({ error: info.error, hint: info.hint, channel: raw }, 400);
      }
      resolved.push(info as { id: string; name: string; isPrivate: boolean });
    }

    const triggers = record.config.triggers.map((t) =>
      t.type === "slack"
        ? { ...t, channels: resolved.map((r) => r.id), ...(allChannels ? { allChannels: true } : {}) }
        : t,
    );
    await applyNewVersion(deps, record, { ...record.config, triggers }, "set Slack channels");
    return c.json({ channels: resolved, allChannels });
  });

  // The Slack webhook. Public + unauthenticated by necessity (Slack can hold no credential of
  // ours), so its HMAC is the whole boundary - see slack-routes.ts for the ordered checks.
  mountSlackRoutes(app, {
    dispatch: ({ record, prompt, sessionId, messageTs }) =>
      dispatchSlackRun(deps.invoker, { record, prompt, sessionId, messageTs }),
  });

  return app;
}
