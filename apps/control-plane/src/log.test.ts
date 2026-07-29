/**
 * The logging contract: a FAILED request is always logged, a successful one only
 * under DEBUG.
 *
 * Worth a test because both halves are easy to break silently. Log every request
 * unconditionally and a busy prod Lambda pays for a line per poll (clients poll in a
 * loop); log failures only when DEBUG is set and a 4xx/5xx in prod leaves no trace at
 * all - which is the gap this file exists to close.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/** Re-import log.ts with DEBUG set as given (the flag is read once, at module load). */
async function loadLog(debugEnv: string | undefined) {
  vi.resetModules();
  if (debugEnv === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = debugEnv;
  return await import("./log.js");
}

describe("logRequest", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DEBUG;
  });

  it("stays silent on success when DEBUG is unset", async () => {
    const { logRequest, debug } = await loadLog(undefined);
    logRequest("GET", "/agents/a1/sessions/s1", 200, 3);
    debug("invoke", { agent: "a1" });
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs a 4xx even when DEBUG is unset", async () => {
    const { logRequest } = await loadLog(undefined);
    logRequest("POST", "/agents/a1/invoke", 401, 2);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect((console.log as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]).toContain("status=401");
  });

  it("logs a 5xx through console.error", async () => {
    const { logRequest } = await loadLog(undefined);
    logRequest("GET", "/agents", 500, 7);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("logs successes and debug detail when DEBUG=1", async () => {
    const { logRequest, debug } = await loadLog("1");
    logRequest("GET", "/agents", 200, 4);
    debug("invoke", { agent: "a1", session: "s1" });
    expect(console.log).toHaveBeenCalledTimes(2);
    expect((console.log as unknown as { mock: { calls: string[][] } }).mock.calls[1]![0]).toContain("agent=a1");
  });
});
