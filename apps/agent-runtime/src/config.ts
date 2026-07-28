/**
 * Runtime configuration, all from environment. The only local/prod seam here is
 * `DDB_ENDPOINT`: when set (local), the DynamoDB client points at DynamoDB Local
 * with dummy credentials; when unset (prod), it uses the default AWS chain.
 */

/** AWS region the runtime runs in (Bedrock/Anthropic inference + AgentCore). */
export const REGION = process.env.AWS_REGION ?? "us-east-1";

/**
 * Region for the OpenAI-via-Bedrock-Mantle endpoint. Mantle is only offered in
 * us-east-1, so it's pinned SEPARATELY from `REGION` - a runtime in any region
 * (e.g. eu-north-1) still reaches Mantle in us-east-1 over its egress. Overridable
 * via `MANTLE_REGION` if Mantle expands to more regions later.
 */
export const MANTLE_REGION = process.env.MANTLE_REGION ?? "us-east-1";

/**
 * Base URL of the control-plane's internal telemetry ingest API. The runtime
 * POSTs trajectory events + session summaries here instead of writing DynamoDB
 * directly, so its AWS role holds NO table write - only Bedrock invoke. Set by
 * CDK in prod (the HTTP API URL); the docker-compose control-plane URL locally.
 */
export const INGEST_URL = process.env.INGEST_URL ?? "";

// NOTE: the runtime holds NO ingest secret in its environment. Auth to the ingest
// API is a per-session capability token that arrives in each invoke payload and is
// set on the ingest client at turn start (see ingest.ts setIngestToken). This is
// deliberate: an env-var secret would be readable by the agent's run_bash via
// /proc, so there is nothing here to steal - only a token scoped to the agent's
// own session, which it already controls.

/**
 * Per-turn budget: the ceiling on ONE invocation of the agent loop.
 *
 * Without this a tool-looping model can occupy a billable microVM for its whole
 * lifetime (up to 8h) and accrue unbounded model cost - the single largest
 * cost-blowup path in the platform, and one nothing else bounds: there is no rate
 * limit and no concurrency cap. These are deliberately generous (a real coding task
 * takes many turns) but finite, so a runaway loop stops instead of running until the
 * microVM dies.
 *
 * `turns` counts model-call-plus-tools iterations; `totalTokens` is cumulative input
 * + output across the loop; the deadline is wall-clock. Whichever trips first ends
 * the turn cleanly - the SDK stops at a turn boundary with a `limit*` stop reason,
 * so `agent.messages` stays reinvokable and the session can continue.
 *
 * Tune per deployment via env. Set any to 0 to disable that dimension.
 */
/**
 * Node's `setTimeout` ceiling (~24.9 days), which is what `AbortSignal.timeout` uses.
 * Not 2^32-1: that's where it starts throwing a RangeError, but anything above THIS
 * clamps to 1ms with only a warning - so a too-large deadline wouldn't be rejected, it
 * would abort every turn instantly. Either way the shared runtime is bricked, so the
 * usable bound is the one to enforce.
 */
const MAX_ENV_INT = 2 ** 31 - 1;

/**
 * A non-negative integer from env, or the default when unset or out of range. 0 means
 * "no limit". Garbage warns rather than failing silently: these are cost controls, and
 * a typo'd cap that quietly reverts to the default is exactly the mistake a deployer
 * needs told about.
 */
function intFromEnv(name: string, fallback: number): number {
  // Trim first: `Number(" ")` is 0, so a whitespace-only value would silently DISABLE
  // the cap - a stray space in an env file removing a cost guard.
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n <= MAX_ENV_INT) return n;
  console.warn(`⚠️  ${name}=${raw} is not an integer in 0..${MAX_ENV_INT}; using the default ${fallback}.`);
  return fallback;
}

export const MAX_TURNS_PER_INVOCATION = intFromEnv("MAX_TURNS_PER_INVOCATION", 60);
export const MAX_TOKENS_PER_INVOCATION = intFromEnv("MAX_TOKENS_PER_INVOCATION", 2_000_000);
export const INVOCATION_DEADLINE_MS = intFromEnv("INVOCATION_DEADLINE_MS", 30 * 60_000);

/**
 * True in local dev. Historically gated the DynamoDB-Local endpoint; now the
 * runtime never touches DynamoDB, but assertLocalCredentials still uses it to
 * decide whether to require pasted AWS creds (Bedrock is real even locally).
 */
export const DDB_ENDPOINT = process.env.DDB_ENDPOINT;

/**
 * The AWS-managed AgentCore Web Search Gateway (MCP) URL. Set in prod by CDK on
 * the PUBLIC runtime; empty locally + on the isolated runtime (web search is
 * unavailable there - fetch still works). When empty, the runtime wires only
 * `fetch_webpage`, not `web_search`.
 */
export const WEB_SEARCH_GATEWAY_URL = process.env.WEB_SEARCH_GATEWAY_URL ?? "";

/**
 * Region to SigV4-sign web-search gateway requests to. The managed connector is
 * us-east-1-only, so the gateway lives there and a runtime in any region reaches
 * it cross-region (same as `MANTLE_REGION`). Pinned separately from `REGION`.
 */
export const WEB_SEARCH_REGION = process.env.WEB_SEARCH_REGION ?? "us-east-1";

/**
 * Local dev only: assert the shell's temporary AWS credentials were passed into
 * the container as env vars, and refuse any profile fallback.
 *
 * Locally, Bedrock is the one real AWS call (see docker-compose.yml). The dev
 * workflow is to paste temporary Identity Center creds into the shell, which
 * compose forwards as env vars. If they're absent (or expired-and-cleared), the
 * AWS SDK would silently fall through to a profile or IMDS and fail deep inside a
 * model call with a cryptic error. So we fail fast at boot with a clear message,
 * and delete AWS_PROFILE so the credential chain can only use the env creds.
 *
 * Skipped in prod: AgentCore supplies the runtime role's credentials through the
 * container credential provider, not these env vars, so DDB_ENDPOINT (set only
 * locally) gates the check.
 */
export function assertLocalCredentials(): void {
  if (!DDB_ENDPOINT) return; // prod - role creds come from AgentCore.

  // Never let a profile stand in for the pasted env creds.
  delete process.env.AWS_PROFILE;

  // The key pair is required; AWS_SESSION_TOKEN is NOT - it's present for temporary
  // (STS/Identity Center) creds and absent for a long-lived IAM user key, which is
  // what someone with a fresh AWS account most likely has. Demanding it turned a
  // working setup into a boot failure telling them to export something they can't get.
  const missing = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing AWS credentials in the environment: ${missing.join(", ")}. ` +
        "Bedrock is called for real even locally, so export AWS_ACCESS_KEY_ID + " +
        "AWS_SECRET_ACCESS_KEY (plus AWS_SESSION_TOKEN if they're temporary creds) " +
        "before `docker compose up` - profiles are not used.",
    );
  }
}
