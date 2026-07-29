/**
 * Runtime integration tools: discovery reads the in-memory manifest (no network),
 * and call_integration POSTs to the proxy via the ingest client (mocked). Both
 * follow the platform convention - never throw, return { error, hint }.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedIntegration } from "@agency/shared";

const postIngestRaw = vi.fn();
vi.mock("./ingest.js", () => ({ postIngestRaw: (...a: unknown[]) => postIngestRaw(...a) }));

// A real temp workspace so the outputPath tests exercise the actual file write +
// the shared sandboxed() confinement (WORK_ROOT is what workDir() reads).
const WORK = mkdtempSync(join(tmpdir(), "agency-itool-"));
process.env.WORK_ROOT = WORK;
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const { buildIntegrationTools, integrationCallLabel } = await import("./integration-tools.js");

const PETSTORE: ResolvedIntegration = {
  id: "int-pet",
  name: "Petstore",
  description: "Pet inventory API",
  operations: [
    { operationId: "listPets", summary: "List pets", method: "GET", path: "/pets" },
    { operationId: "getPet", summary: "Get a pet", method: "GET", path: "/pets/{id}" },
  ],
};
const CTX = { agentId: "agent-1", sessionId: "sess-1" };

function toolByName(tools: ReturnType<typeof buildIntegrationTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return (input: unknown) => (t as unknown as { invoke: (i: unknown) => Promise<unknown> }).invoke(input);
}

beforeEach(() => postIngestRaw.mockReset());

describe("buildIntegrationTools", () => {
  it("returns no tools when there are no integrations", () => {
    expect(buildIntegrationTools([], CTX)).toEqual([]);
  });

  it("exposes both tools when integrations are present", () => {
    const names = buildIntegrationTools([PETSTORE], CTX).map((t) => t.name).sort();
    expect(names).toEqual(["call_integration", "list_integration_operations"]);
  });

  it("list_integration_operations returns the manifest (no network)", async () => {
    const list = toolByName(buildIntegrationTools([PETSTORE], CTX), "list_integration_operations");
    const res = (await list({})) as { integrations: Array<{ integrationId: string; operations: unknown[] }> };
    expect(postIngestRaw).not.toHaveBeenCalled();
    expect(res.integrations).toHaveLength(1);
    expect(res.integrations[0]!.integrationId).toBe("int-pet");
    expect(res.integrations[0]!.operations).toHaveLength(2);
  });

  it("call_integration POSTs to the proxy with agentId/sessionId and returns the downstream body", async () => {
    postIngestRaw.mockResolvedValue({ ok: true, status: 200, json: { status: 200, body: "[]" } });
    const call = toolByName(buildIntegrationTools([PETSTORE], CTX), "call_integration");
    const res = await call({ integrationId: "int-pet", operationId: "listPets" });
    expect(res).toEqual({ status: 200, body: "[]" });
    const [path, req] = postIngestRaw.mock.calls[0]!;
    expect(path).toBe("/internal/integrations/call");
    expect(req).toMatchObject({ agentId: "agent-1", sessionId: "sess-1", integrationId: "int-pet", operationId: "listPets" });
  });

  it("passes the proxy's { error, hint } straight through on a 4xx", async () => {
    postIngestRaw.mockResolvedValue({ ok: false, status: 403, json: { error: "not authorized", hint: "attach it" } });
    const call = toolByName(buildIntegrationTools([PETSTORE], CTX), "call_integration");
    const res = (await call({ integrationId: "int-pet", operationId: "listPets" })) as { error: string };
    expect(res.error).toBe("not authorized");
  });

  it("rejects an unknown integration locally without a round-trip", async () => {
    const call = toolByName(buildIntegrationTools([PETSTORE], CTX), "call_integration");
    const res = (await call({ integrationId: "int-nope", operationId: "listPets" })) as { error: string; hint: string };
    expect(res.error).toBe("unknown integration");
    expect(postIngestRaw).not.toHaveBeenCalled();
  });

  it("returns { error, hint } (never throws) when the proxy is unreachable", async () => {
    postIngestRaw.mockResolvedValue(null);
    const call = toolByName(buildIntegrationTools([PETSTORE], CTX), "call_integration");
    const res = (await call({ integrationId: "int-pet", operationId: "getPet", pathParams: { id: "1" } })) as { error: string; hint: string };
    expect(res.error).toBe("integration call failed");
    expect(res.hint).toBeTruthy();
  });

  it("synthesizes { error, hint } when the proxy 500s with no JSON body (never hands the model null)", async () => {
    // A proxy 500 (e.g. an unexpected shape) yields json: null; the tool must not
    // pass that through raw - the model always gets an { error, hint } or a result.
    postIngestRaw.mockResolvedValue({ ok: false, status: 500, json: null });
    const call = toolByName(buildIntegrationTools([PETSTORE], CTX), "call_integration");
    const res = (await call({ integrationId: "int-pet", operationId: "listPets" })) as { error: string; hint: string };
    expect(res.error).toBe("integration call failed");
    expect(res.hint).toContain("500");
  });

  describe("outputPath (persist response to workspace)", () => {
    it("writes the body to the workspace and returns a receipt (not the body)", async () => {
      const payload = JSON.stringify({ pets: Array.from({ length: 50 }, (_, i) => ({ id: i })) });
      postIngestRaw.mockResolvedValue({ ok: true, status: 200, json: { status: 200, body: payload } });
      const call = toolByName(buildIntegrationTools([PETSTORE], CTX), "call_integration");
      const res = (await call({ integrationId: "int-pet", operationId: "listPets", outputPath: "data/pets.json" })) as {
        status: number;
        path: string;
        bytes: number;
        body?: string;
      };
      // Receipt shape: status + path + bytes, and crucially NOT the body itself.
      expect(res.status).toBe(200);
      expect(res.path).toBe("data/pets.json");
      expect(res.bytes).toBe(Buffer.byteLength(payload));
      expect(res.body).toBeUndefined();
      // The file actually landed in the workspace with the exact bytes.
      expect(readFileSync(join(WORK, "data/pets.json"), "utf8")).toBe(payload);
    });

    it("sets largeResponse on the proxy request when outputPath is given", async () => {
      postIngestRaw.mockResolvedValue({ ok: true, status: 200, json: { status: 200, body: "{}" } });
      const call = toolByName(buildIntegrationTools([PETSTORE], CTX), "call_integration");
      await call({ integrationId: "int-pet", operationId: "listPets", outputPath: "out.json" });
      const [, req] = postIngestRaw.mock.calls[0]! as [string, { largeResponse?: boolean }];
      expect(req.largeResponse).toBe(true);
    });

    it("does NOT set largeResponse when outputPath is absent", async () => {
      postIngestRaw.mockResolvedValue({ ok: true, status: 200, json: { status: 200, body: "{}" } });
      const call = toolByName(buildIntegrationTools([PETSTORE], CTX), "call_integration");
      await call({ integrationId: "int-pet", operationId: "listPets" });
      const [, req] = postIngestRaw.mock.calls[0]! as [string, { largeResponse?: boolean }];
      expect(req.largeResponse).toBeUndefined();
    });

    it("rejects an outputPath that escapes the workspace BEFORE any network call", async () => {
      const call = toolByName(buildIntegrationTools([PETSTORE], CTX), "call_integration");
      // Escapes AND degenerate paths that resolve to the workspace root itself ("", ".")
      // - the latter would otherwise fetch then fail late on an EISDIR write.
      for (const bad of ["../escape.json", "/etc/passwd", "sub/../../escape.json", "", "."]) {
        const res = (await call({ integrationId: "int-pet", operationId: "listPets", outputPath: bad })) as {
          error: string;
        };
        expect(res.error).toBe("bad_path");
      }
      expect(postIngestRaw).not.toHaveBeenCalled(); // fail fast, never fetched
      expect(existsSync(join(WORK, "escape.json"))).toBe(false);
    });

    it("normalizes the receipt path (a trailing slash / . segment matches the real file)", async () => {
      postIngestRaw.mockResolvedValue({ ok: true, status: 200, json: { status: 200, body: "x" } });
      const call = toolByName(buildIntegrationTools([PETSTORE], CTX), "call_integration");
      const res = (await call({ integrationId: "int-pet", operationId: "listPets", outputPath: "data/./out.json" })) as {
        path: string;
      };
      expect(res.path).toBe("data/out.json"); // normalized, not the raw input
      expect(readFileSync(join(WORK, "data/out.json"), "utf8")).toBe("x");
    });

    it("flags truncation in the receipt so the agent pages instead of computing on partial data", async () => {
      postIngestRaw.mockResolvedValue({ ok: true, status: 200, json: { status: 200, body: "partial", truncated: true } });
      const call = toolByName(buildIntegrationTools([PETSTORE], CTX), "call_integration");
      const res = (await call({ integrationId: "int-pet", operationId: "listPets", outputPath: "big.json" })) as {
        truncated?: boolean;
        hint?: string;
      };
      expect(res.truncated).toBe(true);
      expect(res.hint).toMatch(/truncated|page/i);
    });

    it("warns (in the receipt) when the downstream status is an error, and doesn't call it data", async () => {
      postIngestRaw.mockResolvedValue({ ok: true, status: 200, json: { status: 500, body: "<error page>" } });
      const call = toolByName(buildIntegrationTools([PETSTORE], CTX), "call_integration");
      const res = (await call({ integrationId: "int-pet", operationId: "listPets", outputPath: "resp.json" })) as {
        status: number;
        hint?: string;
      };
      expect(res.status).toBe(500);
      expect(res.hint).toMatch(/status 500|error response|verify/i);
      // The body is still written (it's the agent's to inspect), but flagged as not-data.
      expect(readFileSync(join(WORK, "resp.json"), "utf8")).toBe("<error page>");
    });

    it("does NOT write a file when the proxy returns an error (no misleading artifact)", async () => {
      postIngestRaw.mockResolvedValue({ ok: false, status: 403, json: { error: "not authorized", hint: "attach it" } });
      const call = toolByName(buildIntegrationTools([PETSTORE], CTX), "call_integration");
      const res = (await call({
        integrationId: "int-pet",
        operationId: "listPets",
        outputPath: "should-not-exist.json",
      })) as { error: string };
      expect(res.error).toBe("not authorized"); // error passed through
      expect(existsSync(join(WORK, "should-not-exist.json"))).toBe(false); // nothing written
    });

    it("supports a paging pattern: distinct outputPath per page, no clobber", async () => {
      const call = toolByName(buildIntegrationTools([PETSTORE], CTX), "call_integration");
      for (let page = 1; page <= 3; page++) {
        postIngestRaw.mockResolvedValueOnce({ ok: true, status: 200, json: { status: 200, body: `page-${page}` } });
        const res = (await call({
          integrationId: "int-pet",
          operationId: "listPets",
          query: { page: String(page) },
          outputPath: `pages/p${page}.json`,
        })) as { path: string };
        expect(res.path).toBe(`pages/p${page}.json`);
      }
      // All three pages coexist on disk with their own contents.
      expect(readFileSync(join(WORK, "pages/p1.json"), "utf8")).toBe("page-1");
      expect(readFileSync(join(WORK, "pages/p2.json"), "utf8")).toBe("page-2");
      expect(readFileSync(join(WORK, "pages/p3.json"), "utf8")).toBe("page-3");
    });
  });
});

describe("integrationCallLabel", () => {
  it("names an integration call after the API it called", () => {
    expect(integrationCallLabel("call_integration", { integrationId: "int-pet" }, [PETSTORE])).toBe(
      "call_integration:Petstore",
    );
  });

  it("leaves every other tool's name alone", () => {
    expect(integrationCallLabel("run_bash", { command: "ls" }, [PETSTORE])).toBe("run_bash");
    // The discovery tool takes no integrationId, so it must not be relabelled either.
    expect(integrationCallLabel("list_integration_operations", {}, [PETSTORE])).toBe(
      "list_integration_operations",
    );
  });

  it("keeps the bare tool name when the id isn't in the manifest", () => {
    // The name has to come from the server-resolved manifest: labelling from
    // model-supplied input is how a hallucinated id becomes a metric key of its own.
    expect(integrationCallLabel("call_integration", { integrationId: "int-nope" }, [PETSTORE])).toBe(
      "call_integration",
    );
    expect(integrationCallLabel("call_integration", {}, [PETSTORE])).toBe("call_integration");
    expect(integrationCallLabel("call_integration", { integrationId: 7 }, [PETSTORE])).toBe("call_integration");
    expect(integrationCallLabel("call_integration", "not-an-object", [PETSTORE])).toBe("call_integration");
    expect(integrationCallLabel("call_integration", null, [PETSTORE])).toBe("call_integration");
    expect(integrationCallLabel("call_integration", { integrationId: "int-pet" }, [])).toBe("call_integration");
  });
});
