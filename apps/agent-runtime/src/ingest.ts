/**
 * Telemetry ingest client. The runtime POSTs trajectory events + session
 * summaries to the control-plane's internal ingest API instead of writing
 * DynamoDB directly - so the runtime's AWS role needs no table write (Bedrock-only
 * role; the agent can't reach DDB even with stolen MMDS creds).
 *
 * Auth is a PER-SESSION capability token that arrives in the invoke payload and is
 * set here via `setIngestToken`. The runtime holds NO long-lived ingest secret, so
 * even if the agent reads this process's memory/env (e.g. `run_bash` on /proc), the
 * only credential present is a token scoped to the agent's OWN (agentId, sessionId)
 * - useless for touching another tenant's telemetry. See session-token.ts (control
 * plane). See docs/runtime.md.
 *
 * All calls are best-effort: telemetry is observability, not the agent's work, so a
 * failure is logged and swallowed, never thrown, and a short timeout keeps a
 * slow/hung ingest from stalling a turn. Telemetry posts DO retry a transient
 * failure first (see postIngest) - silently dropping one on a single blip leaves a
 * hole in the trajectory, or loses the session summary that every metric is derived
 * from. Every log line carries the agent + session (setIngestContext), since "ingest
 * failed" without them is unactionable across a fleet of microVMs.
 */
import { INGEST_URL } from "./config.js";

const TIMEOUT_MS = 5_000;

/** Attempts for a telemetry POST (the first try plus this many retries). */
const TELEMETRY_RETRIES = 2;
/** Backoff between telemetry retries; short, since a turn is waiting on nothing else. */
const RETRY_DELAY_MS = 250;

/** The current session's ingest token, set from the invoke payload each turn. */
let ingestToken = "";
export function setIngestToken(token: string): void {
  ingestToken = token;
}

/**
 * Identifiers stamped on every ingest log line. Telemetry failures were previously
 * logged with only the path, which is unactionable across a fleet of microVMs - you
 * could see that writes were failing but not for which agent or session.
 */
let logContext = "";
export function setIngestContext(agentId: string, sessionId: string): void {
  logContext = `agent=${agentId} session=${sessionId}`;
}

/**
 * POST a JSON body to an ingest path, best-effort, RETRYING a transient failure.
 * Returns true on a 2xx, false if every attempt failed (logged). Never throws -
 * callers rely on that to keep the turn going.
 *
 * Telemetry is observability, not the agent's work, so it can't fail a turn - but
 * silently dropping it on one blip means a trajectory with a hole in it (or a lost
 * session summary, which under-counts every metric). A 4xx is NOT retried: a
 * rejected token or malformed body won't become valid on a second try.
 */
export async function postIngest(path: string, body: unknown): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    const res = await postIngestRaw(path, body, TIMEOUT_MS);
    if (res?.ok) return true;
    const worthRetrying = res === null || res.status >= 500 || res.status === 429;
    if (!worthRetrying || attempt >= TELEMETRY_RETRIES) {
      console.error("ingest gave up", path, logContext, `attempts=${attempt + 1}`, `status=${res?.status ?? "none"}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
  }
}

/** Outcome of a raw ingest POST: the HTTP status + parsed JSON body (or null on transport failure). */
export interface IngestResult {
  ok: boolean;
  status: number;
  json: unknown;
}

/**
 * POST a JSON body and return the parsed response (status + JSON), or null if
 * ingest isn't configured or the request failed at the transport layer. Unlike
 * `postIngest` this surfaces the response so callers (the integrations proxy tool)
 * can hand the downstream result back to the model. Uses the SAME per-session
 * token + header as telemetry - the proxy authorizes against the token's grant.
 * Never throws. `timeoutMs` bounds the call (the proxy already caps the downstream
 * request, so this is a generous outer deadline).
 */
export async function postIngestRaw(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<IngestResult | null> {
  if (!INGEST_URL || !ingestToken) {
    console.error("ingest not configured (INGEST_URL / no session token); skipping", path, logContext);
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Normalize any trailing slash on the base (the private REST API URL can carry
    // one) so the joined URL never has a double slash before the path.
    const base = INGEST_URL.replace(/\/$/, "");
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agency-Ingest-Token": ingestToken },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) console.error("ingest POST failed", path, logContext, res.status);
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    console.error("ingest POST error", path, logContext, e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
