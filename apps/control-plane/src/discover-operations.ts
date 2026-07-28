/**
 * Auto-discovery of an integration's operations from a spec URL, so a user doesn't
 * hand-author a manifest. Two pieces:
 *
 *  1. A **provider seam** (`DiscoveryProvider`): each provider knows how to turn a
 *     fetched document into candidate operations for one spec format. Providers are
 *     tried in order until one recognizes the document - so adding GraphQL
 *     introspection or MCP tool-listing later is a new entry in `PROVIDERS`, nothing
 *     else changes. We ship OpenAPI (JSON) first.
 *  2. **Reconcile** (`reconcile`): fold a freshly-discovered catalog against the
 *     stored selection. First import enables everything (or exactly the user's
 *     picks); a refresh KEEPS each known op's enabled flag and defaults a
 *     newly-appeared op to OFF - so an evolving upstream API never silently grants
 *     the agent new capabilities.
 *
 * The URL is fetched through `guardedFetch` (the shared SSRF anchor) - discovery is
 * another platform-position outbound call to a tenant-supplied URL, held to the same
 * guard as `baseUrl` and `tokenUrl`. Every candidate operation must pass
 * `parseOperation` (the same gate as a hand-authored op), so a hostile spec can't
 * smuggle a traversal path or a bad method.
 */
import type {
  DiscoveredOperation,
  IntegrationAuth,
  IntegrationDiscovery,
  DiscoveryProviderKind,
  IntegrationOperation,
} from "@agency/shared";
import { guardedFetch } from "./outbound.js";
import { credentialHeaders } from "./integration-proxy.js";
import { parseOperation, MAX_OPERATIONS, MAX_OPERATION_ID } from "./integration-validation.js";

/**
 * The integration's credential, passed to discovery so the spec fetch authenticates
 * the same way the proxy authenticates a downstream call - many APIs gate their own
 * OpenAPI document behind the same key. `auth`/`secret` mirror the stored record.
 */
export interface DiscoveryCredential {
  auth: IntegrationAuth;
  secret: string | undefined;
}

/**
 * The credential to authenticate a discovery spec fetch with - but ONLY when the spec
 * URL sits under the integration's `baseUrl` origin. This is the exfil anchor for
 * discovery: the credential is write-only, and the spec URL is caller-supplied and NOT
 * otherwise bound to `baseUrl`, so without this check the injected secret could be sent
 * to an off-base host and read from the outbound header (never knowing the raw value).
 * Off-`baseUrl` spec → fetch unauthenticated (`undefined`), mirroring the proxy's
 * `isUnderBase` anchor. Used on EVERY discovery path - create/PATCH, the preview, AND
 * refresh/sweep - so a stored off-base `discovery.url` can't leak the credential later.
 */
export function credentialForSpec(
  specUrl: string,
  baseUrl: string,
  auth: IntegrationAuth,
  secret: string | undefined,
): DiscoveryCredential | undefined {
  try {
    if (new URL(specUrl).origin !== new URL(baseUrl).origin) return undefined;
  } catch {
    return undefined;
  }
  return { auth, secret };
}

/** Cap on the spec document we buffer (a big OpenAPI doc is still well under this). */
const MAX_SPEC_BYTES = 4 * 1024 * 1024;
/** Per-fetch wall-clock deadline. */
const FETCH_TIMEOUT_MS = 15_000;
/** Never materialize more operations than a stored manifest can hold. */
const MAX_DISCOVERED = MAX_OPERATIONS;

/** A discovery failure, returned as data (this module never throws). */
export interface DiscoveryError {
  error: string;
}

/** A successful discovery: which provider parsed it + the candidate operations. */
export interface DiscoveryResult {
  provider: DiscoveryProviderKind;
  operations: IntegrationOperation[];
}

/**
 * A discovery provider for one spec format. `parse` gets the fetched document
 * (text + content-type) and returns candidate operations, or null if it doesn't
 * recognize the document (so the next provider gets a turn). Candidates are gated by
 * `parseOperation` afterwards - a provider only needs to extract shape, not enforce
 * safety.
 */
interface DiscoveryProvider {
  kind: DiscoveryProviderKind;
  parse(doc: { body: string; contentType: string }): RawOperation[] | null;
}

/** A candidate operation a provider extracts, before the shared safety gate. */
interface RawOperation {
  operationId: string;
  summary: string;
  method: string;
  path: string;
}

/** The provider registry, tried in order. Add new formats here. */
const PROVIDERS: DiscoveryProvider[] = [openapiProvider()];

/**
 * Fetch + parse a spec URL into candidate operations. Tries each provider until one
 * recognizes the document, gates every candidate through `parseOperation`, and caps
 * the count. Returns a DiscoveryError (never throws) on a fetch failure or an
 * unrecognized / empty spec.
 *
 * **Auth strategy: try unauthenticated first, retry with the credential only on
 * failure.** Many OpenAPI docs are public even when the API is gated, so we don't send
 * the credential speculatively - we attempt the fetch bare, and only if that fails
 * (transport error, non-2xx like 401/403, or an unrecognized body) AND a credential is
 * available do we retry authenticated. This means a public spec needs no credential at
 * all, and the write-only secret leaves only when the endpoint actually demands it.
 * The authenticated retry still respects the SSRF/cross-origin guards in guardedFetch.
 * `doFetch` is injectable for tests.
 */
export async function discoverOperations(
  url: string,
  cred?: DiscoveryCredential,
  doFetch?: typeof fetch,
): Promise<DiscoveryResult | DiscoveryError> {
  const unauthed = await fetchAndParse(url, undefined, doFetch);
  if (!("error" in unauthed)) return unauthed;
  // The public attempt failed; retry with the credential if we have one (the common
  // "the spec is behind the same key as the API" case). No credential → return the
  // original error as-is.
  if (!cred) return unauthed;
  return fetchAndParse(url, cred, doFetch);
}

/** One fetch+parse attempt, optionally carrying the credential. */
async function fetchAndParse(
  url: string,
  cred: DiscoveryCredential | undefined,
  doFetch?: typeof fetch,
): Promise<DiscoveryResult | DiscoveryError> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let credName: string | undefined;
  if (cred) {
    const c = await credentialHeaders(cred.auth, cred.secret, doFetch);
    if ("error" in c) return { error: c.hint || c.error };
    Object.assign(headers, c.headers);
    // The custom apiKey header (if any) is credential-bearing too, so name it for
    // cross-origin stripping (Authorization/Cookie are stripped unconditionally).
    if (cred.auth.kind === "apiKey") credName = cred.auth.header;
  }
  const res = await guardedFetch(
    url,
    { method: "GET", headers },
    { maxBytes: MAX_SPEC_BYTES, timeoutMs: FETCH_TIMEOUT_MS, credentialHeaders: credName ? [credName] : [] },
    doFetch,
  );
  if ("error" in res) return { error: `could not fetch the spec: ${res.error}` };
  if (res.status < 200 || res.status >= 300) {
    return { error: `the spec URL returned HTTP ${res.status}` };
  }

  for (const provider of PROVIDERS) {
    const raw = provider.parse({ body: res.body, contentType: res.contentType });
    if (!raw) continue; // this provider didn't recognize the doc; try the next
    const operations = gate(raw);
    if (operations.length === 0) {
      return { error: "the spec was recognized but contained no usable operations" };
    }
    return { provider: provider.kind, operations };
  }
  return { error: "no discovery provider recognized the spec (only OpenAPI JSON is supported today)" };
}

/**
 * Run raw candidates through the shared operation gate, drop invalid ones, and cap
 * the count. Silently skipping bad ops (rather than failing the whole import) means
 * one malformed path in a large spec doesn't lose every other operation. A colliding
 * operationId (two spec paths that derive the same slug, e.g. `/pets` and `/pets/`)
 * is DISAMBIGUATED with a numeric suffix rather than dropped, so no operation silently
 * disappears from the catalog.
 */
function gate(raw: RawOperation[]): IntegrationOperation[] {
  const out: IntegrationOperation[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    if (out.length >= MAX_DISCOVERED) break;
    const op = parseOperation(candidate);
    if (!op) continue;
    op.operationId = uniqueId(op.operationId, seen);
    seen.add(op.operationId);
    out.push(op);
  }
  return out;
}

/** Return `id`, or `id2`/`id3`/… if it (or a suffixed form) is already taken, bounded. */
function uniqueId(id: string, seen: Set<string>): string {
  if (!seen.has(id)) return id;
  for (let n = 2; n < 1000; n++) {
    // Trim the BASE (not the whole string) so the suffix always survives - otherwise a
    // 128-char id would slice the `n` back off and every candidate collides again.
    const suffix = String(n);
    const candidate = `${id.slice(0, MAX_OPERATION_ID - suffix.length)}${suffix}`;
    if (!seen.has(candidate)) return candidate;
  }
  return id; // pathological; the caller's Set.add is a no-op and one op is lost
}

/**
 * Reconcile a freshly-discovered catalog against the prior selection, producing the
 * new full catalog with per-op `enabled` flags.
 *
 * - **First import** (`prior` is undefined): enable everything, UNLESS
 *   `enabledOperationIds` is given, in which case enable exactly those (the
 *   "all-selected-by-default, then deselect" UX - the UI sends the survivors).
 * - **Refresh** (`prior` given): KEEP each still-present op's prior enabled flag; a
 *   newly-appeared op defaults to OFF; a removed op drops. `enabledOperationIds` is
 *   ignored on refresh - the stored selection is the source of truth, so an evolving
 *   API never auto-grants new capabilities. The "still-present" match is keyed on
 *   `(operationId, method, path)`, not the id alone: if an upstream reuses an
 *   operationId but changes what it does (e.g. `getPet` flips GET→DELETE), that's a
 *   DIFFERENT capability and must re-default to OFF rather than inherit the grant.
 */
export function reconcile(
  discovered: IntegrationOperation[],
  prior: DiscoveredOperation[] | undefined,
  enabledOperationIds: string[] | undefined,
): DiscoveredOperation[] {
  if (!prior) {
    const pick = enabledOperationIds ? new Set(enabledOperationIds) : null;
    return discovered.map((op) => ({ ...op, enabled: pick ? pick.has(op.operationId) : true }));
  }
  const priorEnabled = new Map(prior.map((o) => [opKey(o), o.enabled]));
  return discovered.map((op) => ({ ...op, enabled: priorEnabled.get(opKey(op)) ?? false }));
}

/** Identity of an operation for reconcile: the id AND what it does (method + path). */
function opKey(op: IntegrationOperation): string {
  return `${op.operationId}\0${op.method}\0${op.path}`;
}

/** The materialized enabled subset (the agent-facing manifest) from a catalog. */
export function enabledOperations(catalog: DiscoveredOperation[]): IntegrationOperation[] {
  return catalog.filter((o) => o.enabled).map(({ enabled: _enabled, ...op }) => op);
}

/**
 * Re-apply a selection to an EXISTING catalog without re-fetching - used when a save
 * doesn't change the spec URL (a pure enable/disable toggle, or a name/description
 * edit), so an unrelated edit never triggers (or is blocked by) a spec fetch. If
 * `enabledOperationIds` is given, enable exactly those; if omitted, leave flags as-is.
 */
export function reselect(
  catalog: DiscoveredOperation[],
  enabledOperationIds: string[] | undefined,
): DiscoveredOperation[] {
  if (!enabledOperationIds) return catalog;
  const pick = new Set(enabledOperationIds);
  return catalog.map((o) => ({ ...o, enabled: pick.has(o.operationId) }));
}

/** A synced integration surface: the stored discovery block + the enabled manifest. */
export interface SyncedDiscovery {
  discovery: IntegrationDiscovery;
  operations: IntegrationOperation[];
}

/**
 * The full discovery flow the routes use: fetch + parse the spec, reconcile against
 * the prior catalog, and produce both the stored `discovery` block (full catalog +
 * per-op selection + sync time) and the materialized enabled `operations` (the
 * agent-facing manifest). One call for create/update (pass the user's selection) and
 * refresh (pass the prior catalog; selection is ignored - the stored flags win).
 * Returns a DiscoveryError (never throws) if the fetch/parse fails.
 */
export async function syncDiscovery(
  url: string,
  prior: DiscoveredOperation[] | undefined,
  enabledOperationIds: string[] | undefined,
  syncedAt: string,
  cred?: DiscoveryCredential,
  doFetch?: typeof fetch,
): Promise<SyncedDiscovery | DiscoveryError> {
  const result = await discoverOperations(url, cred, doFetch);
  if ("error" in result) return result;
  const catalog = reconcile(result.operations, prior, enabledOperationIds);
  return {
    discovery: { url, provider: result.provider, syncedAt, operations: catalog },
    operations: enabledOperations(catalog),
  };
}

/**
 * Re-fetch a stored discovery block's spec and reconcile against ITS catalog (kept
 * enabled flags win; new ops default OFF). The refresh primitive shared by the manual
 * refresh endpoint and the scheduled sweep - both wrap the result onto their record.
 * `cred` carries the integration's credential so an auth-gated spec still fetches.
 */
export function refreshDiscovery(
  prior: IntegrationDiscovery,
  syncedAt: string,
  cred?: DiscoveryCredential,
  doFetch?: typeof fetch,
): Promise<SyncedDiscovery | DiscoveryError> {
  return syncDiscovery(prior.url, prior.operations, undefined, syncedAt, cred, doFetch);
}

/**
 * OpenAPI (JSON) provider: read `paths[path][method].operationId/summary` from an
 * OpenAPI 3 or Swagger 2 document. Returns null if the document doesn't look like
 * OpenAPI (so the registry falls through to the next provider).
 */
function openapiProvider(): DiscoveryProvider {
  return {
    kind: "openapi",
    parse({ body }) {
      let doc: unknown;
      try {
        doc = JSON.parse(body);
      } catch {
        return null; // not JSON - not this provider (YAML specs aren't supported yet)
      }
      if (typeof doc !== "object" || doc === null) return null;
      const d = doc as Record<string, unknown>;
      // The OpenAPI/Swagger marker + a paths object are what identify the format.
      if (!("openapi" in d) && !("swagger" in d)) return null;
      const paths = d.paths;
      if (typeof paths !== "object" || paths === null) return null;

      const out: RawOperation[] = [];
      for (const [path, itemRaw] of Object.entries(paths as Record<string, unknown>)) {
        if (typeof itemRaw !== "object" || itemRaw === null) continue;
        const item = itemRaw as Record<string, unknown>;
        for (const method of ["get", "post", "put", "patch", "delete"]) {
          const opRaw = item[method];
          if (typeof opRaw !== "object" || opRaw === null) continue;
          const op = opRaw as Record<string, unknown>;
          out.push({
            operationId: deriveOperationId(op.operationId, method, path),
            summary: deriveSummary(op.summary, op.description, method, path),
            method: method.toUpperCase(),
            path,
          });
        }
      }
      return out;
    },
  };
}

/**
 * The operationId to name the op by: the spec's own if it's a clean slug, else a
 * derived `<method><PascalPath>` (e.g. GET /pets/{id} -> getPetsId). The result is
 * still gated by `parseOperation`'s OPERATION_ID_RE afterwards.
 */
function deriveOperationId(specId: unknown, method: string, path: string): string {
  if (typeof specId === "string" && specId.trim()) {
    // Sanitize to the operationId charset; if that leaves nothing usable, derive one.
    const cleaned = specId.trim().replace(/[^A-Za-z0-9_-]/g, "");
    if (/^[A-Za-z]/.test(cleaned)) return cleaned.slice(0, 128);
  }
  const segments = path.split("/").filter(Boolean).map((s) => s.replace(/[{}]/g, ""));
  const pascal = segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("").replace(/[^A-Za-z0-9]/g, "");
  return `${method}${pascal}`.slice(0, 128) || method;
}

/** A one-line model-facing summary: the spec's summary/description, else a synthesized one. */
function deriveSummary(summary: unknown, description: unknown, method: string, path: string): string {
  if (typeof summary === "string" && summary.trim()) return summary.trim().slice(0, 500);
  if (typeof description === "string" && description.trim()) return description.trim().slice(0, 500);
  return `${method.toUpperCase()} ${path}`;
}
