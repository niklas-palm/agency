/**
 * A failed config write must not leave EventBridge running a schedule the stored
 * config doesn't have.
 *
 * `applyNewVersion` reconciles the schedule BEFORE persisting, so that a schedule
 * EventBridge rejects fails the request instead of diverging. That leaves the mirror
 * case: reconcile succeeds, then the DynamoDB write loses (CAS contention, throttling).
 * Without a compensating reconcile, the live schedule follows the NEW config while the
 * stored config is still the old one - a scheduled agent that silently stops firing (or
 * starts firing on a cadence nobody saved).
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

/** The stored agent runs hourly - the schedule a failed edit must not destroy. */
const SCHEDULE = { type: "schedule", expression: "rate(1 hour)", prompt: "tick" };
const AGENT = {
  id: "agent-1", orgId: "org-A", createdBy: "user-A", shared: true,
  config: {
    name: "a", systemPrompt: "s", model: "haiku-4.5", baseTools: false,
    webSearch: false, networkAccess: true, triggers: [{ type: "api" }, SCHEDULE],
  },
  version: 5, invokeUrl: "http://x", apiKeyHash: "h", createdAt: "t", updatedAt: "t",
  metrics: { invocations: 0, lastInvokedAt: null },
};

const getAgent = vi.fn(async () => ({ ...AGENT }));
const putVersion = vi.fn(async (_v: unknown) => {});
vi.mock("./repo/agents.js", () => ({
  getAgent: (...a: []) => getAgent(...a),
  updateAgent: vi.fn(async () => {}),
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
  // 0 = "no version rows", so the agent record's version governs the bump.
  highestVersion: vi.fn(async () => 0),
}));
vi.mock("./repo/skills.js", () => ({ getSkillsByIds: vi.fn(async () => []), listSkills: vi.fn(async () => []) }));
vi.mock("./repo/sessions.js", () => ({
  metricsFor: vi.fn(async () => ({ sessions: 0, series: [] })),
  writeSummary: vi.fn(async () => {}),
}));

/** Watch what the scheduler is asked to do, in order. */
const reconcile = vi.fn(async (_id: string, _s: unknown) => {});

import { buildApp } from "./app.js";

// Inject the deps rather than mocking a module: buildDeps() picks the scheduler from
// MODE, which isn't "local" under vitest, so it would build the real EventBridge one.
const app = buildApp({
  scheduler: { reconcile: (id: string, s: unknown) => reconcile(id, s) } as never,
  invoker: { invoke: async () => ({ sessionId: "s", status: "triggered" as const }) } as never,
  identity: { ensureUser: async () => "exists" as const, emailFor: async () => undefined } as never,
});
const auth = { Authorization: "Bearer agpat_sched_rollback_token_0000000" };
const patch = (body: unknown) =>
  app.request("/agents/agent-1", {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getAgent.mockImplementation(async () => ({ ...AGENT }));
  putVersion.mockImplementation(async () => {});
});

describe("a failed config write rolls the schedule back", () => {
  it("restores the stored schedule when the version append keeps losing the CAS", async () => {
    // Every attempt loses, so the request 503s having persisted nothing.
    putVersion.mockImplementation(() => {
      throw Object.assign(new Error("cas"), { name: "ConditionalCheckFailedException" });
    });
    // Drop the schedule as part of the edit - the destructive direction.
    const res = await patch({ triggers: [{ type: "api" }] });
    expect(res.status).toBe(503);

    // First it reconciled to the requested state (no schedule)...
    expect(reconcile.mock.calls[0]).toEqual(["agent-1", null]);
    // ...and the LAST thing it did was put the stored schedule back, so EventBridge
    // agrees with the config that's actually saved.
    expect(reconcile.mock.calls.at(-1)).toEqual(["agent-1", SCHEDULE]);
  });

  it("restores it when the write fails for a non-CAS reason too", async () => {
    putVersion.mockImplementation(() => {
      throw Object.assign(new Error("boom"), { name: "ProvisionedThroughputExceededException" });
    });
    const res = await patch({ triggers: [{ type: "api" }] });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(reconcile.mock.calls.at(-1)).toEqual(["agent-1", SCHEDULE]);
  });

  it("leaves the new schedule in place when the write succeeds", async () => {
    const res = await patch({ triggers: [{ type: "api" }] });
    expect(res.status).toBe(200);
    // One reconcile, to the requested state. No rollback.
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]).toEqual(["agent-1", null]);
  });
});
