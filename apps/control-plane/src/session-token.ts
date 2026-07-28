/**
 * Per-session capability tokens.
 *
 * One token authorizes everything a running microVM is allowed to do against the
 * control-plane: POST its telemetry (trajectory + session summary) AND call the
 * integrations proxy. It is scoped to exactly ONE (orgId, agentCreatedBy, agentId, sessionId) and
 * carries the integration ids the agent was granted, minted by the control-plane at
 * invoke and carried in the invoke payload. Callers verify the token and match its
 * claims against what they're authorizing:
 *  - ingest: the posted body's agentId/sessionId must equal the token's.
 *  - proxy:  the same, plus the requested integrationId must be in the token's grant.
 *            The proxy resolves the (org-scoped) integration record using the
 *            token's orgId, so it needs NO agents-table read - the ingest Lambda
 *            stays minimally-privileged (integrations read only, no agents access).
 *
 * So a token that leaks out of the runtime (e.g. via `run_bash` reading
 * /proc/<pid>/environ) only acts as the session the agent already IS, and only on
 * the integrations it was already granted - never another tenant's. This is why the
 * runtime holds NO long-lived secret: the signing key (RUNTIME_INGEST_KEY) lives
 * only in the control-plane + ingest Lambdas. See docs/runtime.md.
 *
 * Token = `${b64url(orgId)}.${b64url(agentCreatedBy)}.${b64url(agentId)}.${b64url(sessionId)}.${b64url(integrationsCsv)}.${expEpochSec}.${HMAC}`
 * where the HMAC-SHA256 (keyed by RUNTIME_INGEST_KEY) is over the
 * `orgId.agentCreatedBy.agentId.sessionId.integrations.exp` prefix. Each field is
 * base64url-encoded so the `.` delimiter is unambiguous no matter what characters an
 * id contains. The integrations claim is the granted ids comma-joined (empty when
 * none). `orgId` scopes the proxy's integration lookup; `agentCreatedBy` lets the
 * proxy re-check per-resource visibility (the Q4 recheck) without an agents-table
 * read. Compact, dependency-free, stateless.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { RUNTIME_INGEST_KEY } from "./config.js";

/** Token lifetime: covers a microVM's max lifetime (8h) with headroom. */
const TTL_SECONDS = 9 * 60 * 60;

/** The claims carried by a session token. */
export interface SessionClaims {
  /** Org of the agent - lets the proxy resolve org-scoped integration records. */
  orgId: string;
  /** userId of the agent's creator - for the Q4 per-resource visibility recheck. */
  agentCreatedBy: string;
  agentId: string;
  sessionId: string;
  /** Integration ids this session is authorized to call via the proxy. */
  integrationIds: string[];
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
function sign(payload: string): string {
  return createHmac("sha256", RUNTIME_INGEST_KEY).update(payload).digest("base64url");
}

/**
 * Mint a token authorizing this (orgId, agentCreatedBy, agentId, sessionId) - and
 * the given integration ids - until it expires. Returns "" if no signing key is
 * configured (caller then knows the capability channel is unavailable). `nowMs` is
 * injectable for tests.
 */
export function mintSessionToken(
  orgId: string,
  agentCreatedBy: string,
  agentId: string,
  sessionId: string,
  integrationIds: string[] = [],
  nowMs: number = Date.now(),
): string {
  if (!RUNTIME_INGEST_KEY) return "";
  const exp = Math.floor(nowMs / 1000) + TTL_SECONDS;
  const claims = `${b64url(orgId)}.${b64url(agentCreatedBy)}.${b64url(agentId)}.${b64url(sessionId)}.${b64url(integrationIds.join(","))}.${exp}`;
  return `${claims}.${sign(claims)}`;
}

/**
 * Verify a token's signature + expiry and return its claims, or null if invalid.
 * Constant-time on the HMAC. Callers match the returned claims against what they
 * are authorizing (matching claim strings is not secret-dependent, so it need not
 * be constant-time - only the signature check must be).
 */
export function verifySessionToken(token: string, nowMs: number = Date.now()): SessionClaims | null {
  if (!RUNTIME_INGEST_KEY || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const claims = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  // Constant-time signature check (equal-length base64url digests).
  const expected = sign(claims);
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;
  // Each part is `.`-free (ids/integrations are b64url-encoded, exp is digits), so
  // a 6-way split is unambiguous regardless of the ids' original characters.
  const parts = claims.split(".");
  if (parts.length !== 6) return null;
  const [orgEnc, cbEnc, aEnc, sEnc, iEnc, expStr] = parts as [string, string, string, string, string, string];
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Math.floor(nowMs / 1000) > exp) return null;
  let orgId: string, agentCreatedBy: string, agentId: string, sessionId: string, integrationsCsv: string;
  try {
    orgId = Buffer.from(orgEnc, "base64url").toString("utf8");
    agentCreatedBy = Buffer.from(cbEnc, "base64url").toString("utf8");
    agentId = Buffer.from(aEnc, "base64url").toString("utf8");
    sessionId = Buffer.from(sEnc, "base64url").toString("utf8");
    integrationsCsv = Buffer.from(iEnc, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const integrationIds = integrationsCsv ? integrationsCsv.split(",") : [];
  return { orgId, agentCreatedBy, agentId, sessionId, integrationIds };
}
