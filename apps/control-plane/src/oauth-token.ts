/**
 * OAuth2 client-credentials (m2m) token minting for the integrations proxy. When an
 * integration's auth is `oauth2Client`, the proxy needs a short-lived bearer token to
 * forward downstream - it mints one from the provider's `tokenUrl` using the client id
 * + the stored client secret, caches it in memory, and reuses it until near expiry.
 *
 * The agent never sees the client secret OR the minted token - both live only here,
 * inside the proxy. The cache is a warm-Lambda in-memory Map (a cold start just re-mints);
 * we deliberately don't persist tokens (no new secret store, and a token is cheap to
 * re-mint). The cache key is a fingerprint of the mint parameters INCLUDING the secret,
 * so rotating the credential naturally busts the cache.
 *
 * `tokenUrl` was SSRF-validated at registration and is re-guarded on every mint via
 * `guardedFetch` (same anchor as baseUrl / discovery).
 */
import type { IntegrationAuth } from "@agency/shared";
import { guardedFetch } from "./outbound.js";

/** The oauth2Client member of the auth union (narrowed for this module). */
type OAuth2ClientAuth = Extract<IntegrationAuth, { kind: "oauth2Client" }>;

/** Cap on the token response we buffer. */
const MAX_TOKEN_BYTES = 64 * 1024;
/** Per-mint wall-clock deadline. */
const MINT_TIMEOUT_MS = 10_000;
/** Refresh this many ms BEFORE the stated expiry, so an in-flight call never uses a just-expired token. */
const EXPIRY_SKEW_MS = 60_000;
/** Fallback lifetime when the token endpoint omits `expires_in`. */
const DEFAULT_TTL_MS = 5 * 60_000;

interface CachedToken {
  token: string;
  /** ms epoch after which the token must be re-minted (already skew-adjusted). */
  expiresAt: number;
}

/** Warm-process token cache, keyed by a fingerprint of the mint parameters. */
const cache = new Map<string, CachedToken>();

/** A mint failure, returned as data (never thrown). */
export interface MintError {
  error: string;
}

/**
 * Get a valid access token for an `oauth2Client` integration, minting + caching one
 * if none is cached or the cached one is near expiry. `now` + `doFetch` are injectable
 * for tests. Returns the token string or a MintError.
 */
export async function getAccessToken(
  auth: OAuth2ClientAuth,
  secret: string,
  opts: { now?: number; doFetch?: typeof fetch } = {},
): Promise<string | MintError> {
  const now = opts.now ?? Date.now();
  const key = fingerprint(auth, secret);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.token;

  const minted = await mint(auth, secret, opts.doFetch);
  if ("error" in minted) return minted;
  // Cache until the skew-adjusted expiry, but never for a non-positive window: a
  // short-lived token (expires_in <= skew) would otherwise cache as already-expired
  // and re-mint on every call. Floor the cached lifetime at half the stated TTL.
  const lifetime = Math.max(minted.ttlMs - EXPIRY_SKEW_MS, Math.floor(minted.ttlMs / 2));
  cache.set(key, { token: minted.token, expiresAt: now + lifetime });
  return minted.token;
}

/** POST the client-credentials grant to the token endpoint and parse the response. */
async function mint(
  auth: OAuth2ClientAuth,
  secret: string,
  doFetch?: typeof fetch,
): Promise<{ token: string; ttlMs: number } | MintError> {
  const form = new URLSearchParams({ grant_type: "client_credentials" });
  if (auth.scope) form.set("scope", auth.scope);
  if (auth.audience) form.set("audience", auth.audience);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (auth.authStyle === "basic") {
    // HTTP Basic: base64(clientId:secret) in the Authorization header (OAuth2 default).
    headers.Authorization = `Basic ${Buffer.from(`${auth.clientId}:${secret}`).toString("base64")}`;
  } else {
    // Credentials in the form body (some providers require this style).
    form.set("client_id", auth.clientId);
    form.set("client_secret", secret);
  }

  const res = await guardedFetch(
    auth.tokenUrl,
    { method: "POST", headers, body: form.toString() },
    {
      maxBytes: MAX_TOKEN_BYTES,
      timeoutMs: MINT_TIMEOUT_MS,
      // The Basic header is stripped on a cross-origin hop; the body-style
      // client_secret can't be, so refuse a cross-origin redirect in that case.
      credentialInBody: auth.authStyle === "body",
    },
    doFetch,
  );
  if ("error" in res) return { error: `token mint failed: ${res.error}` };
  if (res.status < 200 || res.status >= 300) return { error: `token endpoint returned HTTP ${res.status}` };

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return { error: "token endpoint returned a non-JSON response" };
  }
  if (typeof parsed !== "object" || parsed === null) return { error: "token endpoint returned an unexpected response" };
  const p = parsed as Record<string, unknown>;
  if (typeof p.access_token !== "string" || !p.access_token) return { error: "token response had no access_token" };
  const ttlMs = typeof p.expires_in === "number" && p.expires_in > 0 ? p.expires_in * 1000 : DEFAULT_TTL_MS;
  return { token: p.access_token, ttlMs };
}

/**
 * A stable cache key for a set of mint parameters. Includes the secret so a rotated
 * credential mints fresh (a stale token for the old secret is never reused). This
 * lives in-process only; it's never logged or returned.
 */
function fingerprint(auth: OAuth2ClientAuth, secret: string): string {
  return JSON.stringify([auth.tokenUrl, auth.clientId, auth.scope ?? "", auth.audience ?? "", auth.authStyle, secret]);
}
