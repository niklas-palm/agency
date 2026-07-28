/**
 * The shared outbound SSRF anchor: isBlockedHost/validateOutboundUrl reject
 * internal targets, and guardedFetch re-validates every redirect hop, caps the body,
 * and STRIPS credential-bearing headers on a cross-origin redirect (a spec/token URL
 * isn't pinned to one origin, so a public host that 302s elsewhere can't harvest the
 * credential). doFetch is injected.
 */
import { describe, it, expect, vi } from "vitest";
import { isBlockedHost, validateOutboundUrl, guardedFetch, readCapped } from "./outbound.js";
import { BLOCKED_ADDRESSES, ALLOWED_ADDRESSES } from "@agency/shared";

describe("readCapped byte-cap fallback (no-stream Response)", () => {
  // Force the no-`res.body` branch with a bodyless Response, and a multi-byte body so a
  // char-vs-byte confusion would show. Cap is in BYTES.
  it("caps a multi-byte body by bytes and flags truncation", async () => {
    const res = { body: null, text: async () => "€€€€" } as unknown as Response; // 4 chars, 12 bytes
    const { text, truncated } = await readCapped(res, 6); // 6 bytes = 2 euro signs
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(6);
    expect(text).toBe("€€");
    expect(truncated).toBe(true); // 12 bytes > 6, not fooled by 4 chars < 6
  });
  it("does not flag a body that fits the byte cap", async () => {
    const res = { body: null, text: async () => "hi" } as unknown as Response;
    const { text, truncated } = await readCapped(res, 10);
    expect(text).toBe("hi");
    expect(truncated).toBe(false);
  });
});

describe("isBlockedHost", () => {
  it("blocks localhost + literal private/loopback/metadata IPs", () => {
    for (const h of ["localhost", "localhost.", "127.0.0.1", "169.254.169.254", "10.0.0.1", "192.168.1.1", "172.16.0.1", "100.64.0.1"]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });
  it("blocks IPv6 loopback/ULA/link-local + mapped/NAT64", () => {
    for (const h of ["[::1]", "[fd00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[64:ff9b::a9fe:a9fe]"]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });
  it("blocks EVERY IPv6 form that embeds a v4 address", () => {
    // The ::ffff:/64:ff9b: prefixes aren't the only ones. Node normalizes
    // `::169.254.169.254` to `::a9fe:a9fe` - no ::ffff: prefix, not caught by a
    // prefix check, and it reaches the metadata endpoint. 6to4 (2002::/16) wraps a
    // v4 the same way. A real public endpoint never presents itself in these forms.
    for (const h of [
      "[::a9fe:a9fe]", // ::169.254.169.254 - the metadata service
      "[0:0:0:0:0:0:a9fe:a9fe]", // same address, uncompressed
      "[::7f00:1]", // ::127.0.0.1
      "[2002:a9fe:a9fe::1]", // 6to4 wrapping the metadata address
      "[::ffff:0:7f00:1]",
    ]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });
  it("blocks the other IETF special-use v4 ranges", () => {
    // Not private, but not legitimate integration targets either - and several are
    // locally routable.
    for (const h of ["192.0.0.1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "255.255.255.255"]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });
  it("allows public hosts + public literal IPs", () => {
    expect(isBlockedHost("api.example.com")).toBe(false);
    expect(isBlockedHost("8.8.8.8")).toBe(false);
    // Globally routable v6 must still pass - the ::-prefix rule must not overreach.
    expect(isBlockedHost("[2606:4700:4700::1111]")).toBe(false);
    expect(isBlockedHost("[2001:4860:4860::8888]")).toBe(false);
  });
});

describe("validateOutboundUrl", () => {
  it("accepts a public https URL (query allowed, unlike baseUrl)", () => {
    expect(validateOutboundUrl("https://api.example.com/openapi.json?v=1")).toBe("https://api.example.com/openapi.json?v=1");
  });
  it("rejects cleartext http (these URLs carry a credential)", () => {
    expect(validateOutboundUrl("http://api.example.com/openapi.json")).toBeNull();
  });
  it("rejects non-http(s), embedded creds, and blocked hosts", () => {
    expect(validateOutboundUrl("ftp://x.com")).toBeNull();
    expect(validateOutboundUrl("https://u:p@api.example.com")).toBeNull();
    expect(validateOutboundUrl("http://169.254.169.254/latest")).toBeNull();
  });
});

describe("guardedFetch", () => {
  const opts = { maxBytes: 1024, timeoutMs: 1000 };

  it("returns status + content-type + body on a direct 200", async () => {
    const doFetch = vi.fn(async () =>
      new Response("hello", { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }),
    ) as unknown as typeof fetch;
    const res = await guardedFetch("https://api.example.com/x", { method: "GET" }, opts, doFetch);
    expect(res).toEqual({ status: 200, contentType: "application/json", body: "hello" });
  });

  it("refuses a redirect to an internal host (SSRF pivot)", async () => {
    const doFetch = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
    ) as unknown as typeof fetch;
    const res = await guardedFetch("https://api.example.com/x", { method: "GET" }, opts, doFetch);
    expect(res).toMatchObject({ error: expect.stringContaining("redirect target") });
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it("STRIPS credential headers on a cross-origin redirect", async () => {
    const seen: Array<Record<string, string>> = [];
    let n = 0;
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push({ ...(init.headers as Record<string, string>) });
      n++;
      if (n === 1) return new Response(null, { status: 302, headers: { location: "https://other.example.org/spec" } });
      return new Response("ok", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const res = await guardedFetch(
      "https://api.example.com/openapi",
      { method: "GET", headers: { Authorization: "Bearer sekret", "x-api-key": "kkk", Accept: "application/json" } },
      { ...opts, credentialHeaders: ["x-api-key"] },
      doFetch,
    );
    expect(res).toMatchObject({ status: 200 });
    // First hop (same origin) carries the credential; second hop (cross-origin) does not.
    expect(seen[0]!.Authorization).toBe("Bearer sekret");
    expect(seen[0]!["x-api-key"]).toBe("kkk");
    expect(seen[1]!.Authorization).toBeUndefined();
    expect(seen[1]!["x-api-key"]).toBeUndefined();
    expect(seen[1]!.Accept).toBe("application/json"); // non-credential header survives
  });

  it("REFUSES a cross-origin redirect when the credential is in the body", async () => {
    // authStyle:"body" puts client_secret in the form body, which can't be stripped
    // like a header - so a cross-origin hop must be refused, not followed.
    const doFetch = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://attacker.example.net/collect" } }),
    ) as unknown as typeof fetch;
    const res = await guardedFetch(
      "https://provider.example.com/token",
      { method: "POST", body: "grant_type=client_credentials&client_secret=SEKRET" },
      { ...opts, credentialInBody: true },
      doFetch,
    );
    expect(res).toMatchObject({ error: expect.stringContaining("cross-origin redirect") });
    expect(doFetch).toHaveBeenCalledOnce(); // never fetched the attacker host
  });

  it("allows a SAME-origin redirect even when the credential is in the body", async () => {
    let n = 0;
    const doFetch = vi.fn(async () => {
      n++;
      if (n === 1) return new Response(null, { status: 302, headers: { location: "https://provider.example.com/token2" } });
      return new Response('{"access_token":"x"}', { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const res = await guardedFetch(
      "https://provider.example.com/token",
      { method: "POST", body: "client_secret=SEKRET" },
      { ...opts, credentialInBody: true },
      doFetch,
    );
    expect(res).toMatchObject({ status: 200 });
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("KEEPS credential headers on a same-origin redirect", async () => {
    const seen: Array<Record<string, string>> = [];
    let n = 0;
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push({ ...(init.headers as Record<string, string>) });
      n++;
      if (n === 1) return new Response(null, { status: 302, headers: { location: "https://api.example.com/spec/full" } });
      return new Response("ok", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await guardedFetch(
      "https://api.example.com/openapi",
      { method: "GET", headers: { Authorization: "Bearer sekret" } },
      opts,
      doFetch,
    );
    expect(seen[1]!.Authorization).toBe("Bearer sekret"); // same origin → kept
  });

  it("caps the body at maxBytes", async () => {
    const doFetch = vi.fn(async () => new Response("A".repeat(5000), { status: 200 })) as unknown as typeof fetch;
    const res = await guardedFetch("https://api.example.com/x", { method: "GET" }, { maxBytes: 100, timeoutMs: 1000 }, doFetch);
    expect((res as { body: string }).body.length).toBe(100);
  });

  it("returns an error (never throws) on a transport failure", async () => {
    const doFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await guardedFetch("https://api.example.com/x", { method: "GET" }, opts, doFetch);
    expect(res).toMatchObject({ error: "request failed" });
  });
});

describe("isBlockedHost vs the shared policy table", () => {
  // The same table is asserted against the RUNTIME's isPrivateAddress in
  // apps/agent-runtime/src/web-tools.test.ts. Both guards implement one policy in two
  // packages and can't share code, so this pair of tests keeps them in step - three
  // IPv4 special-use ranges once reached only this side.
  it("refuses every address in BLOCKED_ADDRESSES", () => {
    for (const ip of BLOCKED_ADDRESSES) {
      expect(isBlockedHost(ip), `must refuse ${ip}`).toBe(true);
    }
  });

  it("allows every address in ALLOWED_ADDRESSES", () => {
    for (const ip of ALLOWED_ADDRESSES) {
      expect(isBlockedHost(ip), `must allow ${ip}`).toBe(false);
    }
  });
});
