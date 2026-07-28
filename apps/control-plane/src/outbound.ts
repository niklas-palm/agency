/**
 * Outbound-request safety for the control-plane's platform-position calls to
 * tenant-supplied URLs (an integration's downstream `baseUrl`, its OAuth `tokenUrl`,
 * its discovery spec URL). The control-plane runs with platform network position,
 * so a tenant URL aimed at cloud metadata or an internal service is an SSRF risk -
 * this module is the single anchor that refuses those targets.
 *
 * `isBlockedHost` is the literal-IP/localhost guard (shared by baseUrl validation
 * and every outbound fetch). `guardedFetch` is the fetch used for token minting +
 * discovery: it re-validates the host on every redirect hop (so a 3xx can't bounce
 * off to an internal host), enforces a wall-clock deadline, and caps the body it
 * buffers. The proxy's own forwarding (integration-proxy.ts) keeps its baseUrl-anchored
 * check; this covers the calls that aren't anchored to a stored baseUrl.
 *
 * Known residual (shared with web-tools.ts + the proxy): a hostname that RESOLVES to
 * a private/metadata address still slips past a literal-IP guard - closing it needs
 * socket-level IP pinning. See CLAUDE.md.
 */
import { isIP } from "node:net";

/** True for localhost or a literal private/loopback/link-local/CGNAT IP (v4+v6). */
export function isBlockedHost(host: string): boolean {
  // Strip a trailing dot (the rooted-FQDN form `localhost.` still resolves to loopback).
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost") return true;
  // URL wraps IPv6 literals in brackets; strip them for classification.
  const ip = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    // Other IETF special-use ranges. None is a legitimate integration endpoint, and
    // several are locally routable (192.0.0.0/24 protocol assignments, the
    // 198.18.0.0/15 benchmark range), so they're refused rather than forwarded.
    // 192.0.0.0/24 only - NOT the whole /16. The rest of 192.0/16 is ordinary routable
    // space (wordpress.com and gravatar.com live in 192.0.78/79), so matching two octets
    // refused real integration targets.
    if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast (224/4), reserved (240/4), broadcast
    return false;
  }
  if (isIP(ip) === 6) {
    // Expand to full 8-hextet form FIRST. A textual prefix check can't be trusted on
    // IPv6: the same address has many spellings, and `0:0:0:0:0:0:a9fe:a9fe` is the
    // metadata endpoint written so that no `::`-prefix test matches it.
    const groups = expandIpv6(ip);
    if (!groups) return true; // unparseable as expected → refuse rather than guess
    const [g0, g1, g2, g3, g4, g5] = groups;
    const allZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
    if (allZero && g4 === 0 && g5 === 0 && groups[6] === 0 && groups[7]! <= 1) return true; // :: and ::1
    if ((g0! & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
    if ((g0! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    // Every form that embeds an IPv4 address routes to that address while skipping the
    // v4 branch above, so each must be refused: IPv4-mapped (::ffff:a.b.c.d), the
    // deprecated IPv4-compatible form (::a.b.c.d - i.e. the first six hextets zero),
    // NAT64 (64:ff9b::/96), and 6to4 (2002::/16). No real public endpoint presents
    // itself this way.
    // Mapped is ::ffff:0:0/96 (hextet 5 = ffff); TRANSLATED is ::ffff:0:0:0/96
    // (hextet 4 = ffff, hextet 5 = 0); compatible is all six leading hextets zero.
    if (allZero && ((g4 === 0 && (g5 === 0 || g5 === 0xffff)) || (g4 === 0xffff && g5 === 0))) return true;
    if (g0 === 0x64 && g1 === 0xff9b) return true; // NAT64
    if (g0 === 0x2002) return true; // 6to4
  }
  return false;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null if it doesn't parse.
 *
 * Handles `::` compression and a trailing dotted-quad (`::ffff:1.2.3.4`). Used so the
 * guard classifies the ADDRESS rather than one of its many textual spellings.
 */
function expandIpv6(ip: string): number[] | null {
  let text = ip.split("%")[0]!; // drop any zone id
  // A trailing dotted-quad becomes two hextets, so the rest can be parsed as hex.
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const o = dotted[1]!.split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    const hi = ((o[0]! << 8) | o[1]!).toString(16);
    const lo = ((o[2]! << 8) | o[3]!).toString(16);
    text = `${text.slice(0, -dotted[1]!.length)}${hi}:${lo}`;
  }
  const [head, tail, ...rest] = text.split("::");
  if (rest.length > 0) return null; // more than one "::" is invalid
  const parse = (part: string) => (part ? part.split(":").map((h) => parseInt(h, 16)) : []);
  const left = parse(head!);
  const right = tail === undefined ? [] : parse(tail);
  const fill = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : fill < 0) return null;
  const groups = [...left, ...Array(tail === undefined ? 0 : fill).fill(0), ...right];
  return groups.length === 8 && groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
    ? groups
    : null;
}

/**
 * Validate a tenant-supplied outbound URL (a `tokenUrl` / discovery spec URL). Unlike
 * a `baseUrl` this MAY carry a query string (a token/spec endpoint legitimately does).
 * Both callers are **credential-bearing** (the OAuth mint sends the client secret; the
 * spec fetch sends the integration credential), so this requires **https** - never
 * cleartext http, which would expose the secret in transit (matches the runtime's
 * https-only web-fetch guard). No embedded credentials, and the host must not be
 * localhost / a literal internal IP. Returns the canonical href, or null.
 */
export function validateOutboundUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null; // https-only: these URLs carry a credential
  if (u.username || u.password) return null;
  if (isBlockedHost(u.hostname)) return null;
  return u.toString();
}

/** A structured outbound failure (never thrown - callers handle it as data). */
export interface OutboundError {
  error: string;
}

export interface GuardedResponse {
  status: number;
  contentType: string;
  body: string;
}

/** Header names (lowercased) that carry a credential and must not cross an origin. */
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/**
 * Fetch a tenant-supplied URL safely: manual redirect following that re-validates
 * the host of every hop (so a 3xx can't pivot to an internal target), a wall-clock
 * deadline, and a byte cap on the buffered body. Returns the response (status +
 * content-type + capped text) or an OutboundError - never throws. `doFetch` is
 * injectable for tests.
 *
 * `opts.credentialHeaders` names the request headers that carry a credential (e.g.
 * `authorization` or a custom `x-api-key`, lowercased). Unlike the proxy's
 * baseUrl-anchored forward, a spec/token URL isn't pinned to one origin, so on a
 * redirect to a DIFFERENT origin those headers are STRIPPED - a public spec host that
 * 302s elsewhere can't harvest the credential. (`Authorization`/`Cookie` are always
 * treated as credential-bearing even if not named.)
 */
export async function guardedFetch(
  rawUrl: string,
  init: RequestInit,
  opts: {
    maxBytes: number;
    timeoutMs: number;
    maxRedirects?: number;
    credentialHeaders?: string[];
    /** True when `init.body` carries a credential (e.g. an OAuth `client_secret`). */
    credentialInBody?: boolean;
  },
  doFetch: typeof fetch = fetch,
): Promise<GuardedResponse | OutboundError> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const first = validateOutboundUrl(rawUrl);
  if (!first) return { error: "url is not a valid public http(s) URL" };
  const credNames = new Set([...CREDENTIAL_HEADERS, ...(opts.credentialHeaders ?? []).map((h) => h.toLowerCase())]);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let current = first;
    let headers = init.headers as Record<string, string> | undefined;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const res = await doFetch(current, { ...init, headers, redirect: "manual", signal: controller.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
        const nextUrl = new URL(res.headers.get("location")!, current);
        const next = validateOutboundUrl(nextUrl.toString());
        await res.body?.cancel().catch(() => {});
        if (!next) return { error: "redirect target is not a valid public http(s) URL" };
        if (hop === maxRedirects) return { error: "too many redirects" };
        const crossOrigin = nextUrl.origin !== new URL(current).origin;
        if (crossOrigin) {
          // A credential in the body (OAuth client_secret) can't be selectively
          // stripped from a form the way a header can, and a token/spec endpoint
          // 302'ing off-origin with credentials attached is not a legitimate flow -
          // refuse it rather than replay the secret to another host.
          if (opts.credentialInBody) return { error: "cross-origin redirect would leak credentials" };
          // Drop any credential-bearing header so it can't leak off-host.
          if (headers) {
            headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !credNames.has(k.toLowerCase())));
          }
        }
        current = next;
        continue;
      }
      const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const { text } = await readCapped(res, opts.maxBytes);
      return { status: res.status, contentType, body: text };
    }
    return { error: "too many redirects" };
  } catch (e) {
    return { error: e instanceof Error && e.name === "AbortError" ? "request timed out" : "request failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** A capped read: the (≤cap) text, and whether the body was cut off at the cap. */
export interface CappedBody {
  text: string;
  truncated: boolean;
}

/**
 * Read a response body as text, stopping once `cap` bytes are read (memory guard).
 * `truncated` is true when the body exceeded `cap` (so the caller can signal that the
 * data is partial - silently cutting a dataset mid-record would make downstream
 * computation wrong with no error). Determined precisely: we stop reading at the cap,
 * but peek whether any more bytes exist so an exactly-`cap` body isn't mislabelled.
 */
export async function readCapped(res: Response, cap: number): Promise<CappedBody> {
  if (!res.body) {
    // Defensive path for a Response with no stream (test doubles / polyfills). Cap by
    // BYTES to match the streaming path: slice the UTF-8 bytes at the cap and decode.
    const bytes = new TextEncoder().encode(await res.text());
    if (bytes.length <= cap) return { text: new TextDecoder().decode(bytes), truncated: false };
    return { text: new TextDecoder().decode(bytes.subarray(0, cap)), truncated: true };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > cap) {
        truncated = true; // this chunk carried bytes past the cap
        break;
      }
      if (total === cap) {
        // Exactly at the cap: peek one more read to tell "full" from "cut off".
        const { done: noMore } = await reader.read();
        truncated = !noMore;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(total, cap));
  let offset = 0;
  for (const chunk of chunks) {
    const room = buf.length - offset;
    if (room <= 0) break;
    buf.set(chunk.length > room ? chunk.subarray(0, room) : chunk, offset);
    offset += Math.min(chunk.length, room);
  }
  return { text: new TextDecoder().decode(buf), truncated };
}
