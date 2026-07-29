/**
 * The logging contract: a FAILED request is always logged, a successful one only
 * under DEBUG.
 *
 * Worth testing because both halves are easy to break silently. Log every request
 * unconditionally and a busy prod Lambda pays for a line per poll (clients poll in a
 * loop); log failures only when DEBUG is set and a 4xx/5xx in prod leaves no trace at
 * all - which is the gap this file exists to close.
 *
 * The second describe covers the WIRING through the real app, because the middleware
 * placement is what makes the contract hold: a handler that throws is logged with its
 * final 500/503, since Hono's onError produces the response inside the compose chain
 * and `next()` resolves normally. Move the middleware after the error handling and
 * every thrown request silently stops being logged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Deterministic regardless of the developer's shell: the app below reads DEBUG once,
// at import, and the wiring assertions are about the DEBUG-off (prod) behaviour.
delete process.env.DEBUG;

// The one repo call the invoke route makes before anything else - made to throw a
// transient AWS error, which is the 503 path.
vi.mock("./repo/agents.js", () => ({
  getAgent: vi.fn(async () => {
    const e = new Error("Rate exceeded");
    e.name = "ThrottlingException";
    throw e;
  }),
  putAgent: vi.fn(),
  listAgents: vi.fn(async () => []),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  bumpInvocation: vi.fn(),
}));

const { buildApp } = await import("./app.js");

/** Re-import log.ts with DEBUG set as given (the flag is read once, at module load). */
async function loadLog(debugEnv: string | undefined) {
  vi.resetModules();
  if (debugEnv === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = debugEnv;
  return await import("./log.js");
}

/** Captured console output, so an assertion reads lines rather than mock internals. */
function captureConsole() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  return { out, err };
}

describe("logRequest", () => {
  let lines: { out: string[]; err: string[] };
  beforeEach(() => {
    lines = captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DEBUG;
  });

  it("stays silent on success when DEBUG is unset", async () => {
    const { logRequest, debug } = await loadLog(undefined);
    logRequest("GET", "/agents/a1/sessions/s1", 200, 3);
    debug("invoke", { agent: "a1" });
    expect(lines.out).toEqual([]);
    expect(lines.err).toEqual([]);
  });

  it("logs a 4xx even when DEBUG is unset", async () => {
    const { logRequest } = await loadLog(undefined);
    logRequest("POST", "/agents/a1/invoke", 401, 2);
    expect(lines.out).toEqual(["request POST /agents/a1/invoke status=401 ms=2"]);
  });

  it("logs a 5xx through console.error", async () => {
    const { logRequest } = await loadLog(undefined);
    logRequest("GET", "/agents", 500, 7);
    expect(lines.err).toEqual(["request GET /agents status=500 ms=7"]);
    expect(lines.out).toEqual([]);
  });

  it("logs successes and debug detail when DEBUG=1", async () => {
    const { logRequest, debug } = await loadLog("1");
    logRequest("GET", "/agents", 200, 4);
    debug("invoke", { agent: "a1", session: "s1" });
    expect(lines.out).toEqual(["request GET /agents status=200 ms=4", "debug invoke agent=a1 session=s1"]);
  });
});

describe("request logging, wired into the app", () => {
  let lines: { out: string[]; err: string[] };
  beforeEach(() => {
    lines = captureConsole();
  });
  afterEach(() => vi.restoreAllMocks());

  it("says nothing about a request that succeeded", async () => {
    const res = await buildApp().request("/health");
    expect(res.status).toBe(200);
    expect([...lines.out, ...lines.err]).toEqual([]);
  });

  it("logs a 404 once, with the method and path", async () => {
    const res = await buildApp().request("/nope");
    expect(res.status).toBe(404);
    expect(lines.out).toHaveLength(1);
    expect(lines.out[0]).toMatch(/^request GET \/nope status=404 ms=\d+$/);
  });

  it("logs a thrown transient error as a 503 request line plus the error's name", async () => {
    const res = await buildApp().request("/agents/a1/invoke", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
    expect(lines.err[0]).toBe("transient error ThrottlingException");
    expect(lines.err[1]).toMatch(/^request POST \/agents\/a1\/invoke status=503 ms=\d+$/);
  });
});
