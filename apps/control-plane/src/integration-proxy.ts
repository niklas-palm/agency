/**
 * The integrations proxy's forwarding logic: turn a validated call request +
 * stored integration record into an outbound HTTP request, inject the credential,
 * and return the downstream response (status + capped text body).
 *
 * This is the piece that lets an agent reach a downstream API WITHOUT ever seeing
 * the credential. Two safety anchors:
 *  - the URL is composed ONLY from the stored `baseUrl` + the operation's declared
 *    `path` (placeholders filled from `pathParams`), so a compromised agent can't
 *    aim the proxy at an arbitrary host (no open-proxy / SSRF pivot). We re-parse
 *    the composed URL and assert it still has the base's origin + path prefix.
 *  - the credential is read from the record here and injected as a header; it is
 *    never returned to the caller.
 * The route layer (routes.ts) has already verified the session token and that the
 * requested integrationId is in the token's grant; this module trusts that and
 * focuses on building + issuing the request safely.
 */
import type {
  IntegrationAuth,
  IntegrationCallRequest,
  IntegrationCallResponse,
  IntegrationOperation,
} from "@agency/shared";
import type { IntegrationRecord } from "./repo/integrations.js";
import { getAccessToken } from "./oauth-token.js";
import { readCapped } from "./outbound.js";

/**
 * Cap on the downstream RAW body we buffer + return. The DEFAULT is small to protect the
 * LLM context window (the body is returned into the model's context). When the caller
 * sets `largeResponse` (it will persist the body to a file, not read it into context) we
 * use LARGE instead - generous for "fetch a dataset and compute over it".
 *
 * LARGE is 2.5 MiB, NOT 5+: the body is returned via `c.json({status, body})`, so it is
 * JSON-string-escaped (every `"`/`\`/control char grows), and the Lambda synchronous
 * response payload limit is ~6 MB. A quote-heavy JSON dataset can ~2x under escaping, so
 * 2.5 MiB raw → ~5 MiB envelope worst-case - under the ceiling with headroom for the
 * response wrapper. (A body that hits the cap is reported as `truncated` so the agent
 * pages rather than computing on partial data.) Both caps remain hard memory/DoS guards.
 */
const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_LARGE_RESPONSE_BYTES = Math.floor(2.5 * 1024 * 1024);
/** Per-call wall-clock deadline for the downstream request. */
/**
 * One deadline for the whole forward: the credential mint (oauth2Client, up to
 * MINT_TIMEOUT_MS) plus the downstream request and any redirect hops. Kept well
 * under IngestFn's Lambda timeout so a slow downstream produces our own
 * "downstream request timed out" error instead of the Lambda being killed
 * mid-response (which surfaced to the agent as an opaque 502).
 */
const REQUEST_TIMEOUT_MS = 10_000;
/** How many on-base redirects to follow before giving up. */
const MAX_REDIRECTS = 3;

/** A structured failure the proxy returns as a 4xx (never throws to the agent). */
export interface ProxyError {
  error: string;
  hint: string;
}

/**
 * Fill `{param}` placeholders in an operation path from `pathParams`, URL-encoding
 * each value. Returns null if a placeholder is missing or a value would smuggle a
 * new path segment / escape the path (encodeURIComponent already blocks `/`, but we
 * also reject values that decode to traversal). Every placeholder must be provided.
 */
function fillPath(path: string, pathParams: Record<string, string> | null | undefined): string | null {
  let ok = true;
  const params = pathParams ?? {};
  const filled = path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = params[name];
    if (typeof v !== "string" || v === "" || v.includes("/") || v.includes("..")) {
      ok = false;
      return "";
    }
    return encodeURIComponent(v);
  });
  return ok ? filled : null;
}

/**
 * Compose the outbound absolute URL from the integration's baseUrl + the operation
 * path (placeholders filled) + the optional query. Re-validates that the result
 * stays under the baseUrl's origin AND path prefix - the SSRF anchor: even a
 * malformed path can't redirect the request off the configured base.
 */
export function buildUrl(
  baseUrl: string,
  op: IntegrationOperation,
  req: IntegrationCallRequest,
): string | ProxyError {
  const filledPath = fillPath(op.path, req.pathParams);
  if (filledPath === null) {
    return { error: "invalid pathParams", hint: `provide every {placeholder} in "${op.path}" as a plain value` };
  }
  const base = new URL(baseUrl);
  // Join base path + operation path with exactly one slash.
  const basePath = base.pathname.replace(/\/+$/, "");
  const combinedPath = `${basePath}${filledPath}`;
  const url = new URL(combinedPath, base.origin);
  // Defense in depth: the composed URL must not have escaped the base origin/path.
  if (!isUnderBase(url, base)) {
    return { error: "path escapes baseUrl", hint: "the operation path must resolve under the integration's base URL" };
  }
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (typeof v === "string") url.searchParams.append(k, v);
  }
  return url.toString();
}

/** True if `url` stays under `base`'s origin AND path prefix - the SSRF anchor. */
function isUnderBase(url: URL, base: URL): boolean {
  const basePath = base.pathname.replace(/\/+$/, "");
  const underPath = url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
  return url.origin === base.origin && underPath;
}

/**
 * Build the credential headers for an integration's auth, injecting the secret per
 * the auth kind. Async because `oauth2Client` mints (or reuses a cached) short-lived
 * token. Returns a ProxyError if minting fails (so the caller sends an { error, hint }
 * rather than a silently-unauthenticated request). Shared by the proxy's downstream
 * forward AND discovery's spec fetch - a spec URL is often gated by the very same
 * credential, so discovery must authenticate identically. `doFetch` is threaded
 * through for the OAuth mint call.
 */
export async function credentialHeaders(
  auth: IntegrationAuth,
  secret: string | undefined,
  doFetch: typeof fetch = fetch,
): Promise<{ headers: Record<string, string> } | ProxyError> {
  const s = secret ?? "";
  switch (auth.kind) {
    case "bearer":
      return { headers: s ? { Authorization: `Bearer ${s}` } : {} };
    case "apiKey":
      return { headers: s ? { [auth.header]: s } : {} };
    case "none":
      return { headers: {} };
    case "oauth2Client": {
      const token = await getAccessToken(auth, s, { doFetch });
      if (typeof token !== "string") {
        return { error: "could not authenticate to the integration", hint: token.error };
      }
      return { headers: { Authorization: `Bearer ${token}` } };
    }
  }
}

/**
 * Forward one call to the downstream API and return its status + capped text body.
 * Returns a ProxyError (never throws) on a bad request shape or a transport
 * failure, so the runtime tool can hand the model an { error, hint } it can adapt
 * to. `doFetch` is injectable for tests.
 */
export async function forwardCall(
  record: IntegrationRecord,
  req: IntegrationCallRequest,
  doFetch: typeof fetch = fetch,
): Promise<IntegrationCallResponse | ProxyError> {
  const op = record.operations.find((o) => o.operationId === req.operationId);
  if (!op) {
    return {
      error: "unknown operation",
      hint: `"${req.operationId}" is not an operation of this integration; call list_integration_operations to see valid ids`,
    };
  }
  const url = buildUrl(record.baseUrl, op, req);
  if (typeof url !== "string") return url; // ProxyError

  // Start the deadline BEFORE the credential mint: for `oauth2Client` that mint is
  // itself a network call (up to MINT_TIMEOUT_MS), so leaving it outside the budget
  // let total work exceed the Lambda's timeout - the Lambda died and the agent got an
  // opaque 502 instead of the timeout error below. One deadline covers mint + forward.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await forwardWithin(controller, record, op, req, url, doFetch);
  } finally {
    clearTimeout(timer);
  }
}

/** The credential mint + redirect-following forward, all under one abort deadline. */
async function forwardWithin(
  controller: AbortController,
  record: IntegrationRecord,
  op: IntegrationOperation,
  req: IntegrationCallRequest & { agentId: string },
  url: string,
  doFetch: typeof fetch,
): Promise<IntegrationCallResponse | ProxyError> {
  const auth = await credentialHeaders(record.auth, record.secret, doFetch);
  if ("error" in auth) return auth; // ProxyError (e.g. OAuth mint failed)
  // Forward the calling agent's id as a NON-secret header, so a downstream that logs
  // or attributes by caller can see which agent invoked it. It's not the credential
  // (m2m tokens are per-client, not per-agent); it's provenance, safe to expose.
  const headers: Record<string, string> = { ...auth.headers, "X-Agency-Agent-Id": req.agentId };
  let body: string | undefined;
  if (req.body !== undefined && op.method !== "GET" && op.method !== "DELETE") {
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    headers["Content-Type"] = "application/json";
  }

  const base = new URL(record.baseUrl);
  try {
    // Follow redirects MANUALLY, re-validating every hop stays under the base URL.
    // `fetch`'s own redirect:"follow" would jump to a 3xx Location without re-running
    // the SSRF anchor, letting a registered (or compromised) downstream bounce the
    // proxy to an internal host - and worse, replay a custom apiKey header (which
    // undici does NOT strip cross-origin) to that host. Mirrors web-tools.ts.
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await doFetch(current, { method: op.method, headers, body, redirect: "manual", signal: controller.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
        const next = new URL(res.headers.get("location")!, current);
        await res.body?.cancel().catch(() => {});
        if (!isUnderBase(next, base)) {
          return { error: "downstream redirect escapes baseUrl", hint: "the integration redirected off its base URL; the proxy only forwards under the configured base" };
        }
        if (hop === MAX_REDIRECTS) {
          return { error: "too many redirects", hint: "the downstream API redirected too many times" };
        }
        current = next.toString();
        continue;
      }
      const cap = req.largeResponse ? MAX_LARGE_RESPONSE_BYTES : MAX_RESPONSE_BYTES;
      const { text, truncated } = await readCapped(res, cap);
      return { status: res.status, body: text, ...(truncated ? { truncated: true } : {}) };
    }
    return { error: "too many redirects", hint: "the downstream API redirected too many times" };
  } catch (e) {
    const reason = e instanceof Error && e.name === "AbortError" ? "downstream request timed out" : "downstream request failed";
    return { error: reason, hint: "the downstream API did not respond successfully; check the integration or try again" };
  }
  // NOTE: the abort timer is cleared by the caller (forwardCall), which owns the
  // deadline so it also covers the credential mint above.
}
