/**
 * The integrations proxy forwarding logic: URL composition is the SSRF anchor
 * (only baseUrl + declared operation path, no agent-supplied host), credential
 * injection is per auth kind and never leaks to the caller, and downstream
 * failures come back as { error, hint } (never throw). doFetch is injected.
 */
import { describe, it, expect, vi } from "vitest";
import type { IntegrationCallRequest } from "@agency/shared";
import { buildUrl, forwardCall, MAX_LARGE_RESPONSE_BYTES } from "./integration-proxy.js";
import type { IntegrationRecord } from "./repo/integrations.js";

const OP_GET = { operationId: "getPet", summary: "Get a pet", method: "GET" as const, path: "/pets/{id}" };
const OP_POST = { operationId: "createPet", summary: "Create", method: "POST" as const, path: "/pets" };

function record(over: Partial<IntegrationRecord> = {}): IntegrationRecord {
  return {
    id: "int-1",
    orgId: "org-A",
    createdBy: "user-A",
    shared: true,
    name: "Petstore",
    description: "d",
    baseUrl: "https://api.example.com/v1",
    auth: { kind: "bearer" },
    operations: [OP_GET, OP_POST],
    secret: "tok-secret",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}
function call(over: Partial<IntegrationCallRequest> = {}): IntegrationCallRequest {
  return { agentId: "a", sessionId: "s", integrationId: "int-1", operationId: "getPet", ...over };
}

describe("buildUrl", () => {
  it("composes baseUrl + path with placeholders + query", () => {
    const url = buildUrl("https://api.example.com/v1", OP_GET, call({ pathParams: { id: "42" }, query: { verbose: "1" } }));
    expect(url).toBe("https://api.example.com/v1/pets/42?verbose=1");
  });

  it("url-encodes path params", () => {
    const url = buildUrl("https://api.example.com/v1", OP_GET, call({ pathParams: { id: "a b/c" } }));
    // "/" in a value is rejected (would add a segment), so this is an error...
    expect(typeof url).toBe("object");
    const url2 = buildUrl("https://api.example.com/v1", OP_GET, call({ pathParams: { id: "a b" } }));
    expect(url2).toBe("https://api.example.com/v1/pets/a%20b");
  });

  it("errors when a placeholder is missing", () => {
    const r = buildUrl("https://api.example.com/v1", OP_GET, call({ pathParams: {} }));
    expect(r).toMatchObject({ error: expect.stringContaining("pathParams") });
  });

  it("rejects traversal in a path param (no escaping the base)", () => {
    const r = buildUrl("https://api.example.com/v1", OP_GET, call({ pathParams: { id: ".." } }));
    expect(typeof r).toBe("object");
    expect(r).toHaveProperty("error");
  });

  it("treats null pathParams as absent (a hostile raw body can't crash the proxy)", () => {
    // A compromised agent could POST { pathParams: null } directly; a default param
    // only fills for undefined, so this must be guarded to a clean error, not a throw.
    const r = buildUrl("https://api.example.com/v1", OP_GET, call({ pathParams: null as never }));
    expect(r).toMatchObject({ error: expect.stringContaining("pathParams") });
  });

  it("keeps the base path prefix (operation path can't climb above it)", () => {
    // A well-formed op path always starts with "/" and has no "..", so the result
    // is always under baseUrl - assert the prefix holds for a nested base.
    const url = buildUrl("https://api.example.com/tenant/9", OP_POST, call({ operationId: "createPet" }));
    expect(url).toBe("https://api.example.com/tenant/9/pets");
  });
});

describe("forwardCall", () => {
  it("injects a bearer credential and returns status + body (secret never in result)", async () => {
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-secret");
      return new Response("pong", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await forwardCall(record(), call({ pathParams: { id: "42" } }), doFetch);
    expect(res).toEqual({ status: 200, body: "pong" });
    expect(JSON.stringify(res)).not.toContain("tok-secret");
  });

  it("injects an apiKey header", async () => {
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("tok-secret");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await forwardCall(record({ auth: { kind: "apiKey", header: "X-Api-Key" } }), call({ pathParams: { id: "1" } }), doFetch);
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it("sends no credential for auth kind none", async () => {
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      expect(h.Authorization).toBeUndefined();
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;
    await forwardCall(record({ auth: { kind: "none" }, secret: undefined }), call({ pathParams: { id: "1" } }), doFetch);
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it("forwards the calling agent id as a non-secret provenance header", async () => {
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["X-Agency-Agent-Id"]).toBe("agent-42");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await forwardCall(record(), call({ agentId: "agent-42", pathParams: { id: "1" } }), doFetch);
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it("mints + injects an OAuth2 client-credentials token (secret never in result)", async () => {
    // First fetch is the token mint (to tokenUrl); second is the downstream call.
    const doFetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://auth.example.com")) {
        expect(init.method).toBe("POST");
        // Basic auth style: clientId:secret base64 in the Authorization header.
        const basic = (init.headers as Record<string, string>).Authorization;
        expect(basic).toBe(`Basic ${Buffer.from("cid:tok-secret").toString("base64")}`);
        return new Response(JSON.stringify({ access_token: "minted-abc", expires_in: 3600 }), { status: 200 });
      }
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer minted-abc");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const rec = record({
      auth: { kind: "oauth2Client", tokenUrl: "https://auth.example.com/token", clientId: "cid", authStyle: "basic" },
      secret: "tok-secret",
    });
    const res = await forwardCall(rec, call({ pathParams: { id: "1" } }), doFetch);
    expect(res).toEqual({ status: 200, body: "ok" });
    expect(JSON.stringify(res)).not.toContain("tok-secret");
    expect(JSON.stringify(res)).not.toContain("minted-abc");
  });

  it("returns { error, hint } when an OAuth token mint fails (never an unauthenticated call)", async () => {
    const doFetch = vi.fn(async (url: string) => {
      if (url.startsWith("https://auth.example.com")) return new Response("nope", { status: 401 });
      throw new Error("should not reach downstream without a token");
    }) as unknown as typeof fetch;
    const rec = record({
      // Distinct clientId so the module's token cache doesn't serve a prior test's token.
      auth: { kind: "oauth2Client", tokenUrl: "https://auth.example.com/token", clientId: "cid-fail", authStyle: "body" },
      secret: "tok-secret",
    });
    const res = await forwardCall(rec, call({ pathParams: { id: "1" } }), doFetch);
    expect(res).toMatchObject({ error: "could not authenticate to the integration" });
  });

  it("serializes a JSON body for write methods", async () => {
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ name: "Rex" }));
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    await forwardCall(record(), call({ operationId: "createPet", body: { name: "Rex" } }), doFetch);
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it("errors on an unknown operationId (with a discovery hint)", async () => {
    const res = await forwardCall(record(), call({ operationId: "nope" }));
    expect(res).toMatchObject({ error: "unknown operation" });
  });

  it("returns an { error, hint } on a transport failure, never throws", async () => {
    const doFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await forwardCall(record(), call({ pathParams: { id: "1" } }), doFetch);
    expect(res).toMatchObject({ error: "downstream request failed" });
  });

  it("refuses to follow a redirect that escapes the base URL (no SSRF pivot)", async () => {
    // A registered/compromised downstream 302s to an internal host. Following it
    // would defeat the SSRF anchor AND replay a custom apiKey header off-base.
    const doFetch = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
    ) as unknown as typeof fetch;
    const res = await forwardCall(
      record({ auth: { kind: "apiKey", header: "X-Api-Key" } }),
      call({ pathParams: { id: "1" } }),
      doFetch,
    );
    expect(res).toMatchObject({ error: "downstream redirect escapes baseUrl" });
    expect(doFetch).toHaveBeenCalledOnce(); // never fetched the redirect target
  });

  it("follows an on-base redirect and returns the final body", async () => {
    let call_n = 0;
    const doFetch = vi.fn(async () => {
      call_n++;
      if (call_n === 1) {
        return new Response(null, { status: 302, headers: { location: "https://api.example.com/v1/pets/42/full" } });
      }
      return new Response("final", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await forwardCall(record(), call({ pathParams: { id: "42" } }), doFetch);
    expect(res).toEqual({ status: 200, body: "final" });
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("caps a huge downstream body without buffering it whole (memory guard)", async () => {
    // Stream far more than the 256 KiB cap in small chunks; the reader must stop at
    // the cap rather than accumulating the entire body.
    const CAP = 256 * 1024;
    const chunk = new Uint8Array(64 * 1024).fill(65); // "A"
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 1000) return controller.close(); // safety: fail loud if uncapped
        controller.enqueue(chunk);
      },
    });
    const doFetch = vi.fn(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const res = await forwardCall(record(), call({ pathParams: { id: "1" } }), doFetch);
    expect(res).toMatchObject({ status: 200 });
    const body = (res as { body: string }).body;
    expect(body.length).toBe(CAP);
    expect(pulls).toBeLessThan(1000); // stopped early, did not drain the infinite stream
  });

  it("uses the LARGE cap when largeResponse is set (persist-to-disk path)", async () => {
    // A ~1 MiB body: rejected past the 256 KiB default, but kept whole under the large
    // cap. Proves the cap actually switches on the request flag.
    const size = 1024 * 1024;
    const doFetch = vi.fn(async () => new Response("B".repeat(size + 10), { status: 200 })) as unknown as typeof fetch;
    const small = await forwardCall(record(), call({ pathParams: { id: "1" } }), doFetch);
    expect((small as { body: string }).body.length).toBe(256 * 1024); // default cap
    expect((small as { truncated?: boolean }).truncated).toBe(true); // exceeded 256 KiB → flagged

    const large = await forwardCall(record(), call({ pathParams: { id: "1" }, largeResponse: true }), doFetch);
    expect((large as { body: string }).body.length).toBe(size + 10); // whole body kept, under the large cap
    expect((large as { truncated?: boolean }).truncated).toBeUndefined(); // fit → not flagged
  });

  it("STILL caps largeResponse at the large ceiling (bounded, not unlimited) and flags truncation", async () => {
    const chunk = new Uint8Array(512 * 1024).fill(67); // "C"
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 1000) return controller.close();
        controller.enqueue(chunk);
      },
    });
    const doFetch = vi.fn(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const res = await forwardCall(record(), call({ pathParams: { id: "1" }, largeResponse: true }), doFetch);
    expect((res as { body: string }).body.length).toBe(MAX_LARGE_RESPONSE_BYTES);
    expect((res as { truncated?: boolean }).truncated).toBe(true); // hit the cap → agent must page
    expect(pulls).toBeLessThan(1000); // stopped at the large cap, didn't drain forever
  });

  it("keeps the large cap under the Lambda ~6 MB ceiling once JSON-escaped (worst-case ~2x)", async () => {
    // The body is returned via c.json({status,body}); a quote-heavy body ~doubles under
    // escaping. Guard that the RAW cap × 2 stays under the 6 MB Lambda response limit, so
    // a full-cap reply doesn't blow the transport. (Documents the sizing rationale.)
    expect(MAX_LARGE_RESPONSE_BYTES * 2).toBeLessThan(6 * 1024 * 1024);
  });

  it("does NOT flag truncation for a body exactly at the cap", async () => {
    const exact = "D".repeat(256 * 1024);
    const doFetch = vi.fn(async () => new Response(exact, { status: 200 })) as unknown as typeof fetch;
    const res = await forwardCall(record(), call({ pathParams: { id: "1" } }), doFetch);
    expect((res as { body: string }).body.length).toBe(256 * 1024);
    expect((res as { truncated?: boolean }).truncated).toBeUndefined(); // full, not cut off
  });
});
