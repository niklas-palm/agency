/**
 * Auto-discovery: the OpenAPI provider extracts operations from a spec, every
 * candidate passes the shared safety gate, and reconcile is the load-bearing rule -
 * first import enables (all, or the user's pick); a refresh KEEPS prior selection and
 * defaults a newly-appeared op OFF, so an evolving API never auto-grants a capability.
 * The spec fetch goes through the SSRF-guarded outbound path (doFetch injected).
 */
import { describe, it, expect, vi } from "vitest";
import type { DiscoveredOperation } from "@agency/shared";
import { discoverOperations, reconcile, reselect, enabledOperations, syncDiscovery } from "./discover-operations.js";

const SPEC = {
  openapi: "3.0.0",
  paths: {
    "/pets": {
      get: { operationId: "listPets", summary: "List pets" },
      post: { operationId: "createPet", summary: "Create a pet" },
    },
    "/pets/{id}": {
      get: { operationId: "getPet", summary: "Get a pet" },
      delete: { summary: "Remove a pet" }, // no operationId → derived
    },
  },
};

function fetchReturning(body: unknown, init: { status?: number; contentType?: string } = {}): typeof fetch {
  return vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": init.contentType ?? "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("discoverOperations (OpenAPI provider)", () => {
  it("extracts operations from an OpenAPI document", async () => {
    const res = await discoverOperations("https://api.example.com/openapi.json", undefined, fetchReturning(SPEC));
    expect("operations" in res).toBe(true);
    if (!("operations" in res)) return;
    expect(res.provider).toBe("openapi");
    const ids = res.operations.map((o) => o.operationId);
    expect(ids).toContain("listPets");
    expect(ids).toContain("createPet");
    expect(ids).toContain("getPet");
    // The delete op had no operationId → derived <method><PascalPath>.
    const del = res.operations.find((o) => o.method === "DELETE");
    expect(del?.operationId).toBe("deletePetsId");
    expect(del?.path).toBe("/pets/{id}");
  });

  it("errors (not throws) when the URL returns a non-2xx", async () => {
    const res = await discoverOperations("https://api.example.com/openapi.json", undefined, fetchReturning("nope", { status: 404 }));
    expect(res).toMatchObject({ error: expect.stringContaining("404") });
  });

  it("errors when the document is not a recognized spec", async () => {
    const res = await discoverOperations("https://api.example.com/x", undefined, fetchReturning({ hello: "world" }));
    expect(res).toMatchObject({ error: expect.stringContaining("no discovery provider") });
  });

  it("errors when JSON is malformed (no provider recognizes it)", async () => {
    const res = await discoverOperations("https://api.example.com/x", undefined, fetchReturning("{not json", { contentType: "application/json" }));
    expect(res).toHaveProperty("error");
  });

  it("skips operations that fail the safety gate (bad method / traversal path)", async () => {
    const spec = {
      openapi: "3.0.0",
      paths: {
        "/ok": { get: { operationId: "okOp", summary: "fine" } },
        "/../escape": { get: { operationId: "evil", summary: "traversal path" } },
      },
    };
    const res = await discoverOperations("https://api.example.com/x", undefined, fetchReturning(spec));
    if (!("operations" in res)) throw new Error("expected operations");
    const ids = res.operations.map((o) => o.operationId);
    expect(ids).toContain("okOp");
    expect(ids).not.toContain("evil"); // "/../escape" path rejected by parseOperation
  });

  it("authenticates the spec fetch with the integration's apiKey credential", async () => {
    // The spec endpoint is gated by the same key: 401 unauthenticated, 200 with the key.
    // Try-both means the first (bare) attempt fails, then the credentialed retry works.
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)["x-api-key"];
      if (key !== "the-key") return new Response("nope", { status: 401 });
      return new Response(JSON.stringify(SPEC), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const res = await discoverOperations(
      "https://api.example.com/openapi.json",
      { auth: { kind: "apiKey", header: "x-api-key" }, secret: "the-key" },
      doFetch,
    );
    expect("operations" in res).toBe(true);
    expect(doFetch).toHaveBeenCalledTimes(2); // bare attempt + credentialed retry
  });

  it("authenticates with a bearer credential on the retry when the bare fetch 401s", async () => {
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      if ((init.headers as Record<string, string>).Authorization !== "Bearer bt") {
        return new Response("nope", { status: 401 });
      }
      return new Response(JSON.stringify(SPEC), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const res = await discoverOperations("https://api.example.com/openapi.json", { auth: { kind: "bearer" }, secret: "bt" }, doFetch);
    expect("operations" in res).toBe(true);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("fetches a PUBLIC spec WITHOUT sending the credential (no speculative exposure)", async () => {
    // The bare attempt succeeds, so the credential is never sent even though one exists.
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      return new Response(JSON.stringify(SPEC), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const res = await discoverOperations("https://api.example.com/openapi.json", { auth: { kind: "bearer" }, secret: "bt" }, doFetch);
    expect("operations" in res).toBe(true);
    expect(doFetch).toHaveBeenCalledOnce(); // no retry needed
  });

  it("surfaces a 403 as a discovery error when NO credential is available (not a throw)", async () => {
    const doFetch = fetchReturning('{"message":"Forbidden"}', { status: 403 });
    const res = await discoverOperations("https://api.example.com/openapi.json", undefined, doFetch);
    expect(res).toMatchObject({ error: expect.stringContaining("403") });
  });

  it("disambiguates a colliding derived operationId instead of dropping the op", async () => {
    // `/pets` and `/pets/` both derive `getPets` (no explicit operationId) - both must
    // survive the catalog, the second with a numeric suffix.
    const spec = { openapi: "3.0.0", paths: { "/pets": { get: { summary: "a" } }, "/pets/": { get: { summary: "b" } } } };
    const res = await discoverOperations("https://api.example.com/x", undefined, fetchReturning(spec));
    if (!("operations" in res)) throw new Error("expected operations");
    expect(res.operations).toHaveLength(2);
    const ids = res.operations.map((o) => o.operationId);
    expect(ids).toContain("getPets");
    expect(ids).toContain("getPets2");
  });

  it("keeps disambiguation distinct even at the operationId length cap", async () => {
    // Two explicit operationIds that share the first 128 chars: the suffix must survive
    // truncation (trim the base, not the suffix) so the ops don't collapse to one id.
    const longId = "a".repeat(200); // parseOperation slices to 128
    const spec = {
      openapi: "3.0.0",
      paths: { "/x": { get: { operationId: longId, summary: "a" } }, "/y": { get: { operationId: longId, summary: "b" } } },
    };
    const res = await discoverOperations("https://api.example.com/x", undefined, fetchReturning(spec));
    if (!("operations" in res)) throw new Error("expected operations");
    expect(res.operations).toHaveLength(2);
    const ids = res.operations.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(2); // distinct - not both truncated to the same 128 chars
    expect(ids.every((id) => id.length <= 128)).toBe(true);
  });
});

describe("reconcile", () => {
  const discovered = [
    { operationId: "a", summary: "A", method: "GET" as const, path: "/a" },
    { operationId: "b", summary: "B", method: "GET" as const, path: "/b" },
  ];

  it("first import enables ALL when no selection is given", () => {
    const out = reconcile(discovered, undefined, undefined);
    expect(out.every((o) => o.enabled)).toBe(true);
  });

  it("first import enables exactly the selected ids", () => {
    const out = reconcile(discovered, undefined, ["a"]);
    expect(out.find((o) => o.operationId === "a")?.enabled).toBe(true);
    expect(out.find((o) => o.operationId === "b")?.enabled).toBe(false);
  });

  it("refresh keeps prior enabled flags and defaults a NEW op OFF", () => {
    const prior: DiscoveredOperation[] = [
      { operationId: "a", summary: "A", method: "GET", path: "/a", enabled: true },
      { operationId: "b", summary: "B", method: "GET", path: "/b", enabled: false },
    ];
    const withNew = [...discovered, { operationId: "c", summary: "C", method: "GET" as const, path: "/c" }];
    // Selection is IGNORED on refresh - the stored flags are the source of truth.
    const out = reconcile(withNew, prior, ["a", "b", "c"]);
    expect(out.find((o) => o.operationId === "a")?.enabled).toBe(true); // kept
    expect(out.find((o) => o.operationId === "b")?.enabled).toBe(false); // kept
    expect(out.find((o) => o.operationId === "c")?.enabled).toBe(false); // new → OFF
  });

  it("refresh drops a removed op", () => {
    const prior: DiscoveredOperation[] = [
      { operationId: "a", summary: "A", method: "GET", path: "/a", enabled: true },
      { operationId: "gone", summary: "X", method: "GET", path: "/x", enabled: true },
    ];
    const out = reconcile(discovered, prior, undefined);
    expect(out.map((o) => o.operationId)).toEqual(["a", "b"]);
  });

  it("refresh re-defaults an op to OFF when a reused operationId changed method/path", () => {
    // Upstream reuses `a` but flips GET /a → DELETE /a: that's a DIFFERENT capability,
    // so it must NOT inherit the prior enabled grant (defeats "never silently grant").
    const prior: DiscoveredOperation[] = [
      { operationId: "a", summary: "A", method: "GET", path: "/a", enabled: true },
    ];
    const mutated = [{ operationId: "a", summary: "A", method: "DELETE" as const, path: "/a" }];
    const out = reconcile(mutated, prior, undefined);
    expect(out[0]!.enabled).toBe(false);
  });
});

describe("reselect + enabledOperations", () => {
  const catalog: DiscoveredOperation[] = [
    { operationId: "a", summary: "A", method: "GET", path: "/a", enabled: true },
    { operationId: "b", summary: "B", method: "GET", path: "/b", enabled: true },
  ];

  it("reselect applies a new selection to an existing catalog", () => {
    const out = reselect(catalog, ["b"]);
    expect(out.find((o) => o.operationId === "a")?.enabled).toBe(false);
    expect(out.find((o) => o.operationId === "b")?.enabled).toBe(true);
  });

  it("reselect leaves flags untouched when no selection is given", () => {
    expect(reselect(catalog, undefined)).toEqual(catalog);
  });

  it("enabledOperations materializes the enabled subset without the enabled flag", () => {
    const ops = enabledOperations(reselect(catalog, ["a"]));
    expect(ops).toEqual([{ operationId: "a", summary: "A", method: "GET", path: "/a" }]);
  });
});

describe("syncDiscovery", () => {
  it("fetches, reconciles (all enabled on first import), and materializes the enabled subset", async () => {
    const res = await syncDiscovery("https://api.example.com/openapi.json", undefined, undefined, "2026-07-22T00:00:00Z", undefined, fetchReturning(SPEC));
    if ("error" in res) throw new Error(res.error);
    expect(res.discovery.provider).toBe("openapi");
    expect(res.discovery.syncedAt).toBe("2026-07-22T00:00:00Z");
    expect(res.discovery.operations.every((o) => o.enabled)).toBe(true);
    expect(res.operations.length).toBe(res.discovery.operations.length); // all enabled → full manifest
  });
});
