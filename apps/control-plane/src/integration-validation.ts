/**
 * Validation of an integration create/update body from an untrusted request.
 * This is the trust boundary between the public API and a stored integration - a
 * bad `baseUrl` or operation shape here would surface later as a broken (or
 * unsafe) proxy call, so we reject it up front. Kept beside config-validation.ts
 * as a sibling boundary module.
 */
import type {
  IntegrationAuth,
  IntegrationInput,
  IntegrationMethod,
  IntegrationOperation,
} from "@agency/shared";
import { INTEGRATION_METHODS } from "@agency/shared";
import { isBlockedHost, validateOutboundUrl } from "./outbound.js";

const MAX_NAME = 200;
const MAX_DESCRIPTION = 2_000;
const MAX_BASE_URL = 2_000;
const MAX_HEADER = 128;
const MAX_SECRET = 8_192;
export const MAX_OPERATIONS = 100;
export const MAX_OPERATION_ID = 128;
const MAX_SUMMARY = 500;
const MAX_PATH = 2_000;

/** operationId: a JS-identifier-ish slug, so the model can name it unambiguously. */
const OPERATION_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** A header name: RFC 7230 token characters. */
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Parse a `baseUrl` into a normalized origin+path we can safely forward to, or
 * null if it's not a plain http(s) URL. Rejects credentials-in-URL, query, and
 * fragments (the proxy composes those from the call), and strips a trailing slash
 * so path-joining is unambiguous. This is the SSRF anchor: every proxied request
 * must resolve under this exact base.
 *
 * The proxy runs in platform infrastructure with platform network position, so it
 * also refuses `localhost` and any literal private/loopback/link-local/metadata IP
 * (`169.254.169.254`, `127.0.0.1`, `10.x`, ...) - otherwise a tenant could register
 * a baseUrl aimed at cloud metadata or an internal service and have the proxy fetch
 * it. (A hostname that resolves to a private IP is a deeper, DNS-dependent problem
 * shared with the runtime fetch tool - see CLAUDE.md; literal IPs are the reachable
 * case we close here.)
 */
export function normalizeBaseUrl(raw: string): string | null {
  if (raw.length > MAX_BASE_URL) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null; // no creds smuggled in the URL
  if (u.search || u.hash) return null; // the call supplies query; base is path-only
  if (isBlockedHost(u.hostname)) return null; // no metadata/internal targets
  // Rebuild from the safe parts so nothing unexpected rides along.
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** Cap on the OAuth `clientId` / `scope` / `audience` strings. */
const MAX_OAUTH_FIELD = 2_000;

export function parseAuth(value: unknown): IntegrationAuth | null {
  if (typeof value !== "object" || value === null) return null;
  const a = value as Record<string, unknown>;
  if (a.kind === "none") return { kind: "none" };
  if (a.kind === "bearer") return { kind: "bearer" };
  if (a.kind === "apiKey") {
    if (typeof a.header !== "string" || a.header.length > MAX_HEADER || !HEADER_RE.test(a.header)) return null;
    return { kind: "apiKey", header: a.header };
  }
  if (a.kind === "oauth2Client") {
    // tokenUrl is a new outbound target the proxy will POST to, so hold it to the
    // same SSRF guard as baseUrl (no localhost / literal internal IPs). It MAY carry
    // a query (token endpoints legitimately do), so use validateOutboundUrl not
    // normalizeBaseUrl.
    const tokenUrl = typeof a.tokenUrl === "string" && a.tokenUrl.length <= MAX_BASE_URL
      ? validateOutboundUrl(a.tokenUrl)
      : null;
    if (!tokenUrl) return null;
    if (typeof a.clientId !== "string" || !a.clientId.trim() || a.clientId.length > MAX_OAUTH_FIELD) return null;
    if (a.authStyle !== "basic" && a.authStyle !== "body") return null;
    const scope = optionalString(a.scope);
    const audience = optionalString(a.audience);
    if (scope === null || audience === null) return null; // present-but-invalid
    return {
      kind: "oauth2Client",
      tokenUrl,
      clientId: a.clientId.trim(),
      authStyle: a.authStyle,
      ...(scope ? { scope } : {}),
      ...(audience ? { audience } : {}),
    };
  }
  return null;
}

/**
 * An optional string field: returns the trimmed value, `""` if absent, or null if
 * present-but-wrong-type/too-long (so the caller can reject the whole body).
 */
function optionalString(v: unknown): string | null {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string" || v.length > MAX_OAUTH_FIELD) return null;
  return v.trim();
}

function parseOperations(value: unknown): IntegrationOperation[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPERATIONS) return null;
  const out: IntegrationOperation[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const op = parseOperation(raw);
    if (!op || seen.has(op.operationId)) return null; // invalid, or a duplicate operationId
    seen.add(op.operationId);
    out.push(op);
  }
  return out;
}

/**
 * Validate a single operation shape (the same rules for a hand-authored op and a
 * discovered one - the discovery provider builds candidates, this is the gate they
 * must pass so a spec can't smuggle a traversal path or a bad method). Returns the
 * normalized operation or null.
 */
export function parseOperation(raw: unknown): IntegrationOperation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.operationId !== "string" || o.operationId.length > MAX_OPERATION_ID ||
      !OPERATION_ID_RE.test(o.operationId)) return null;
  if (typeof o.summary !== "string" || !o.summary.trim() || o.summary.length > MAX_SUMMARY) return null;
  if (typeof o.method !== "string" || !INTEGRATION_METHODS.includes(o.method as never)) return null;
  // A path relative to baseUrl: must start with "/", no scheme/host, bounded.
  if (typeof o.path !== "string" || !o.path.startsWith("/") || o.path.length > MAX_PATH) return null;
  if (o.path.includes("://") || o.path.includes("..")) return null; // no absolute URL / traversal
  // Reject a PROTOCOL-RELATIVE (or backslash-authority) path: "//evil.com/x" starts
  // with "/" and has no "://", but `new URL("//evil.com/x", base)` resolves to a
  // DIFFERENT ORIGIN - which would aim the proxy (and its injected credential) off
  // base. The proxy's isUnderBase re-check catches it at call time, but a path that
  // can never be called has no business being stored: refuse it at the boundary.
  if (/^\/[/\\]/.test(o.path)) return null;
  return {
    operationId: o.operationId,
    summary: o.summary.trim(),
    method: o.method as IntegrationMethod,
    path: o.path,
  };
}

/** Cap on the length of a discovery URL. */
const MAX_DISCOVERY_URL = 2_000;
/** Cap on how many operation ids a selection may carry (bounded by MAX_OPERATIONS). */
const MAX_ENABLED_IDS = MAX_OPERATIONS;

/**
 * Parse the optional `discovery` input. Returns `undefined` when absent (manual
 * mode), the parsed spec `{ url, enabledOperationIds? }` when valid, or null when
 * present-but-invalid (so the caller rejects the body). The URL is SSRF-guarded
 * like every other outbound target.
 */
function parseDiscovery(
  value: unknown,
): { url: string; enabledOperationIds?: string[] } | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  const url = typeof d.url === "string" && d.url.length <= MAX_DISCOVERY_URL ? validateOutboundUrl(d.url) : null;
  if (!url) return null;
  if (d.enabledOperationIds === undefined) return { url }; // omitted = enable all discovered
  if (!Array.isArray(d.enabledOperationIds) || d.enabledOperationIds.length > MAX_ENABLED_IDS) return null;
  const ids = d.enabledOperationIds;
  if (!ids.every((s): s is string => typeof s === "string" && s.length <= MAX_OPERATION_ID)) return null;
  return { url, enabledOperationIds: [...new Set(ids)] };
}

/**
 * Validate an integration body. On success returns the normalized input (baseUrl
 * canonicalized, operations validated); on failure a list of what's wrong. The
 * `secret` is optional - omitting it on update leaves the stored credential
 * unchanged (the route handles that), and `auth.kind: "none"` needs none.
 *
 * Operations come from ONE of two sources: `discovery` (the server fetches + parses
 * a spec and materializes the operations) OR a hand-authored `operations` array
 * (manual mode). When `discovery` is set, `operations` is ignored; when it isn't, a
 * non-empty `operations` array is required.
 */
export function parseIntegrationBody(
  raw: unknown,
): { ok: true; value: IntegrationInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const b = raw as Record<string, unknown>;

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) errors.push("name is required");
  else if (name.length > MAX_NAME) errors.push("name is too long");

  const description = typeof b.description === "string" ? b.description.trim() : "";
  if (!description) errors.push("description is required");
  else if (description.length > MAX_DESCRIPTION) errors.push("description is too long");

  const baseUrl = typeof b.baseUrl === "string" ? normalizeBaseUrl(b.baseUrl.trim()) : null;
  if (!baseUrl) errors.push("baseUrl must be a valid http(s) URL with no credentials, query, or fragment");

  const auth = parseAuth(b.auth);
  if (!auth) {
    errors.push("auth must be { kind: 'none' | 'bearer' | 'apiKey' | 'oauth2Client', ... }");
  }

  const discovery = parseDiscovery(b.discovery);
  if (discovery === null) errors.push("discovery must be { url: <https URL>, enabledOperationIds?: string[] }");

  // Operations source: discovery (server derives them) XOR a hand-authored array.
  let operations: IntegrationOperation[] | undefined;
  if (!discovery) {
    operations = parseOperations(b.operations) ?? undefined;
    if (!operations) errors.push("operations must be a non-empty array of { operationId, summary, method, path }");
  }

  let secret: string | undefined;
  if ("secret" in b && b.secret !== undefined && b.secret !== null) {
    if (typeof b.secret !== "string" || b.secret.length > MAX_SECRET) {
      errors.push("secret must be a string");
    } else if (b.secret) {
      secret = b.secret;
    }
  }

  // Discoverability: present only when the body carries `shared` (so the route can
  // distinguish "flip it" from "leave as-is" on PATCH). Anything but explicit
  // `false` means shared - matching the create default (true) and skills/agents.
  const shared = "shared" in b ? b.shared !== false : undefined;

  // Managers: passed through verbatim when the body carries the key (the route's
  // resolveManagers validates each entry is an org member + drops the creator).
  // Preserving the key's presence lets a PATCH tell "set the list" from "leave it".
  const managers = "managers" in b && Array.isArray(b.managers) ? (b.managers as string[]) : undefined;

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      description,
      baseUrl: baseUrl!,
      auth: auth!,
      ...(operations ? { operations } : {}),
      ...(discovery ? { discovery } : {}),
      ...(secret ? { secret } : {}),
      ...(shared !== undefined ? { shared } : {}),
      ...(managers !== undefined ? { managers } : {}),
    },
  };
}
