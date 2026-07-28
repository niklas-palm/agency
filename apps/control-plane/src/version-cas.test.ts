/**
 * Agent PATCH + metrics-read semantics, driven through the real routes.
 *
 * The version bump is a compare-and-swap: two concurrent config PATCHes both read
 * the same `version`, so a blind write would let one config vanish from history AND
 * leave the agent's live config disagreeing with the snapshot that version number
 * points at. Also covers the two ways a request can be silently mis-served - a
 * description that can't be cleared, and a mistyped `?version=` reported as zeros.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

const CONFIG = {
  name: "a", systemPrompt: "s", model: "haiku-4.5", baseTools: false,
  webSearch: false, networkAccess: true, triggers: [{ type: "api" }],
};
/** The stored agent. `version` is mutated to simulate a concurrent bump. */
const AGENT = {
  id: "agent-1", orgId: "org-A", createdBy: "user-A", shared: true,
  config: CONFIG, version: 5, invokeUrl: "http://x", apiKeyHash: "h",
  createdAt: "t", updatedAt: "t", metrics: { invocations: 0, lastInvokedAt: null },
};

/** Throw what DynamoDB throws when a ConditionExpression isn't met. */
function conditionalFail(): never {
  throw Object.assign(new Error("cas"), { name: "ConditionalCheckFailedException" });
}

const putVersion = vi.fn(async (_v: unknown) => {});
const updateAgent = vi.fn(async (_id: string, _p: unknown) => {});
const getAgent = vi.fn(async () => ({ ...AGENT }));
const highestVersion = vi.fn(async () => 0);

vi.mock("./repo/agents.js", () => ({
  getAgent: (...a: []) => getAgent(...a),
  updateAgent: (id: string, p: unknown) => updateAgent(id, p),
  listAgentsByOrg: vi.fn(async () => []),
  putAgent: vi.fn(async () => {}),
  deleteAgent: vi.fn(async () => {}),
  toPublic: (r: Record<string, unknown>) => ({ ...r }),
  normalizeConfig: (c: Record<string, unknown>) => c,
  freshMetrics: () => ({ invocations: 0, lastInvokedAt: null }),
}));
vi.mock("./repo/versions.js", () => ({
  putVersion: (v: unknown) => putVersion(v),
  listVersions: vi.fn(async () => []),
  // The bump reconciles against history to step past an orphaned version row; 0 means
  // "no rows", so the agent record's version governs (the ordinary case).
  highestVersion: (...a: unknown[]) => highestVersion(...(a as [])),
}));
vi.mock("./repo/skills.js", () => ({ getSkillsByIds: vi.fn(async () => []), listSkills: vi.fn(async () => []) }));
const metricsFor = vi.fn(async () => ({ sessions: 0, series: [] }));
vi.mock("./repo/sessions.js", () => ({
  metricsFor: (...a: unknown[]) => metricsFor(...(a as [])),
  writeSummary: vi.fn(async () => {}),
}));

import { buildApp } from "./app.js";

const app = buildApp();
const auth = { Authorization: "Bearer agpat_cas_test_token_00000000000000000" };
const patch = (body: unknown) =>
  app.request("/agents/agent-1", {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getAgent.mockImplementation(async () => ({ ...AGENT }));
  highestVersion.mockImplementation(async () => 0);
});

describe("version bump is a compare-and-swap", () => {
  it("guards the write: claims the version slot AND asserts the expected current version", async () => {
    const res = await patch({ systemPrompt: "changed" });
    expect(res.status).toBe(200);
    // The snapshot claims v6 (5 + 1)...
    expect((putVersion.mock.calls[0]![0] as { version: number }).version).toBe(6);
    // ...and the agent bump carries expectedVersion so a racing writer loses.
    const p = updateAgent.mock.calls.at(-1)![1] as { version: number; expectedVersion: number };
    expect(p.version).toBe(6);
    expect(p.expectedVersion).toBe(5);
  });

  it("retries against the winner's version when it loses the race", async () => {
    // First putVersion loses (someone else claimed v6); on re-read the agent is at 6,
    // so the retry must compute 7 and expect 6 - not blindly rewrite 6.
    putVersion.mockImplementationOnce(conditionalFail);
    getAgent
      .mockImplementationOnce(async () => ({ ...AGENT })) // the route's initial load
      .mockImplementationOnce(async () => ({ ...AGENT, version: 6 })); // re-read after losing

    const res = await patch({ systemPrompt: "changed" });
    expect(res.status).toBe(200);
    expect(putVersion).toHaveBeenCalledTimes(2);
    expect((putVersion.mock.calls[1]![0] as { version: number }).version).toBe(7);
    const p = updateAgent.mock.calls.at(-1)![1] as { version: number; expectedVersion: number };
    expect(p.version).toBe(7);
    expect(p.expectedVersion).toBe(6);
  });

  it("gives up under sustained contention with a retryable 503, not a silent wrong write", async () => {
    putVersion.mockImplementation(conditionalFail); // always loses
    const res = await patch({ systemPrompt: "changed" });
    expect(res.status).toBe(503); // "retry shortly" - a conflict, not a broken request
    expect(putVersion.mock.calls.length).toBeLessThanOrEqual(4); // bounded attempts
    expect(updateAgent).not.toHaveBeenCalled(); // never bumped past an unclaimed slot
  });
});

describe("agent metadata edits (no version bump)", () => {
  it("clears the description when sent empty, instead of silently keeping the old one", async () => {
    // updateAgent reads `undefined` as "not sent", so an emptied description used to
    // be indistinguishable from omitting the field - it could never be removed.
    const res = await patch({ description: "   " });
    expect(res.status).toBe(200);
    const p = updateAgent.mock.calls.at(-1)![1] as { description?: unknown; version?: number };
    expect(p.description).toBeNull(); // null → REMOVE the attribute
    expect(p.version).toBeUndefined(); // metadata only; no version minted
  });

  it("sets a description without minting a version", async () => {
    const res = await patch({ description: "the roster label" });
    expect(res.status).toBe(200);
    const p = updateAgent.mock.calls.at(-1)![1] as { description?: unknown; version?: number };
    expect(p.description).toBe("the roster label");
    expect(p.version).toBeUndefined();
    expect(putVersion).not.toHaveBeenCalled();
  });
});

describe("GET /agents/:id/metrics query validation", () => {
  const get = (qs: string) => app.request(`/agents/agent-1/metrics${qs}`, { headers: auth });

  it("400s a non-numeric version rather than reporting all-zeros", async () => {
    // `Number("abc")` is NaN, which matches no session - so the dashboard would
    // confidently render an empty chart for a filter the caller mistyped.
    const res = await get("?version=abc");
    expect(res.status).toBe(400);
    expect(metricsFor).not.toHaveBeenCalled();
  });

  it("accepts a numeric version and an absent one", async () => {
    expect((await get("?version=3")).status).toBe(200);
    expect((await get("")).status).toBe(200);
    // An empty value means "no filter", not version NaN.
    expect((await get("?version=")).status).toBe(200);
    for (const call of metricsFor.mock.calls) {
      const version = (call as unknown[])[4];
      expect(version === null || Number.isInteger(version)).toBe(true);
    }
  });
});

describe("an orphaned version row doesn't brick the agent", () => {
  /**
   * `putVersion` can succeed and the following `updateAgent` fail non-conditionally
   * (throttling, timeout), leaving a version row the agent record doesn't point at.
   * If the retry recomputed `version` from the agent alone it would re-claim that same
   * taken slot on every attempt - so every config edit and every restore would 503
   * FOREVER, with no API path to recover. The bump reconciles against history instead.
   */
  it("steps past a claimed slot instead of re-claiming it forever", async () => {
    // History is at v6 while the agent still reads v5 - the divergence.
    highestVersion.mockImplementation(async () => 6);
    // v6 is taken; anything above it is free.
    putVersion.mockImplementation(async (v: unknown) => {
      if ((v as { version: number }).version <= 6) conditionalFail();
    });

    const res = await patch({ systemPrompt: "changed" });
    expect(res.status).toBe(200);
    // It tried 6 (from the agent), then reconciled to history and claimed 7.
    const claimed = putVersion.mock.calls.map((c) => (c[0] as { version: number }).version);
    expect(claimed).toContain(7);
    expect(updateAgent.mock.calls.at(-1)![1]).toMatchObject({ version: 7 });
  });

  it("still guards the agent on its REAL version while skipping the orphan", async () => {
    // The claim and `expectedVersion` are different numbers once history is ahead:
    // the claim skips the orphaned slot, but the agent guard must stay the record's
    // actual version (5). Conflating them made the guard unsatisfiable, so the edit
    // could never land and every attempt 503'd - the bug the fix was meant to remove.
    highestVersion.mockImplementation(async () => 6);
    const taken = new Set([6]);
    putVersion.mockImplementation(async (v: unknown) => {
      const n = (v as { version: number }).version;
      if (taken.has(n)) conditionalFail();
      taken.add(n);
    });
    // The real DynamoDB condition on the agent row.
    updateAgent.mockImplementation(async (_id: string, p: unknown) => {
      const patch2 = p as { expectedVersion?: number };
      if (patch2.expectedVersion !== undefined && patch2.expectedVersion !== 5) conditionalFail();
    });

    const res = await patch({ systemPrompt: "changed" });
    expect(res.status).toBe(200);
    const last = updateAgent.mock.calls.at(-1)![1] as { version: number; expectedVersion: number };
    expect(last.version).toBe(7); // skipped the orphan at 6
    expect(last.expectedVersion).toBe(5); // guarded on what the record actually says
  });
});
