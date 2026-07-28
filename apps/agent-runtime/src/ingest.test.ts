/**
 * Telemetry ingest retry behaviour. Telemetry can never fail a turn, but silently
 * dropping it on one blip leaves a hole in the trajectory - or loses the session
 * summary every metric is derived from - so a transient failure must be retried.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", () => ({ INGEST_URL: "https://ingest.example.com" }));

import { postIngest, setIngestToken, setIngestContext } from "./ingest.js";

const fetchMock = vi.fn();

/** A fetch resolution with the given status. */
const reply = (status: number) => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  setIngestToken("tok");
  setIngestContext("agent-1", "session-1");
});
afterEach(() => vi.unstubAllGlobals());

describe("postIngest", () => {
  it("posts once and reports success on a 2xx", async () => {
    fetchMock.mockResolvedValue(reply(200));
    await expect(postIngest("/internal/trajectory", { a: 1 })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx and succeeds on a later attempt", async () => {
    fetchMock.mockResolvedValueOnce(reply(500)).mockResolvedValueOnce(reply(200));
    await expect(postIngest("/internal/trajectory", {})).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transport failure (the ingest API unreachable mid-turn)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(reply(200));
    await expect(postIngest("/internal/session-summary", {})).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 (throttled, not broken)", async () => {
    fetchMock.mockResolvedValueOnce(reply(429)).mockResolvedValueOnce(reply(200));
    await expect(postIngest("/internal/trajectory", {})).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 4xx - a rejected token or bad body won't become valid", async () => {
    fetchMock.mockResolvedValue(reply(403));
    await expect(postIngest("/internal/trajectory", {})).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of attempts, without throwing", async () => {
    fetchMock.mockResolvedValue(reply(503));
    // Never throws: the caller runs inside a turn that must continue regardless.
    await expect(postIngest("/internal/trajectory", {})).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3); // first try + 2 retries
  });

  it("logs the agent and session, so a failure is traceable across microVMs", async () => {
    fetchMock.mockResolvedValue(reply(403));
    await postIngest("/internal/trajectory", {});
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .flat()
      .map(String)
      .join(" ");
    expect(logged).toContain("agent=agent-1");
    expect(logged).toContain("session=session-1");
  });
});
