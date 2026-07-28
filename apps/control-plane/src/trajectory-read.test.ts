/**
 * readSession's status logic - the contract the polling client depends on.
 *
 * Two rules that must never break: a client is told "idle" ONLY once it holds the
 * terminal event (else it stops polling and misses the answer), and a session whose
 * microVM died without writing one is eventually closed out instead of reading
 * "working" forever. The ddb client is mocked so we can place events precisely in
 * time; timers are faked so the abandonment window is exact, not slept through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const send = vi.fn();
vi.mock("./ddb.js", () => ({ ddb: { send: (cmd: unknown) => send(cmd) } }));

import { readSession, readEvents } from "./repo/trajectory.js";

const AGENT = "agent-1";
const SESSION = "session-1";
const NOW = new Date("2026-07-24T12:00:00.000Z");

/** A stored trajectory item. `cursor` only needs to sort correctly here. */
function item(cursor: string, type: string, ts: string, extra: Record<string, unknown> = {}) {
  return { sessionId: SESSION, cursor, agentId: AGENT, type, ts, ...extra };
}

/**
 * A cursor shaped like the real thing. Cursors are UUIDv7s whose leading hex is a
 * ms timestamp, so ordering is only meaningful between values of that shape - a
 * toy "c2" would compare above every real cursor and hide the bug this checks.
 */
const cursorAt = (msOffset: number) =>
  `${(NOW.getTime() + msOffset).toString(16).padStart(12, "0").replace(/^(.{8})(.{4})$/, "$1-$2")}-7000-8000-000000000000`;

/**
 * Serve the two reads readSession makes, in order: the delta Query (paginated),
 * then the Limit:1 tail Query. Puts are captured for assertions.
 */
function serve(delta: Record<string, unknown>[], tail: Record<string, unknown>[]) {
  const puts: Record<string, unknown>[] = [];
  send.mockImplementation(async (cmd: { input: Record<string, unknown>; constructor: { name: string } }) => {
    if (cmd.constructor.name === "PutCommand") {
      puts.push(cmd.input.Item as Record<string, unknown>);
      return {};
    }
    // A Limit:1 descending read is the tail; anything else is the delta.
    return cmd.input.Limit === 1 ? { Items: tail } : { Items: delta };
  });
  return puts;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

/** An ISO timestamp `minutes` before NOW. */
const minsAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe("readSession status", () => {
  it("is working while the newest event is non-terminal", () => {
    serve([item("c2", "text", minsAgo(0))], [item("c2", "text", minsAgo(0))]);
    return expect(readSession(AGENT, SESSION)).resolves.toMatchObject({ status: "working" });
  });

  it("is idle when the delta itself carries the terminal event", async () => {
    serve([item("c1", "text", minsAgo(1)), item("c2", "session_end", minsAgo(0))], []);
    const res = await readSession(AGENT, SESSION);
    expect(res.status).toBe("idle");
  });

  it("stays working when a terminal event exists but the client hasn't received it", async () => {
    // The tail is terminal at c9, but this poll's delta stops at c2 - telling the
    // client "idle" now would make it stop before it ever sees the final answer.
    serve([item("c2", "text", minsAgo(0))], [item("c9", "session_end", minsAgo(0))]);
    const res = await readSession(AGENT, SESSION);
    expect(res.status).toBe("working");
  });

  it("is idle on the post-completion poll whose cursor already covers the terminal event", async () => {
    serve([], [item("c9", "session_end", minsAgo(0))]);
    const res = await readSession(AGENT, SESSION, "c9");
    expect(res.status).toBe("idle");
  });
});

describe("readSession closes out an abandoned session", () => {
  it("synthesizes a terminal error when the newest event is long stale", async () => {
    // A microVM that died mid-turn: last event 31 min ago, no terminal event, so
    // nothing will ever move this session off "working" on its own.
    const last = cursorAt(-31 * 60_000);
    const puts = serve([item(last, "tool_input", minsAgo(31))], [item(last, "tool_input", minsAgo(31))]);
    const res = await readSession(AGENT, SESSION);

    expect(res.status).toBe("idle"); // the client stops polling
    // The synthetic event is DELIVERED in this same reply, not just written - a
    // client that stops polling now must still learn why.
    expect(res.delta.at(-1)).toMatchObject({ type: "error" });
    expect(res.delta.at(-1)?.error).toMatch(/stopped responding/i);
    // ...and it's durable, so every later poll (and the UI's history) agrees.
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ sessionId: SESSION, agentId: AGENT, type: "error" });
    // Its cursor sorts after the events so far, so it lands at the end of the
    // trajectory - and doesn't hide events written later under a reused sessionId.
    expect(String(puts[0]!.cursor) > last).toBe(true);
  });

  it("leaves a merely slow session alone (inside the window)", async () => {
    const puts = serve([item("c2", "tool_input", minsAgo(29))], [item("c2", "tool_input", minsAgo(29))]);
    const res = await readSession(AGENT, SESSION);
    expect(res.status).toBe("working");
    expect(puts).toHaveLength(0); // a long tool call must not be declared dead
  });

  it("never adds a second terminal event to a session that ended normally", async () => {
    // Stale AND terminal: an old finished session being re-polled by a client whose
    // cursor predates the end. It reads "working", but it is not abandoned.
    const puts = serve([], [item("c9", "session_end", minsAgo(120))]);
    const res = await readSession(AGENT, SESSION, "c1");
    expect(res.status).toBe("working"); // it will go idle once c9 is delivered
    expect(puts).toHaveLength(0);
  });

  it("does not close out a session that has written nothing yet", async () => {
    const puts = serve([], []);
    const res = await readSession(AGENT, SESSION);
    expect(res.status).toBe("working"); // still booting the microVM
    expect(puts).toHaveLength(0);
  });
});

describe("readEvents run scoping", () => {
  /**
   * A client may reuse one sessionId across microVM lifetimes, and every run writes
   * into the SAME trajectory partition. So a run's trace must be filtered to its own
   * runId - otherwise opening either run shows both runs' steps merged, and the
   * archive bakes a neighbour's events into this run's object permanently.
   */
  it("filters to one run, while KEEPING events that carry no runId", async () => {
    send.mockImplementation(async () => ({ Items: [] }));
    await readEvents(AGENT, SESSION, undefined, "run-A");
    const input = send.mock.calls[0]![0].input as Record<string, string | Record<string, unknown>>;
    // The un-stamped events must survive: the opening `prompt` is written by the
    // control-plane before the runtime has minted a runId, so a bare `runId = :r`
    // filter would silently drop the user's own message from the trace.
    expect(input.FilterExpression).toBe("agentId = :a AND (runId = :r OR attribute_not_exists(runId))");
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[":r"]).toBe("run-A");
  });

  it("reads the whole session when no run is named (the poll path)", async () => {
    send.mockImplementation(async () => ({ Items: [] }));
    await readEvents(AGENT, SESSION);
    const input = send.mock.calls[0]![0].input as Record<string, string>;
    expect(input.FilterExpression).toBe("agentId = :a");
  });
});
