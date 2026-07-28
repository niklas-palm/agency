/**
 * HTTP-level tests for the internal telemetry ingest routes. These guard the
 * WIRING (that `authIngest` runs before body-trust, that the type allow-list is
 * enforced) - the token primitive itself is covered by session-token.test.ts. The
 * repo writes are mocked so we assert only on status + whether a write happened.
 *
 * The signing key is stubbed BEFORE importing the app, since session-token.ts reads
 * RUNTIME_INGEST_KEY from config at module load.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.stubEnv("RUNTIME_INGEST_KEY", "test-ingest-signing-key");

const recordEvent = vi.fn(async (_e: unknown) => {});
const writeSummary = vi.fn(async (_s: unknown) => {});
// The summary handler reads the run's events back to archive them.
const readEvents = vi.fn(async (): Promise<unknown[]> => []);
vi.mock("./repo/trajectory.js", () => ({
  recordEvent: (e: unknown) => recordEvent(e),
  recordPrompt: vi.fn(async () => {}),
  readSession: vi.fn(async () => ({ status: "idle", events: [], cursor: null })),
  readEvents: (...a: unknown[]) => readEvents(...(a as [])),
}));
// Archiving is best-effort and must not reach real S3 from a test.
const archiveTrace = vi.fn(async () => {});
vi.mock("./repo/traces.js", () => ({
  archiveTrace: (...a: unknown[]) => archiveTrace(...(a as [])),
  readArchivedTrace: vi.fn(async () => null),
}));
vi.mock("./repo/sessions.js", () => ({
  writeSummary: (s: unknown) => writeSummary(s),
  metricsFor: vi.fn(async () => ({})),
}));

const { buildApp } = await import("./app.js");
const { mintSessionToken } = await import("./session-token.js");

const app = buildApp();
const OWNER = "owner-1";
const AGENT = "agent-1";
const SESSION = "sess-0123456789012345678901234567890123"; // 33+ chars

function headers(token: string) {
  return { "Content-Type": "application/json", "X-Agency-Ingest-Token": token };
}
const trajectoryBody = { agentId: AGENT, sessionId: SESSION, type: "text", cursor: "01", data: {} };
const RUN = "019fa3fe-de0f-75b6-bc98-5b99ad349fe6"; // the UUIDv7 the runtime mints
const summaryBody = { agentId: AGENT, sessionId: SESSION, runId: RUN };

beforeEach(() => {
  vi.clearAllMocks();
  readEvents.mockImplementation(async () => []);
});

describe("POST /internal/trajectory", () => {
  it("accepts a valid token whose claims match the body, and records the event", async () => {
    const token = mintSessionToken(OWNER, OWNER, AGENT, SESSION);
    const res = await app.request("/internal/trajectory", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(trajectoryBody),
    });
    expect(res.status).toBe(204);
    expect(recordEvent).toHaveBeenCalledOnce();
  });

  it("401s with no token, and does NOT write", async () => {
    const res = await app.request("/internal/trajectory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trajectoryBody),
    });
    expect(res.status).toBe(401);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("401s with a forged token", async () => {
    const res = await app.request("/internal/trajectory", {
      method: "POST",
      headers: headers("forged.garbage.token"),
      body: JSON.stringify(trajectoryBody),
    });
    expect(res.status).toBe(401);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("401s when the token is for a DIFFERENT session (no cross-session writes)", async () => {
    const otherToken = mintSessionToken(OWNER, OWNER, AGENT, "sess-9999999999999999999999999999999999");
    const res = await app.request("/internal/trajectory", {
      method: "POST",
      headers: headers(otherToken),
      body: JSON.stringify(trajectoryBody), // body claims SESSION, token claims other
    });
    expect(res.status).toBe(401);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("auth runs BEFORE body validation: a bad token on a malformed body still 401s (not 400)", async () => {
    const res = await app.request("/internal/trajectory", {
      method: "POST",
      headers: headers("forged.garbage.token"),
      body: JSON.stringify({ nonsense: true }),
    });
    expect(res.status).toBe(401);
  });

  it("400s a valid token but an unknown event type (forge-a-bogus-shape guard)", async () => {
    const token = mintSessionToken(OWNER, OWNER, AGENT, SESSION);
    const res = await app.request("/internal/trajectory", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ ...trajectoryBody, type: "not-a-real-type" }),
    });
    expect(res.status).toBe(400);
    expect(recordEvent).not.toHaveBeenCalled();
  });
});

describe("POST /internal/session-summary", () => {
  it("accepts a valid token and writes the summary", async () => {
    const token = mintSessionToken(OWNER, OWNER, AGENT, SESSION);
    const res = await app.request("/internal/session-summary", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(summaryBody),
    });
    expect(res.status).toBe(204);
    expect(writeSummary).toHaveBeenCalledOnce();
  });

  it("401s with a forged token and does NOT write", async () => {
    const res = await app.request("/internal/session-summary", {
      method: "POST",
      headers: headers("forged.garbage.token"),
      body: JSON.stringify(summaryBody),
    });
    expect(res.status).toBe(401);
    expect(writeSummary).not.toHaveBeenCalled();
  });

  it("archives the run's trajectory under its runId, not its sessionId", async () => {
    // The archive object is keyed by run: a client may reuse a sessionId across microVM
    // lifetimes, and a session-keyed object let the later run overwrite the earlier
    // run's trace (losing it once the table's TTL had expired the rows).
    readEvents.mockImplementationOnce(async () => [{ cursor: "c1", type: "text", ts: "t" }]);
    const token = mintSessionToken(OWNER, OWNER, AGENT, SESSION);
    await app.request("/internal/session-summary", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(summaryBody),
    });
    expect(archiveTrace).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: AGENT, runId: RUN }),
      [{ cursor: "c1", type: "text", ts: "t" }],
    );
  });

  it("400s a runId that isn't a UUID, since it becomes a storage key", async () => {
    const token = mintSessionToken(OWNER, OWNER, AGENT, SESSION);
    const res = await app.request("/internal/session-summary", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ ...summaryBody, runId: "../../other-agent/run" }),
    });
    expect(res.status).toBe(400);
    expect(writeSummary).not.toHaveBeenCalled();
  });

  it("still 204s when archiving fails - the summary is already durable", async () => {
    // The read sits inside the guard too: a throttled trajectory read must not turn a
    // successful summary write into a 500 the runtime retries (re-posting the summary
    // and re-reading the trajectory, amplifying the throttling that caused it).
    readEvents.mockImplementationOnce(() => {
      throw new Error("ProvisionedThroughputExceededException");
    });
    const token = mintSessionToken(OWNER, OWNER, AGENT, SESSION);
    const res = await app.request("/internal/session-summary", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(summaryBody),
    });
    expect(res.status).toBe(204);
    expect(writeSummary).toHaveBeenCalledOnce();
  });
});
