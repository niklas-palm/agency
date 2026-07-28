/**
 * `usedByAgentCount` on a skill / integration must be counted over the agents the CALLER
 * CAN SEE, not over the whole org.
 *
 * Counting all of the org's agents told a viewer how many of a co-member's PRIVATE agents
 * used a shared skill - a fact about resources they can't see, which quietly weakens
 * "admin does not pierce privacy" and the visibility rule generally. It's one integer, but
 * it's an integer derived from invisible records.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@agency/shared";

let caller = { userId: "alice", orgId: "org-A", role: "viewer" as Role };

vi.mock("./repo/tokens.js", () => ({
  getTokenByHash: vi.fn(async () => ({
    tokenHash: "h",
    id: "tok",
    ownerId: caller.userId,
    orgId: caller.orgId,
    name: "t",
    scopes: ["read", "write", "delete"],
    createdAt: "2026-01-01T00:00:00Z",
    lastUsedAt: null,
  })),
  touchToken: vi.fn(async () => {}),
  listTokensByOwner: vi.fn(async () => []),
  putToken: vi.fn(async () => {}),
  deleteTokenById: vi.fn(async () => false),
  toPublicToken: (r: Record<string, unknown>) => r,
}));

vi.mock("./repo/memberships.js", () => ({
  getMembership: vi.fn(async (orgId: string, userId: string) =>
    orgId === "org-A" ? { orgId, userId, role: caller.role, joinedAt: "2026-01-01T00:00:00Z" } : null,
  ),
}));

const cfg = (skillIds: string[]) => ({
  name: "a",
  systemPrompt: "p",
  model: "haiku-4.5",
  skillIds,
  integrationIds: ["int-1"],
  triggers: [{ type: "api" }],
});

// bob owns three agents that use the skill: one SHARED, two PRIVATE. alice sees only the
// shared one, so an honest count for alice is 1 - not 3.
const base = {
  orgId: "org-A",
  createdBy: "bob",
  version: 1,
  invokeUrl: "http://x/invoke",
  apiKeyHash: "h",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  metrics: { invocations: 0, lastInvokedAt: null },
};
const AGENTS = [
  { ...base, id: "a-shared", shared: true, config: cfg(["skill-1"]) },
  { ...base, id: "a-private-1", shared: false, config: cfg(["skill-1"]) },
  { ...base, id: "a-private-2", shared: false, config: cfg(["skill-1"]) },
];

vi.mock("./repo/agents.js", async () => {
  const actual = await vi.importActual<typeof import("./repo/agents.js")>("./repo/agents.js");
  return { ...actual, listAgentsByOrg: vi.fn(async () => AGENTS), getAgent: vi.fn(async () => null) };
});

const SKILL = {
  id: "skill-1",
  orgId: "org-A",
  createdBy: "bob",
  shared: true,
  name: "review",
  description: "d",
  content: "c",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
vi.mock("./repo/skills.js", () => ({
  getSkill: vi.fn(async (o: string, id: string) => (o === "org-A" && id === "skill-1" ? SKILL : null)),
  listSkills: vi.fn(async () => [SKILL]),
  putSkill: vi.fn(async () => {}),
  deleteSkill: vi.fn(async () => {}),
  getSkillsByIds: vi.fn(async () => []),
}));

const INTEGRATION = {
  id: "int-1",
  orgId: "org-A",
  createdBy: "bob",
  shared: true,
  name: "petstore",
  description: "d",
  baseUrl: "https://api.example.com",
  auth: { kind: "none" as const },
  operations: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
vi.mock("./repo/integrations.js", async () => {
  const actual = await vi.importActual<typeof import("./repo/integrations.js")>("./repo/integrations.js");
  return {
    ...actual,
    getIntegration: vi.fn(async (o: string, id: string) => (o === "org-A" && id === "int-1" ? INTEGRATION : null)),
    listIntegrations: vi.fn(async () => [INTEGRATION]),
    putIntegration: vi.fn(async () => {}),
    deleteIntegration: vi.fn(async () => {}),
    getIntegrationsByIds: vi.fn(async () => []),
  };
});

import { buildApp } from "./app.js";

const app = buildApp();
const auth = { Authorization: "Bearer agpat_usage_count_test_token_0000000" };
const get = (path: string) => app.request(path, { headers: auth });

beforeEach(() => {
  caller = { userId: "alice", orgId: "org-A", role: "viewer" };
});

describe("usedByAgentCount counts only agents the caller can see", () => {
  it("a co-member's PRIVATE agents don't inflate the skill count", async () => {
    const { skills } = (await (await get("/skills")).json()) as {
      skills: { usedByAgentCount: number }[];
    };
    expect(skills[0]!.usedByAgentCount).toBe(1); // the shared agent only, not all 3
  });

  it("...on the skill detail route either", async () => {
    const { skill } = (await (await get("/skills/skill-1")).json()) as {
      skill: { usedByAgentCount: number };
    };
    expect(skill.usedByAgentCount).toBe(1);
  });

  it("...nor the integration count, on list or detail", async () => {
    const { integrations } = (await (await get("/integrations")).json()) as {
      integrations: { usedByAgentCount: number }[];
    };
    expect(integrations[0]!.usedByAgentCount).toBe(1);

    const { integration } = (await (await get("/integrations/int-1")).json()) as {
      integration: { usedByAgentCount: number };
    };
    expect(integration.usedByAgentCount).toBe(1);
  });

  it("the CREATOR still sees the true count of their own agents", async () => {
    caller = { userId: "bob", orgId: "org-A", role: "editor" };
    const { skills } = (await (await get("/skills")).json()) as {
      skills: { usedByAgentCount: number }[];
    };
    expect(skills[0]!.usedByAgentCount).toBe(3);
  });
});
