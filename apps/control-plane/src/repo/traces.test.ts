/**
 * The trace archive: what it keys objects by, and which failures are "no archive"
 * versus "try again".
 *
 * The distinction is the point. A missing or corrupt object must render as an empty run
 * (the UI says the steps are gone), but a THROTTLED read must not - telling a user their
 * trace is permanently gone when a retry would have served it is a lie the UI can't walk
 * back. Keying is by runId, because a client may reuse a sessionId across runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.stubEnv("TRACES_BUCKET", "test-traces");

const send = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = (cmd: unknown) => send(cmd);
  },
  // Keep the command's shape so assertions can read the key back out.
  PutObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const { archiveTrace, readArchivedTrace } = await import("./traces.js");

const AGENT = "agent-1";
const RUN = "019fa3fe-de0f-75b6-bc98-5b99ad349fe6";
const events = [{ cursor: "c1", type: "text" as const, ts: "2026-07-27T10:00:00Z", content: "hi" }];

/** A session summary as the ingest route hands it to archiveTrace. */
const summary = {
  agentId: AGENT,
  runId: RUN,
  sessionId: "sess-abc",
  version: 3,
  model: "haiku-4.5" as const,
  startedAt: "2026-07-27T10:00:00Z",
  endedAt: "2026-07-27T10:05:00Z",
  durationMs: 300_000,
  invocations: 1,
  turns: 2,
  toolUses: 1,
  toolBreakdown: { run_bash: 1 },
  injections: 0,
  outcome: "ok" as const,
};

/** An S3 error as the SDK raises it: the kind is carried on `name`. */
const s3Error = (name: string) => Object.assign(new Error(name), { name });

beforeEach(() => vi.clearAllMocks());

describe("archiveTrace", () => {
  it("keys the object by runId, not sessionId", async () => {
    send.mockResolvedValue({});
    await archiveTrace(summary, events);
    expect(send.mock.calls[0]![0].input).toMatchObject({
      Bucket: "test-traces",
      Key: `traces/${AGENT}/${RUN}.json`,
      ContentType: "application/json",
    });
  });

  it("wraps the events in a self-describing envelope", async () => {
    // Traces are kept forever, outliving the trajectory rows and possibly the agent
    // record, so the object has to say what produced it.
    send.mockResolvedValue({});
    await archiveTrace(summary, events);
    const body = JSON.parse(send.mock.calls[0]![0].input.Body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      agentId: AGENT,
      runId: RUN,
      sessionId: "sess-abc",
      version: 3,
      model: "haiku-4.5",
      outcome: "ok",
      events,
    });
    expect(typeof body.archivedAt).toBe("string");
  });

  it("writes nothing when there are no events", async () => {
    // The archive is re-written at every idle point; a read that came back empty (rows
    // already TTL'd, or not yet visible) must never clobber a good archive with [].
    await archiveTrace(summary, []);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("readArchivedTrace", () => {
  it("returns the events of an archived run", async () => {
    const stored = { agentId: AGENT, runId: RUN, sessionId: "s", version: 1, outcome: "ok", archivedAt: "t", events };
    send.mockResolvedValue({ Body: { transformToString: async () => JSON.stringify(stored) } });
    expect(await readArchivedTrace(AGENT, RUN)).toEqual(events);
  });

  it("still reads a PRE-ENVELOPE object (a bare event array)", async () => {
    // Objects written before the envelope shipped are already in the bucket, and traces
    // are never deleted - so those runs must stay openable.
    send.mockResolvedValue({ Body: { transformToString: async () => JSON.stringify(events) } });
    expect(await readArchivedTrace(AGENT, RUN)).toEqual(events);
  });

  it("returns null when the object isn't there", async () => {
    send.mockRejectedValue(s3Error("NoSuchKey"));
    expect(await readArchivedTrace(AGENT, RUN)).toBeNull();
  });

  it("RETHROWS a transient S3 failure instead of reporting 'no archive'", async () => {
    // Swallowing this told the user their trace was permanently gone. Throwing lets
    // app.onError map it to a retryable 503.
    send.mockRejectedValue(s3Error("SlowDown"));
    await expect(readArchivedTrace(AGENT, RUN)).rejects.toThrow("SlowDown");
  });

  it("returns null for a corrupt object rather than throwing", async () => {
    send.mockResolvedValue({ Body: { transformToString: async () => "{truncated" } });
    expect(await readArchivedTrace(AGENT, RUN)).toBeNull();
  });

  it("returns null when the object holds JSON that isn't an array of events", async () => {
    send.mockResolvedValue({ Body: { transformToString: async () => '{"nope":true}' } });
    expect(await readArchivedTrace(AGENT, RUN)).toBeNull();
  });
});
