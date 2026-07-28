/**
 * Web tools, layered on when an agent has web access (config.webSearch +
 * networkAccess). Two capabilities, mirroring the reference design:
 *
 *  - `web_search` - the AWS-managed **AgentCore Web Search** connector, reached
 *    through an AgentCore **Gateway** (an MCP endpoint). Keyless: requests are
 *    SigV4-signed with the runtime role's credentials. Provisioned once per
 *    platform (see infra); the gateway URL arrives via WEB_SEARCH_GATEWAY_URL.
 *  - `fetch_webpage` - a self-built tool: outbound HTTPS GET + HTML→text, with
 *    SSRF hardening (HTTPS only, private/loopback IPs blocked, size caps). No
 *    AWS service; just the runtime's public egress.
 *
 * Both follow the platform convention: never throw - return `{ error, hint }`.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { tool, McpClient } from "@strands-agents/sdk";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { WEB_SEARCH_REGION } from "./config.js";
import { z } from "zod";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB body cap
const MAX_CHARS = 50_000; // extracted-text cap handed to the model
const FETCH_TIMEOUT_MS = 15_000;
/**
 * Deadline for one call to the web-search gateway. Longer than a page fetch (the
 * gateway does the searching), but finite: the MCP client's `continueOnError` catches
 * errors, not hangs, so an unbounded request would let a black-hole gateway hold the
 * turn - and the billable microVM - open indefinitely.
 */
const GATEWAY_TIMEOUT_MS = 30_000;
const ALLOWED_CONTENT = ["text/html", "application/xhtml+xml", "text/plain", "application/json"];

/**
 * Reject anything that isn't a plain public-internet HTTPS URL: blocks non-HTTPS,
 * embedded credentials, and - after resolving DNS - any private/loopback/
 * link-local/reserved address (SSRF guard against hitting internal services or
 * cloud metadata). Returns an error hint string, or null if the URL is safe.
 * Re-run on every redirect hop (see buildFetchTool), so a public URL can't bounce
 * to a private target.
 *
 * Known residual (independent DNS resolution): this resolves the host once, but
 * `fetch` resolves it again independently - so a hostname that returns BOTH a
 * public and a private/metadata address (a static dual-record domain, no
 * rebinding or ~0-TTL needed) can pass the guard here while `fetch` connects to
 * the private one. Closing it needs socket-level IP pinning (a custom undici
 * dispatcher that connects only to the vetted IP). Left deferred - see CLAUDE.md.
 *
 * Literal-IP URLs are blocked regardless: numeric/octal/hex/short IPv4 forms
 * canonicalize to a dotted quad caught by isPrivateAddress, and bracketed IPv6
 * literals fail DNS resolution below ("could not resolve"). isPrivateAddress +
 * embeddedIpv4 additionally catch a bare IPv4-mapped/NAT64 v6 address returned by
 * DNS (dotted or hex form).
 */
async function unsafeUrlReason(raw: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Not a valid URL.";
  }
  if (u.protocol !== "https:") return "Only https:// URLs are allowed.";
  if (u.username || u.password) return "URLs with embedded credentials are not allowed.";
  // URL keeps IPv6 literals bracketed (`[::1]`); strip them so isIP recognizes the
  // literal instead of falling through to a DNS lookup of a bracketed string (which
  // fails, so v6 literals were refused as "unresolvable" rather than classified).
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost") return "Refusing to fetch localhost.";

  // Resolve to an IP and refuse non-global ranges (private, loopback, CGNAT,
  // link-local incl. the 169.254.169.254 metadata endpoint).
  const ip = isIP(host) ? host : (await lookup(host).catch(() => null))?.address;
  if (!ip) return "Could not resolve the host.";
  if (isPrivateAddress(ip)) return "Refusing to fetch a private/internal address.";
  return null;
}


/**
 * True for loopback/private/link-local/CGNAT/reserved IPv4+IPv6 ranges.
 *
 * Exported for the parity test that asserts this and the control-plane's
 * `isBlockedHost` agree - they implement one policy in two packages (see the IPv6 note
 * below for why they can't share code), so the drift has to be caught by a test.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    // The other IETF special-use ranges, several of which are locally routable. Kept
    // identical to the control-plane's isBlockedHost - a fetch target in one of these
    // is never a legitimate web page.
    // 192.0.0.0/24 only - NOT the whole /16. The rest of 192.0/16 is ordinary routable
    // space (wordpress.com and gravatar.com live in 192.0.78/79), so matching two octets
    // refused real integration targets.
    if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast (224/4), reserved (240/4), broadcast
    return false;
  }
  // IPv6. Classify the EXPANDED address, never a textual prefix: one address has many
  // spellings, and `0:0:0:0:0:0:a9fe:a9fe` is the metadata endpoint written so that no
  // `::`-prefix test matches it. (The control-plane's isBlockedHost in
  // apps/control-plane/src/outbound.ts applies the same rules to URL literals - keep
  // the two in step; they can't share code because `shared` is browser-bundled and
  // this needs node:net.)
  const groups = expandIpv6(ip);
  if (!groups) return true; // unparseable as expected → refuse rather than guess
  const [g0, g1, g2, g3, g4, g5] = groups;
  const allZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  if (allZero && g4 === 0 && g5 === 0 && groups[6] === 0 && groups[7]! <= 1) return true; // :: and ::1
  if ((g0! & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((g0! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  // Every form that embeds an IPv4 address routes to it: IPv4-mapped (::ffff:0:0/96),
  // IPv4-translated (::ffff:0:0:0/96), the deprecated IPv4-compatible form (::a.b.c.d),
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16). Refuse them all - no legitimate public
  // endpoint resolves to one, and each is a way to spell 169.254.169.254.
  if (allZero && ((g4 === 0 && (g5 === 0 || g5 === 0xffff)) || (g4 === 0xffff && g5 === 0))) return true;
  if (g0 === 0x64 && g1 === 0xff9b) return true; // NAT64
  if (g0 === 0x2002) return true; // 6to4
  return false;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null if it doesn't parse.
 *
 * Handles `::` compression and a trailing dotted-quad (`::ffff:1.2.3.4`), so the guard
 * above classifies the ADDRESS rather than one of its many textual spellings.
 */
function expandIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase().split("%")[0]!; // drop any zone id
  // A trailing dotted-quad becomes two hextets, so the rest parses as hex.
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

/** Strip HTML to readable text: drop script/style, tags → spaces, collapse space. */
function htmlToText(html: string): string {
  const noScript = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const title = noScript.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const text = noScript
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  return title ? `# ${title}\n\n${text}` : text;
}

const MAX_REDIRECTS = 5;

/** The keyless fetch tool - always available when web access is on. */
export function buildFetchTool() {
  return tool({
    name: "fetch_webpage",
    description:
      "Fetch a public web page over HTTPS and return its readable text content. Use after " +
      "web_search to read a result, or when given a URL directly.",
    inputSchema: z.object({ url: z.string().describe("An https:// URL to fetch.") }),
    callback: async ({ url }) => {
      // One AbortController spans validation + all redirect hops + the body read,
      // so a slow/dribbling body can't outlive the deadline (a header-only timer
      // would fire the moment headers arrive, before readCapped streams the body).
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try {
        // Follow redirects MANUALLY, re-validating every hop: `fetch`'s own
        // redirect:"follow" would jump to a 302 Location without re-running the
        // SSRF guard, letting a public URL bounce to 169.254.169.254 / a private
        // host / an http downgrade. We check each target before fetching it.
        let current = url;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          const reason = await unsafeUrlReason(current);
          if (reason) return { error: "blocked_url", hint: reason };
          const res = await fetch(current, {
            redirect: "manual",
            signal: ac.signal,
            headers: { "User-Agent": "Agency/1.0 (+https://agency)" },
          });

          if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
            if (hop === MAX_REDIRECTS) return { error: "too_many_redirects", hint: "The page redirected too many times." };
            current = new URL(res.headers.get("location")!, current).toString();
            await res.body?.cancel().catch(() => {}); // release the redirect response
            continue;
          }
          if (!res.ok) return { error: "http_error", hint: `The server returned ${res.status}.`, status: res.status };

          const ctype = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
          if (ctype && !ALLOWED_CONTENT.includes(ctype)) {
            return { error: "unsupported_content", hint: `Cannot read content type "${ctype}" (text/HTML only).` };
          }
          const { bytes, capped } = await readCapped(res, MAX_BYTES);
          const raw = new TextDecoder().decode(bytes);
          const text = ctype === "text/plain" || ctype === "application/json" ? raw : htmlToText(raw);
          // Truncated if EITHER the body was cut at the byte cap or the extracted text
          // exceeds the char budget - the model must know it isn't seeing everything.
          return {
            url: res.url || current,
            content: text.slice(0, MAX_CHARS),
            truncated: capped || text.length > MAX_CHARS,
          };
        }
        return { error: "too_many_redirects", hint: "The page redirected too many times." };
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        return {
          error: aborted ? "timeout" : "fetch_failed",
          hint: aborted ? "The page took too long to fetch." : `Could not fetch the page: ${(err as Error).message}`,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

/**
 * Build the AgentCore Web Search MCP client for `gatewayUrl`, SigV4-signed to
 * `bedrock-agentcore` with the runtime role's credentials (keyless - no API key).
 * The gateway is a managed MCP endpoint; its tools are added to the Agent by the
 * caller, which decides whether to wire it (only when a gateway URL is set).
 */
export function buildWebSearchClient(gatewayUrl: string): McpClient {
  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    // The gateway lives in us-east-1 (the only region with the managed connector);
    // sign to WEB_SEARCH_REGION, not the runtime's own region, so a eu-north-1
    // runtime reaches it cross-region.
    region: WEB_SEARCH_REGION,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  // A fetch that SigV4-signs each outbound request to the gateway before sending.
  const signedFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = { host: url.host };
    if (init?.headers) new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body != null ? String(init.body) : undefined;

    const signed = await signer.sign({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      body,
    });
    // Bound the request. `continueOnError` on the MCP client catches ERRORS but not
    // HANGS, so without a deadline a black-hole gateway holds the turn open (and the
    // microVM billable) indefinitely. An abort surfaces as an error the client
    // tolerates, so the turn continues without web search rather than stalling.
    const timeout = AbortSignal.timeout(GATEWAY_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(input, { ...init, headers: signed.headers, signal });
  };

  const transport = new StreamableHTTPClientTransport(new URL(gatewayUrl), { fetch: signedFetch });
  return new McpClient({ transport, continueOnError: true });
}

/**
 * Read a response body but stop after `cap` bytes (defends the 5 MB limit).
 *
 * Reports whether the body was cut. The caller can't infer that from the decoded
 * text: a huge page whose EXTRACTED text lands under the char cap would otherwise
 * look complete, so the model would treat a half-read page as the whole thing.
 */
async function readCapped(res: Response, cap: number): Promise<{ bytes: Uint8Array; capped: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const all = new Uint8Array(await res.arrayBuffer());
    return { bytes: all.slice(0, cap), capped: all.length > cap };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total >= cap) {
        // Peek once at the boundary: a chunk landing EXACTLY on the cap left
        // `total > cap` false, so a body that was cut reported itself complete - the
        // very thing this signal exists to prevent. (The control-plane's sibling
        // readCapped peeks the same way.)
        capped = total > cap || !(await reader.read()).done;
        break;
      }
    }
  } finally {
    // Always release the reader/stream - even if read() throws mid-body - so a
    // connection reset can't leak a locked stream on an abandoned Response.
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const c of chunks) {
    const room = out.length - off;
    if (room <= 0) break;
    out.set(c.subarray(0, room), off);
    off += c.length;
  }
  return { bytes: out, capped };
}
