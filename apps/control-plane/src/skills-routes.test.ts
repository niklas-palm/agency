/**
 * Skills routes: name uniqueness per ORG + doc validation. Auth is enabled
 * (AUTH_DISABLED unset); a mocked PAT resolves to user-A whose membership in org-A
 * is admin (full scopes). The skills repo is mocked so we control the org's
 * existing skills.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./repo/tokens.js", () => ({
  getTokenByHash: vi.fn(async () => ({
    tokenHash: "h",
    id: "tok",
    ownerId: "user-A",
    orgId: "org-A",
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

// user-A is an admin of org-A (so the PAT resolves to full role scopes).
vi.mock("./repo/memberships.js", () => ({
  getMembership: vi.fn(async (orgId: string, userId: string) =>
    orgId === "org-A" && userId === "user-A"
      ? { orgId: "org-A", userId: "user-A", role: "admin", joinedAt: "2026-01-01T00:00:00Z" }
      : null,
  ),
}));

// One existing skill named "review" in org-A, created by user-A, shared.
const EXISTING = {
  id: "skill-1",
  orgId: "org-A",
  createdBy: "user-A",
  shared: true,
  name: "review",
  description: "d",
  content: "c",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const putSkill = vi.fn(async (_r: unknown) => {});
vi.mock("./repo/skills.js", () => ({
  listSkills: vi.fn(async () => [EXISTING]),
  getSkill: vi.fn(async (_o: string, id: string) => (id === EXISTING.id ? EXISTING : null)),
  putSkill: (r: unknown) => putSkill(r),
  deleteSkill: vi.fn(async () => {}),
  getSkillsByIds: vi.fn(async () => []),
}));
vi.mock("./repo/agents.js", () => ({
  listAgentsByOrg: vi.fn(async () => []),
  getAgent: vi.fn(async () => null),
  putAgent: vi.fn(async () => {}),
  updateAgent: vi.fn(async () => {}),
  deleteAgent: vi.fn(async () => {}),
  toPublic: (r: Record<string, unknown>) => r,
  normalizeConfig: (c: Record<string, unknown>) => c,
  freshMetrics: () => ({ invocations: 0, lastInvokedAt: null }),
}));

import { buildApp } from "./app.js";

const app = buildApp();
const auth = { Authorization: "Bearer agpat_test_token_value_0000000000000000" };

/** A valid SKILL.md with the given name. */
function doc(name: string): string {
  return `---\nname: ${name}\ndescription: A test skill\n---\n\n# ${name}\n\n## Overview\nx\n\n## Steps\n1. y\n`;
}
function post(content: string) {
  return app.request("/skills", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
}

describe("skills routes: name uniqueness", () => {
  beforeEach(() => vi.clearAllMocks());

  it("409s a create whose name collides with an existing skill", async () => {
    const res = await post(doc("review"));
    expect(res.status).toBe(409);
    expect(putSkill).not.toHaveBeenCalled();
  });

  it("201s a create with a fresh name", async () => {
    const res = await post(doc("summarize"));
    expect(res.status).toBe(201);
    expect(putSkill).toHaveBeenCalledOnce();
  });

  it("400s an invalid SKILL.md (missing frontmatter) with details", async () => {
    const res = await post("# no frontmatter\nbody");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { details?: string[] };
    expect(body.details?.some((d) => /frontmatter/i.test(d))).toBe(true);
  });

  it("lets a skill keep its own name on update (no self-collision)", async () => {
    const res = await app.request(`/skills/${EXISTING.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ content: doc("review") }), // same name, same skill
    });
    expect(res.status).toBe(200);
    expect(putSkill).toHaveBeenCalledOnce();
  });
});

describe("skills routes: managers grant", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists only valid org members as managers, dropping non-members + the creator", async () => {
    // Both requested managers are invalid: "user-A" is the creator (always implicit,
    // dropped) and "stranger" isn't a member of org-A (getMembership → null), so the
    // stored record ends up with no managers key at all.
    const res = await app.request("/skills", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      // "stranger" is not a member → dropped; "user-A" is the creator → dropped.
      body: JSON.stringify({ content: doc("with-mgrs"), managers: ["user-A", "stranger"] }),
    });
    expect(res.status).toBe(201);
    const saved = putSkill.mock.calls[0]![0] as { managers?: string[] };
    // Both entries are invalid (creator + non-member), so no managers key is stored.
    expect(saved.managers).toBeUndefined();
  });
});
