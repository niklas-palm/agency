/**
 * Control-plane configuration, all from environment. The `MODE` seam selects
 * between local (in-process runtime over HTTP, DynamoDB Local) and prod (real
 * AgentCore + DynamoDB). Everything else is derived from that.
 */
export const REGION = process.env.AWS_REGION ?? "us-east-1";

/** "local" or "prod". Chooses the provisioner + invoker implementations. */
export const MODE = (process.env.MODE ?? "local") as "local" | "prod";
export const IS_LOCAL = MODE === "local";

export const AGENTS_TABLE = process.env.AGENTS_TABLE ?? "agency-agents";
export const TRAJECTORY_TABLE = process.env.TRAJECTORY_TABLE ?? "agency-trajectory";
/** Personal Access Tokens (programmatic management-API access). */
export const TOKENS_TABLE = process.env.TOKENS_TABLE ?? "agency-tokens";
/** Agent config version history (pk=agentId, sk=version). */
export const VERSIONS_TABLE = process.env.VERSIONS_TABLE ?? "agency-versions";
/** Durable per-session metric summaries (pk=agentId, sk=runId). */
export const SESSIONS_TABLE = process.env.SESSIONS_TABLE ?? "agency-sessions";

/**
 * Bucket holding archived run trajectories. Empty locally (no bucket in the local
 * stack), which switches the archive + the archived-read to a no-op - so local dev
 * serves runs from the trajectory table alone, exactly as it did before.
 */
export const TRACES_BUCKET = process.env.TRACES_BUCKET ?? "";
/** Reusable skills, org-scoped (pk=orgId, sk=skillId). */
export const SKILLS_TABLE = process.env.SKILLS_TABLE ?? "agency-skills";
/** Reusable downstream-API integrations, org-scoped (pk=orgId, sk=integrationId). */
export const INTEGRATIONS_TABLE = process.env.INTEGRATIONS_TABLE ?? "agency-integrations";
/** Organizations (pk=orgId). */
export const ORGS_TABLE = process.env.ORGS_TABLE ?? "agency-orgs";
/** Memberships (pk=orgId, sk=userId; GSI byUser). The authority source. */
export const MEMBERSHIPS_TABLE = process.env.MEMBERSHIPS_TABLE ?? "agency-memberships";
/** Pending invites (pk=email, sk=orgId; GSI byOrg). */
export const INVITES_TABLE = process.env.INVITES_TABLE ?? "agency-invites";

/**
 * Cognito user pool id. Prod-only: set by CDK so inviting an email can lazily
 * provision a login (AdminCreateUser → temp-password email) if none exists yet.
 * Empty locally (auth is disabled), where the identity seam is a no-op.
 */
export const USER_POOL_ID = process.env.USER_POOL_ID ?? "";

/** Local-only: DynamoDB Local endpoint. */
export const DDB_ENDPOINT = process.env.DDB_ENDPOINT;

/** Local-only: base URL of the in-process agent-runtime container. */
export const LOCAL_RUNTIME_URL = process.env.LOCAL_RUNTIME_URL ?? "http://agent-runtime:8080";

/** Public base URL of this API, used to build per-agent invoke URLs. */
export const PUBLIC_API_URL = process.env.PUBLIC_API_URL ?? "http://localhost:8787";

/**
 * Prod-only: ARNs of the shared AgentCore runtimes that back every agent
 * (provisioned by CDK, invoked with agentId+config in the payload). There's a
 * small fixed pool keyed by network mode:
 * - PUBLIC:   the default runtime with public egress.
 * - ISOLATED: a VPC runtime with no public egress (Bedrock reached privately).
 * The invoker picks by the agent's `config.networkMode`. Local uses the
 * LOCAL_RUNTIME_URL container for both, so these stay empty locally.
 */
export const RUNTIME_ARN_PUBLIC = process.env.RUNTIME_ARN_PUBLIC ?? process.env.RUNTIME_ARN ?? "";
export const RUNTIME_ARN_ISOLATED = process.env.RUNTIME_ARN_ISOLATED ?? "";

/** Pick the runtime ARN for an agent's network mode (defaults to public). */
export function runtimeArnFor(networkMode: "public" | "isolated" | undefined): string {
  return networkMode === "isolated" ? RUNTIME_ARN_ISOLATED : RUNTIME_ARN_PUBLIC;
}

/** Prod-only: EventBridge Scheduler wiring for the per-agent schedule trigger. */
export const SCHEDULE_GROUP = process.env.SCHEDULE_GROUP ?? "agency";
/** ARN of the trigger Lambda that EventBridge Scheduler invokes on each tick. */
export const TRIGGER_FUNCTION_ARN = process.env.TRIGGER_FUNCTION_ARN ?? "";
/** ARN of the role EventBridge Scheduler assumes to invoke the trigger Lambda. */
export const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN ?? "";

/**
 * HMAC signing key for the per-session capability tokens (telemetry ingest AND the
 * integrations proxy). The control-plane (and trigger Lambda) MINT a token per
 * invoke scoped to (agentId, sessionId) + the granted integration ids; the ingest
 * Lambda VERIFIES it. The RUNTIME never holds this key - it only carries the
 * short-lived token in its invoke payload - so there's no long-lived secret in the
 * microVM for the agent to steal. See session-token.ts. Empty when unconfigured
 * (mint/verify then no-op / reject).
 */
export const RUNTIME_INGEST_KEY = process.env.RUNTIME_INGEST_KEY ?? "";

/** Cognito issuer for verifying user/M2M JWTs. */
export const COGNITO_ISSUER = process.env.COGNITO_ISSUER ?? "";
/** OAuth scope a token must carry to call the API. */
export const API_SCOPE = process.env.API_SCOPE ?? "agency/api";

/**
 * Is this URL's host the loopback interface? Parses rather than pattern-matching the
 * string, because `http://localhost:8787@evil.com/` starts with a loopback-looking
 * prefix while its actual host is evil.com (the leading part is userinfo). Only the
 * parsed hostname decides.
 */
function isLoopbackUrl(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * When true, JWT auth is skipped entirely and EVERY caller becomes one `local-dev`
 * principal with admin on a shared org. Local development only.
 *
 * Refused unless BOTH `MODE` isn't "prod" AND `PUBLIC_API_URL`'s host is loopback.
 * Deliberately not `MODE` alone: it defaults to "local", so a deployer who self-hosts
 * this container and copies the compose file's env - without knowing to also set
 * MODE=prod - would have got a wide-open API. Requiring a loopback URL means a real
 * deployment, which must publish a reachable origin, is refused whatever else is or
 * isn't configured.
 *
 * *Known limit:* `PUBLIC_API_URL` is the origin we ADVERTISE (it builds invoke URLs),
 * not a bind address - the server binds every interface, and in a container it must
 * (the runtime posts telemetry to `http://control-plane:8787`, and the published port
 * maps from outside). So this catches a deployment that is configured for the internet,
 * not one that merely happens to be reachable from it: leave BOTH vars at their
 * defaults with AUTH_DISABLED=true and the guard passes. Enforcing it properly means
 * binding loopback, which would break the local stack's own container networking. The
 * warning below is the backstop; don't expose this port.
 */
export const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";
if (AUTH_DISABLED) {
  if (MODE === "prod" || !isLoopbackUrl(PUBLIC_API_URL)) {
    throw new Error(
      "AUTH_DISABLED=true is refused: it makes every caller an admin. It is only " +
        `allowed for local development (MODE=local and a localhost PUBLIC_API_URL; got ` +
        `MODE=${MODE}, PUBLIC_API_URL=${PUBLIC_API_URL}). Unset AUTH_DISABLED.`,
    );
  }
  console.warn(
    "⚠️  AUTH_DISABLED=true - authentication is OFF and every request acts as an " +
      "admin. Local development only; never expose this port.",
  );
}
