/**
 * Run history: the list, and opening one run's trajectory.
 *
 * The two halves live in different stores on purpose - the run LIST comes from the
 * retained session-summary rows (so it works for runs far older than the trajectory
 * table's 30-day TTL), and the TRACE comes from the trajectory table while it's fresh,
 * falling back to the S3 archive once TTL has expired it. These tests pin that split.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrajectoryEvent } from "@agency/shared";

vi.mock("./repo/tokens.js", () => ({
  getTokenByHash: vi.fn(async () => ({
    tokenHash: "h", id: "tok", ownerId: "user-A", orgId: "org-A", name: "t",
    scopes: ["read", "write", "delete"], createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null,
  })),
  touchToken: vi.fn(async () => {}),
  listTokensByOwner: vi.fn(async () => []),
  putToken: vi.fn(async () => {}),
  deleteTokenById: vi.fn(async () => false),
  toPublicToken: (r: Record<string, unknown>) => r,
}));
vi.mock("./repo/memberships.js", () => ({
  getMembership: vi.fn(async (orgId: string, userId: string) =>
    orgId === "org-A" && userId === "user-A"
      ? { orgId: "org-A", userId: "user-A", role: "admin", joinedAt: "t" }
      : null,
  ),
}));

const AGENT = {
  id: "agent-1", orgId: "org-A", createdBy: "user-A", shared: true,
  config: { name: "a", systemPrompt: "s", model: "haiku-4.5", baseTools: false, webSearch: false, networkAccess: true, triggers: [{ type: "api" }] },
  version: 3, invokeUrl: "http://x", apiKeyHash: "h", createdAt: "t", updatedAt: "t",
  metrics: { invocations: 0, lastInvokedAt: null },
};
vi.mock("./repo/agents.js", () => ({
  getAgent: vi.fn(async (id: string) => (id === "agent-1" ? { ...AGENT } : null)),
  listAgentsByOrg: vi.fn(async () => []),
  putAgent: vi.fn(async () => {}),
  updateAgent: vi.fn(async () => {}),
  deleteAgent: vi.fn(async () => {}),
  toPublic: (r: Record<string, unknown>) => ({ ...r }),
  normalizeConfig: (c: Record<string, unknown>) => c,
  freshMetrics: () => ({ invocations: 0, lastInvokedAt: null }),
}));

/** The UUIDv7 runId of the stored run these tests open. */
const RUN = "019fa3fe-de0f-75b6-bc98-5b99ad349fe6";

/** A stored session-summary row (what the run list reads). */
const row = (over: Record<string, unknown> = {}) => ({
  agentId: "agent-1", sessionId: "sess-1", runId: RUN, version: 2,
  model: "haiku-4.5", startedAt: "2026-07-27T10:00:00Z", endedAt: "2026-07-27T10:00:05Z",
  durationMs: 5000, invocations: 2, turns: 3, toolUses: 1, toolBreakdown: { run_bash: 1 },
  injections: 0, outcome: "ok",
  tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0 },
  ...over,
});
const listRuns = vi.fn(async (_a: string, _l: number) => [row()] as unknown[]);
const getRun = vi.fn(async (_a: string, runId: string) =>
  runId === RUN ? (row() as unknown) : null,
);
vi.mock("./repo/sessions.js", () => ({
  listRuns: (a: string, l: number) => listRuns(a, l),
  getRun: (a: string, r: string) => getRun(a, r),
  metricsFor: vi.fn(async () => ({ sessions: 0, series: [] })),
  writeSummary: vi.fn(async () => {}),
}));

const readEvents = vi.fn(async () => [] as TrajectoryEvent[]);
vi.mock("./repo/trajectory.js", () => ({
  readEvents: (...a: unknown[]) => readEvents(...(a as [])),
  readSession: vi.fn(async () => ({ delta: [], status: "idle" })),
  recordPrompt: vi.fn(async () => {}),
  recordEvent: vi.fn(async () => {}),
}));
const readArchivedTrace = vi.fn(async () => null as TrajectoryEvent[] | null);
vi.mock("./repo/traces.js", () => ({
  archiveTrace: vi.fn(async () => {}),
  readArchivedTrace: (...a: unknown[]) => readArchivedTrace(...(a as [])),
}));
vi.mock("./repo/skills.js", () => ({ getSkillsByIds: vi.fn(async () => []), listSkills: vi.fn(async () => []) }));

import { buildApp } from "./app.js";

const app = buildApp();
const auth = { Authorization: "Bearer agpat_runs_test_token_000000000000000" };
const get = (path: string) => app.request(path, { headers: auth });

const event = (over: Partial<TrajectoryEvent> = {}): TrajectoryEvent => ({
  cursor: "c1", type: "text", ts: "2026-07-27T10:00:01Z", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  listRuns.mockImplementation(async () => [row()]);
  getRun.mockImplementation(async (_a: string, runId: string) => (runId === RUN ? row() : null));
  readEvents.mockImplementation(async () => []);
  readArchivedTrace.mockImplementation(async () => null);
});

describe("GET /agents/:id/runs", () => {
  it("projects a stored summary row into a run list entry", async () => {
    const res = await get("/agents/agent-1/runs");
    expect(res.status).toBe(200);
    const { runs } = (await res.json()) as { runs: Record<string, unknown>[] };
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: RUN, sessionId: "sess-1", version: 2, outcome: "ok",
      invocations: 2, turns: 3, toolUses: 1,
    });
    // Tokens are summed for the list, and cost is priced from the run's own model.
    expect(runs[0]!.totalTokens).toBe(160);
    expect(runs[0]!.costUsd).toBeGreaterThan(0);
  });

  it("defaults the limit and caps it, so a caller can't ask for the whole history", async () => {
    await get("/agents/agent-1/runs");
    expect(listRuns.mock.calls[0]![1]).toBe(50);
    await get("/agents/agent-1/runs?limit=9999");
    expect(listRuns.mock.calls[1]![1]).toBe(200);
    await get("/agents/agent-1/runs?limit=0"); // nonsense → the default, not zero rows
    expect(listRuns.mock.calls[2]![1]).toBe(50);
  });

  it("renders a legacy row that predates token + invocation tracking", async () => {
    listRuns.mockImplementation(async () => [row({ tokens: undefined, invocations: undefined, model: undefined })]);
    const { runs } = (await (await get("/agents/agent-1/runs")).json()) as { runs: Record<string, unknown>[] };
    // 0/1 rather than undefined, so the list renders uniformly instead of showing gaps.
    expect(runs[0]).toMatchObject({ totalTokens: 0, costUsd: 0, invocations: 1 });
  });

  it("404s an agent the caller can't see", async () => {
    expect((await get("/agents/nope/runs")).status).toBe(404);
  });
});

describe("GET /agents/:id/runs/:runId", () => {
  it("serves the live trajectory while the rows are still there", async () => {
    readEvents.mockImplementation(async () => [event({ content: "hello" })]);
    const res = await get(`/agents/agent-1/runs/${RUN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; archived: boolean };
    expect(body.events).toHaveLength(1);
    expect(body.archived).toBe(false);
    expect(readArchivedTrace).not.toHaveBeenCalled(); // no need to touch S3
  });

  it("falls back to the S3 archive once the TTL has expired the rows", async () => {
    readEvents.mockImplementation(async () => []); // expired
    readArchivedTrace.mockImplementation(async () => [event({ content: "archived" })]);
    const body = (await (await get(`/agents/agent-1/runs/${RUN}`)).json()) as {
      events: { content?: string }[];
      archived: boolean;
    };
    expect(body.events[0]?.content).toBe("archived");
    expect(body.archived).toBe(true);
  });

  it("reads the archive by RUN id, so two runs of one session can't collide", async () => {
    // A client may reuse a sessionId across microVM lifetimes. Keying the object by
    // session let the later run's archive overwrite the earlier run's, which then
    // vanished for good once the table's TTL expired its rows.
    readEvents.mockImplementation(async () => []);
    await get(`/agents/agent-1/runs/${RUN}`);
    expect(readArchivedTrace).toHaveBeenCalledWith("agent-1", RUN);
  });

  it("reports an empty, unarchived run honestly rather than as an error", async () => {
    // Nothing in the table and nothing in S3 - a run older than the TTL that was
    // never archived. The UI needs to say so, not render a blank successful run.
    const res = await get(`/agents/agent-1/runs/${RUN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: RUN, sessionId: "sess-1", events: [], archived: false });
  });

  it("scopes the read to the agent, the run's own session, AND the run itself", async () => {
    await get(`/agents/agent-1/runs/${RUN}`);
    expect(getRun).toHaveBeenCalledWith("agent-1", RUN);
    // The session comes from the stored row, never from the caller; and the read is
    // narrowed to THIS run, because a reused sessionId holds several runs' events in
    // one trajectory partition - reading the partition would merge them.
    expect(readEvents).toHaveBeenCalledWith("agent-1", "sess-1", undefined, RUN);
  });

  it("404s a run id that isn't this agent's", async () => {
    // The run must exist in the agent's own partition before its id is used to build
    // an S3 key - an invented id is a 404, not an empty trace.
    const res = await get("/agents/agent-1/runs/019fa3fe-0000-7000-8000-000000000000");
    expect(res.status).toBe(404);
    expect(readEvents).not.toHaveBeenCalled();
    expect(readArchivedTrace).not.toHaveBeenCalled();
  });

  it("404s an agent the caller can't see", async () => {
    expect((await get(`/agents/nope/runs/${RUN}`)).status).toBe(404);
  });

  it("caps a huge trace instead of exceeding the response limit", async () => {
    // A tool-looping agent has no per-turn cap, so a run's events can outgrow the
    // Lambda response ceiling - which would 502 and make the run unopenable forever.
    // Truncation keeps the OLDEST events (a trace is read top-down) and says so.
    const big = "x".repeat(200_000);
    readEvents.mockImplementation(async () =>
      Array.from({ length: 40 }, (_, i) => event({ cursor: `c${i}`, content: big })),
    );
    const body = (await (await get(`/agents/agent-1/runs/${RUN}`)).json()) as {
      events: { cursor: string }[];
      truncated?: boolean;
    };
    expect(body.truncated).toBe(true);
    expect(body.events.length).toBeLessThan(40);
    expect(body.events[0]!.cursor).toBe("c0"); // oldest kept, not newest
  });

  it("doesn't flag a trace that fits", async () => {
    readEvents.mockImplementation(async () => [event({ content: "small" })]);
    const body = (await (await get(`/agents/agent-1/runs/${RUN}`)).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("truncated");
  });
});
