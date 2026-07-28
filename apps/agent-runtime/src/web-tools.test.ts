import { describe, it, expect, vi, afterEach } from "vitest";
import { buildFetchTool, isPrivateAddress } from "./web-tools.js";
import { BLOCKED_ADDRESSES, ALLOWED_ADDRESSES } from "@agency/shared";

/** Invoke the fetch_webpage tool with a url (Strands tools expose `invoke`). */
function fetchTool() {
  const t = buildFetchTool() as unknown as {
    invoke: (args: { url: string }) => Promise<Record<string, unknown>>;
  };
  return (url: string) => t.invoke({ url });
}

afterEach(() => vi.unstubAllGlobals());

describe("fetch_webpage SSRF guard", () => {
  it("blocks a non-https URL up front", async () => {
    const r = await fetchTool()("http://example.com/");
    expect(r.error).toBe("blocked_url");
  });

  it("blocks URLs with embedded credentials", async () => {
    const r = await fetchTool()("https://user:pass@example.com/");
    expect(r.error).toBe("blocked_url");
  });

  it("blocks a literal private/loopback address", async () => {
    // 127.0.0.1 is a literal IP → no DNS, guard classifies it private directly.
    const r = await fetchTool()("https://127.0.0.1/");
    expect(r.error).toBe("blocked_url");
  });

  it("blocks the cloud-metadata address", async () => {
    const r = await fetchTool()("https://169.254.169.254/latest/meta-data/");
    expect(r.error).toBe("blocked_url");
  });

  it("blocks IPv4-mapped IPv6 in dotted AND hex form (regression: hex slipped through)", async () => {
    // ::ffff:7f00:1 = 127.0.0.1, ::ffff:a9fe:a9fe = 169.254.169.254 (metadata).
    for (const host of ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:a9fe:a9fe]", "[64:ff9b::a9fe:a9fe]"]) {
      const r = await fetchTool()(`https://${host}/latest/meta-data/`);
      expect(r.error, `${host} must be blocked`).toBe("blocked_url");
    }
  });

  it("blocks EVERY IPv6 spelling of an embedded v4, not just the ::ffff: prefix", async () => {
    // A prefix test can't classify IPv6: one address has many spellings. Each of these
    // is a way to write a loopback/metadata address that no `::ffff:`-prefix check
    // catches - `0:0:0:0:0:0:a9fe:a9fe` is 169.254.169.254 uncompressed.
    for (const host of [
      "[::a9fe:a9fe]", // ::169.254.169.254, the IPv4-compatible form
      "[0:0:0:0:0:0:a9fe:a9fe]", // the same address, uncompressed
      "[::7f00:1]", // ::127.0.0.1
      "[::ffff:0:7f00:1]", // IPv4-translated
      "[2002:a9fe:a9fe::1]", // 6to4 wrapping the metadata address
    ]) {
      const r = await fetchTool()(`https://${host}/latest/meta-data/`);
      expect(r.error, `${host} must be blocked`).toBe("blocked_url");
    }
  });

  it("still allows a globally routable IPv6 host", async () => {
    // The expansion rules must not overreach into real public v6 space.
    vi.stubGlobal("fetch", async () => new Response("hi", { headers: { "content-type": "text/plain" } }));
    const r = await fetchTool()("https://[2606:4700:4700::1111]/");
    expect(r.error).toBeUndefined();
  });

  it("re-validates redirects: a public URL that 302s to a private IP is blocked", async () => {
    // The load-bearing regression: redirect:"manual" + per-hop re-validation must
    // catch a bounce to the metadata/loopback address, which fetch's own
    // redirect:"follow" would have silently followed.
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const u = String(input);
      // A public host (1.1.1.1 is global) redirects to the metadata endpoint.
      if (u.startsWith("https://1.1.1.1/")) {
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      }
      // If the guard were bypassed we'd reach here - return a sentinel body.
      return new Response("SECRET", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const r = await fetchTool()("https://1.1.1.1/redir");
    expect(r.error).toBe("blocked_url");
    expect(r.content).toBeUndefined();
  });

  it("fetches a public https page and returns readable text", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response("<html><title>Hi</title><body><p>Hello world</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const r = await fetchTool()("https://1.1.1.1/page");
    expect(r.error).toBeUndefined();
    expect(String(r.content)).toContain("Hello world");
    expect(r.truncated).toBe(false);
  });
});

describe("isPrivateAddress vs the shared policy table", () => {
  // The control-plane's outbound.test.ts asserts the SAME shared table against
  // isBlockedHost, so the two guards can't drift without one of the tests failing.
  // (They can't share the guard code - see packages/shared/src/ssrf-policy.ts.)
  it("refuses every address in BLOCKED_ADDRESSES", () => {
    for (const ip of BLOCKED_ADDRESSES) {
      expect(isPrivateAddress(ip), `must refuse ${ip}`).toBe(true);
    }
  });

  it("allows every address in ALLOWED_ADDRESSES", () => {
    for (const ip of ALLOWED_ADDRESSES) {
      expect(isPrivateAddress(ip), `must allow ${ip}`).toBe(false);
    }
  });
});

describe("fetch_webpage truncation signal", () => {
  /** An HTML body streamed as the given chunks. */
  const html = (chunks: string[]) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
          c.close();
        },
      }),
      { headers: { "content-type": "text/html" } },
    );

  it("reports truncated when the byte cap cuts a body whose TEXT would fit", async () => {
    // The case the char-length check can't see: 5 MB of markup that extracts to well
    // under the 50k char cap, so `text.length > MAX_CHARS` is false and `capped` is the
    // only signal. Built from comment padding, which htmlToText strips entirely.
    const cap = 5 * 1024 * 1024;
    // The first chunk is EXACTLY the cap - the boundary case. It's a complete HTML
    // comment plus a short paragraph, so htmlToText strips nearly all of it and the
    // extracted text stays far under the char cap; `capped` is the only signal left.
    const prefix = "<p>short</p><!--";
    const head = `${prefix}${"p".repeat(cap - prefix.length - 3)}-->`;
    expect(Buffer.byteLength(head, "utf8")).toBe(cap);
    vi.stubGlobal("fetch", async () => html([head, "y".repeat(1024)]));
    const r = (await fetchTool()("https://example.com/big")) as { truncated?: boolean; content?: string };
    expect(r.content!.length).toBeLessThan(50_000); // the char cap did NOT trip
    expect(r.truncated).toBe(true); // ...so this can only come from the byte cap
  });

  it("does not report truncated for a body that fits", async () => {
    vi.stubGlobal("fetch", async () => html(["<p>hello world</p>"]));
    const r = (await fetchTool()("https://example.com/small")) as { truncated?: boolean };
    expect(r.truncated).toBe(false);
  });
});
