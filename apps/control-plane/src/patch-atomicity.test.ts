/**
 * A rejected PATCH must not persist half of itself.
 *
 * `PATCH /agents/:id` writes in two steps: metadata (description/shared/managers, no
 * version bump) and then the versioned config. A validation gate sitting BETWEEN them
 * let a request that returned 400 still commit the metadata half - the caller was told
 * the edit failed while the agent had already been un-shared. So every gate has to run
 * before the first write.
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

/** A public-mode agent on an Anthropic model, shared with the org. */
const AGENT = {
  id: "agent-1", orgId: "org-A", createdBy: "user-A", shared: true,
  config: {
    name: "a", systemPrompt: "s", model: "haiku-4.5", baseTools: false,
    webSearch: false, networkAccess: true, networkMode: "public", triggers: [{ type: "api" }],
  },
  version: 3, invokeUrl: "http://x", apiKeyHash: "h", createdAt: "t", updatedAt: "t",
  metrics: { invocations: 0, lastInvokedAt: null },
};

const updateAgent = vi.fn(async (_id: string, _patch: unknown) => {});
const putVersion = vi.fn(async () => {});
vi.mock("./repo/agents.js", async () => {
  const actual = await import("./repo/agents.js");
  return {
    ...actual,
    getAgent: vi.fn(async (id: string) => (id === "agent-1" ? { ...AGENT } : null)),
    listAgentsByOrg: vi.fn(async () => []),
    putAgent: vi.fn(async () => {}),
    updateAgent: (id: string, patch: unknown) => updateAgent(id, patch),
    deleteAgent: vi.fn(async () => {}),
  };
});
vi.mock("./repo/versions.js", () => ({
  putVersion: (...a: unknown[]) => putVersion(...(a as [])),
  listVersions: vi.fn(async () => []),
}));
vi.mock("./repo/skills.js", () => ({ getSkillsByIds: vi.fn(async () => []), listSkills: vi.fn(async () => []) }));
vi.mock("./repo/sessions.js", () => ({
  metricsFor: vi.fn(async () => ({ sessions: 0, series: [] })),
  writeSummary: vi.fn(async () => {}),
  listRuns: vi.fn(async () => []),
  getRun: vi.fn(async () => null),
}));

import { buildApp } from "./app.js";

const app = buildApp();
const auth = { Authorization: "Bearer agpat_patch_atomicity_token_000000" };
const patch = (body: unknown) =>
  app.request("/agents/agent-1", {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => vi.clearAllMocks());

describe("PATCH /agents/:id is all-or-nothing", () => {
  it("writes NOTHING when the model isn't allowed in the requested network mode", async () => {
    // OpenAI models can't run isolated (Mantle needs public egress). The request also
    // carries `shared: false` - the metadata half, which used to land regardless.
    const res = await patch({ shared: false, networkMode: "isolated", model: "gpt-5.6-luna" });
    expect(res.status).toBe(400);
    expect(updateAgent).not.toHaveBeenCalled();
    expect(putVersion).not.toHaveBeenCalled();
  });

  it("still applies a metadata-only edit that passes validation", async () => {
    const res = await patch({ shared: false });
    expect(res.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith("agent-1", { shared: false });
    // Metadata isn't behavior, so it mints no version.
    expect(putVersion).not.toHaveBeenCalled();
  });

  it("rejects an invalid config without touching metadata", async () => {
    const res = await patch({ shared: false, model: "not-a-real-model" });
    expect(res.status).toBe(400);
    expect(updateAgent).not.toHaveBeenCalled();
  });
});
