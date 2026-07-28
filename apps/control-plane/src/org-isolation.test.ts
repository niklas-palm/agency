/**
 * Org isolation + per-resource visibility (the hard-requirement acceptance gate,
 * replacing tenant-isolation.test.ts). Drives the real requireAuth → requireScope
 * chain (AUTH_DISABLED unset) via a mocked PAT whose owner + org + role we vary,
 * against a fixed set of agents in org-A. Asserts the locked decisions:
 *   - a NON-MEMBER of an org is denied everything (404).
 *   - a member sees SHARED resources but NOT a co-member's PRIVATE one (404) -
 *     including an admin (Q2: admin does not pierce privacy).
 *   - the creator sees + edits their own; an editor CANNOT edit a co-member's
 *     shared resource (403), but an ADMIN can (Q3).
 *   - cross-org ids never resolve.
 *
 * We mock the repos so the auth + authz logic is what's under test, not DynamoDB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@agency/shared";

// The caller identity for the current test (varied per case).
let caller = { userId: "alice", orgId: "org-A", role: "admin" as Role };

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

// Membership resolves the caller's role in org-A - but ONLY for actual members.
// carol is deliberately NOT a member (so her PAT is dead). Everyone else's role is
// whatever the current test set on `caller`.
vi.mock("./repo/memberships.js", () => ({
  getMembership: vi.fn(async (orgId: string, userId: string) => {
    // org-B exists too (with no resources), so a caller can act OUTSIDE org-A - which
    // is what makes a lookup pinned to a hardcoded "org-A" detectable.
    if ((orgId !== "org-A" && orgId !== "org-B") || userId === "carol") return null;
    return { orgId, userId, role: caller.role, joinedAt: "2026-01-01T00:00:00Z" };
  }),
}));

// Two agents in org-A: one SHARED (created by alice), one PRIVATE (created by bob).
const SHARED = {
  id: "agent-shared",
  orgId: "org-A",
  createdBy: "alice",
  shared: true,
  config: { name: "s", systemPrompt: "s", model: "haiku-4.5", baseTools: false, webSearch: false, networkAccess: true, triggers: [{ type: "api" }], env: { THIRD_PARTY_KEY: "super-secret" } },
  version: 2,
  invokeUrl: "http://x/agents/agent-shared/invoke",
  apiKeyHash: "hash",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  metrics: { invocations: 0, lastInvokedAt: null },
};
const PRIVATE = { ...SHARED, id: "agent-private", createdBy: "bob", shared: false };
// A shared agent created by alice with bob granted as an explicit manager.
const MANAGED = { ...SHARED, id: "agent-managed", createdBy: "alice", shared: true, managers: ["bob"] };
const AGENTS: Record<string, typeof SHARED> = { [SHARED.id]: SHARED, [PRIVATE.id]: PRIVATE, [MANAGED.id]: MANAGED };

// Only the DynamoDB accessors are faked; `toPublic` + `normalizeConfig` come through
// from the real module (the same pattern as the integrations mock below). That matters:
// the tests asserting no key/hash ever reaches a response would pass against a
// re-implemented `toPublic` even if the real one leaked - they'd be testing the mock.
vi.mock("./repo/agents.js", async () => {
  const actual = await vi.importActual<typeof import("./repo/agents.js")>("./repo/agents.js");
  return {
    ...actual,
    getAgent: vi.fn(async (id: string) => AGENTS[id] ?? null),
    listAgentsByOrg: vi.fn(async (orgId: string) => (orgId === "org-A" ? [SHARED, PRIVATE] : [])),
    putAgent: vi.fn(async () => {}),
    updateAgent: vi.fn(async () => {}),
    deleteAgent: vi.fn(async () => {}),
    freshMetrics: () => ({ invocations: 0, lastInvokedAt: null }),
  };
});
vi.mock("./repo/versions.js", () => ({
  putVersion: vi.fn(async () => {}),
  listVersions: vi.fn(async () => [{ agentId: "agent-shared", version: 1, config: SHARED.config, createdAt: "x" }]),
}));
vi.mock("./repo/sessions.js", () => ({
  metricsFor: vi.fn(async () => ({ sessions: 0, series: [] })),
}));

// A shared skill + integration created by alice, so the DELETE routes on those
// resources can be exercised against the per-resource rule too - not just agents.
// (The scope gate is covered in routes-scope.test.ts; this is the OTHER half:
// `authorize(..., "write")`, which decides WHICH skill/integration you may destroy.)
const SHARED_SKILL = {
  id: "skill-shared", orgId: "org-A", createdBy: "alice", shared: true,
  name: "review", description: "d", content: "c",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const deleteSkill = vi.fn(async (_o: string, _id: string) => {});
vi.mock("./repo/skills.js", () => ({
  // Both of these HONOUR the org they're passed, and the delete spy keeps its args.
  // A mock that ignores them can't tell a correct lookup from one pinned to a
  // hardcoded org - i.e. it would hide a cross-tenant read on the delete path.
  getSkill: vi.fn(async (orgId: string, id: string) =>
    orgId === SHARED_SKILL.orgId && id === SHARED_SKILL.id ? SHARED_SKILL : null,
  ),
  listSkills: vi.fn(async () => [SHARED_SKILL]),
  putSkill: vi.fn(async () => {}),
  deleteSkill: (o: string, id: string) => deleteSkill(o, id),
  getSkillsByIds: vi.fn(async () => []),
}));

const SHARED_INTEGRATION = {
  id: "int-shared", orgId: "org-A", createdBy: "alice", shared: true,
  name: "petstore", description: "d", baseUrl: "https://api.example.com",
  auth: { kind: "bearer" as const }, operations: [], secret: "downstream-token",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const deleteIntegration = vi.fn(async (_o: string, _id: string) => {});
vi.mock("./repo/integrations.js", async () => {
  const actual = await vi.importActual<typeof import("./repo/integrations.js")>("./repo/integrations.js");
  return {
    ...actual,
    getIntegration: vi.fn(async (orgId: string, id: string) =>
      orgId === SHARED_INTEGRATION.orgId && id === SHARED_INTEGRATION.id ? SHARED_INTEGRATION : null,
    ),
    listIntegrations: vi.fn(async () => [SHARED_INTEGRATION]),
    putIntegration: vi.fn(async () => {}),
    deleteIntegration: (o: string, id: string) => deleteIntegration(o, id),
    getIntegrationsByIds: vi.fn(async () => []),
  };
});

import { buildApp } from "./app.js";
import { updateAgent } from "./repo/agents.js";
import { getSkill } from "./repo/skills.js";
import { getIntegration } from "./repo/integrations.js";

const app = buildApp();
const auth = { Authorization: "Bearer agpat_isolation_test_token_00000000000000" };

async function req(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { ...auth, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  caller = { userId: "alice", orgId: "org-A", role: "admin" };
});

// A membership row is CAST off DynamoDB, not validated, so a legacy/hand-edited row
// can carry a role outside the union. That used to make principal.scopes undefined and
// crash hasScope with a 500; scopesForRole now returns [] so every route 403s.
describe("a corrupt membership role fails closed, not with a 500", () => {
  it("403s reads and writes alike", async () => {
    caller = { userId: "alice", orgId: "org-A", role: "member" as Role };
    expect((await req("GET", "/agents")).status).toBe(403);
    expect((await req("DELETE", "/skills/skill-shared")).status).toBe(403);
  });
});

describe("a PAT whose owner isn't a member of the token's org is dead", () => {
  beforeEach(() => {
    // The token is bound to org-A but its owner (carol) has no membership there
    // (getMembership → null), so authenticateToken returns null → 401. (The 403
    // "asserted a non-member org" path is the JWT+header case, exercised implicitly
    // by requireAuth's resolveRole; a PAT can only ever act in its own bound org.)
    caller = { userId: "carol", orgId: "org-A", role: "admin" };
  });
  it("401s every management route (the token no longer resolves to a member)", async () => {
    for (const [m, p] of [
      ["GET", "/agents"],
      ["GET", "/agents/agent-shared"],
      ["POST", "/agents"],
    ] as [string, string][]) {
      const res = await req(m, p, m === "POST" ? { name: "x", systemPrompt: "y", model: "haiku-4.5" } : undefined);
      expect(res.status, `${m} ${p}`).toBe(401);
    }
  });
});

describe("private resources are creator-only (Q2 - admin does not pierce privacy)", () => {
  it("an admin who didn't create a PRIVATE agent gets 404 (invisible)", async () => {
    caller = { userId: "alice", orgId: "org-A", role: "admin" }; // alice is admin, bob owns the private agent
    expect((await req("GET", "/agents/agent-private")).status).toBe(404);
  });

  it("the creator sees their own private agent", async () => {
    caller = { userId: "bob", orgId: "org-A", role: "editor" };
    expect((await req("GET", "/agents/agent-private")).status).toBe(200);
  });

  it("GET /agents lists shared + own private, hiding a co-member's private", async () => {
    caller = { userId: "alice", orgId: "org-A", role: "admin" };
    const res = await req("GET", "/agents");
    const { agents } = (await res.json()) as { agents: { id: string }[] };
    expect(agents.map((a) => a.id).sort()).toEqual(["agent-shared"]); // NOT agent-private (bob's)
  });

  it("bob's listing includes his own private agent", async () => {
    caller = { userId: "bob", orgId: "org-A", role: "editor" };
    const res = await req("GET", "/agents");
    const { agents } = (await res.json()) as { agents: { id: string }[] };
    expect(agents.map((a) => a.id).sort()).toEqual(["agent-private", "agent-shared"]);
  });
});

describe("the plaintext API key is never served, to anyone", () => {
  /**
   * Stronger than the gating this replaces. The key used to be RETAINED on the record
   * so the console could show it, and `publicAgentFor` stripped it for non-writers -
   * which meant a table read (a PITR export, an over-broad grant) still yielded live
   * keys, defeating the SHA-256 hashing sitting right next to it. Now the plaintext is
   * returned exactly once at create/rotate and never stored, so there is nothing to
   * strip and no caller - writer or not - can read one back.
   */
  it("a writer who can see everything still gets no key from a read", async () => {
    caller = { userId: "alice", orgId: "org-A", role: "admin" };
    const list = (await (await req("GET", "/agents")).json()) as {
      agents: Record<string, unknown>[];
    };
    for (const a of list.agents) expect(a.apiKey).toBeUndefined();
    const one = (await (await req("GET", "/agents/agent-shared")).json()) as {
      agent: Record<string, unknown>;
    };
    expect(one.agent.apiKey).toBeUndefined();
  });

  it("never serves the key HASH either", async () => {
    caller = { userId: "alice", orgId: "org-A", role: "admin" };
    const { agent } = (await (await req("GET", "/agents/agent-shared")).json()) as {
      agent: Record<string, unknown>;
    };
    expect(agent.apiKeyHash).toBeUndefined();
  });

  // config.env holds per-agent third-party secrets, so the VALUES are redacted for a
  // non-writer (keys kept - they're already surfaced to the model by name and drive
  // the UI).
  it("redacts config.env VALUES for a non-writer, keeping the key names", async () => {
    caller = { userId: "eve", orgId: "org-A", role: "viewer" };
    const res = await req("GET", "/agents/agent-shared");
    const { agent } = (await res.json()) as { agent: { config: { env?: Record<string, string> } } };
    expect(Object.keys(agent.config.env!)).toEqual(["THIRD_PARTY_KEY"]);
    expect(agent.config.env!.THIRD_PARTY_KEY).toBe("***");
  });

  it("gives the CREATOR the real config.env values", async () => {
    caller = { userId: "alice", orgId: "org-A", role: "editor" }; // alice created agent-shared
    const res = await req("GET", "/agents/agent-shared");
    const { agent } = (await res.json()) as { agent: { config: { env?: Record<string, string> } } };
    expect(agent.config.env!.THIRD_PARTY_KEY).toBe("super-secret");
  });

  it("redacts config.env in the VERSIONS history too (no way around the redaction)", async () => {
    caller = { userId: "eve", orgId: "org-A", role: "viewer" };
    const res = await req("GET", "/agents/agent-shared/versions");
    const { versions } = (await res.json()) as { versions: { config: { env?: Record<string, string> } }[] };
    expect(versions[0]!.config.env!.THIRD_PARTY_KEY).toBe("***");
  });
});

describe("editing shared resources (Q3 - creator + admin only)", () => {
  it("an EDITOR cannot edit a co-member's shared agent → 403", async () => {
    caller = { userId: "eve", orgId: "org-A", role: "editor" }; // eve didn't create SHARED (alice did)
    expect((await req("PATCH", "/agents/agent-shared", { systemPrompt: "x" })).status).toBe(403);
  });

  it("an ADMIN can edit any shared agent → not 403/404 (reaches the handler)", async () => {
    caller = { userId: "eve", orgId: "org-A", role: "admin" };
    expect((await req("PATCH", "/agents/agent-shared", { systemPrompt: "x" })).status).toBe(200);
  });

  it("the CREATOR (editor role) can edit their own shared agent", async () => {
    caller = { userId: "alice", orgId: "org-A", role: "editor" };
    expect((await req("PATCH", "/agents/agent-shared", { systemPrompt: "x" })).status).toBe(200);
  });

  it("a VIEWER is blocked from editing even a shared agent (scope gate) → 403", async () => {
    caller = { userId: "alice", orgId: "org-A", role: "viewer" };
    expect((await req("PATCH", "/agents/agent-shared", { systemPrompt: "x" })).status).toBe(403);
  });

  it("nobody can edit a co-member's PRIVATE agent → 404 (invisible, not 403)", async () => {
    caller = { userId: "alice", orgId: "org-A", role: "admin" };
    expect((await req("PATCH", "/agents/agent-private", { systemPrompt: "x" })).status).toBe(404);
  });
});

describe("delete + rotate-key honor the ownership rule", () => {
  it("editor deleting a co-member's shared agent → 403", async () => {
    caller = { userId: "eve", orgId: "org-A", role: "editor" };
    expect((await req("DELETE", "/agents/agent-shared")).status).toBe(403);
  });
  it("admin deleting a shared agent → 204", async () => {
    caller = { userId: "eve", orgId: "org-A", role: "admin" };
    expect((await req("DELETE", "/agents/agent-shared")).status).toBe(204);
  });

  // Skills + integrations, not just agents. Holding the `delete` SCOPE says you may
  // destroy things; `authorize(..., "write")` says WHICH ones. Without these, that
  // second half was untested on both routes - a downgrade to "view" would have let
  // any org member destroy a co-member's shared skill, or an integration and its
  // unrecoverable credential, with the whole suite still green.
  it("editor deleting a co-member's shared skill → 403", async () => {
    caller = { userId: "eve", orgId: "org-A", role: "editor" };
    expect((await req("DELETE", "/skills/skill-shared")).status).toBe(403);
    expect(deleteSkill).not.toHaveBeenCalled();
  });
  it("admin deleting a shared skill → 204", async () => {
    caller = { userId: "eve", orgId: "org-A", role: "admin" };
    expect((await req("DELETE", "/skills/skill-shared")).status).toBe(204);
    // The org comes from the PRINCIPAL, not a constant - assert both, so a lookup or
    // delete pinned to a hardcoded org (a cross-tenant reach) fails here.
    expect(deleteSkill).toHaveBeenCalledWith("org-A", "skill-shared");
  });
  it("editor deleting a co-member's shared integration → 403 (its credential survives)", async () => {
    caller = { userId: "eve", orgId: "org-A", role: "editor" };
    expect((await req("DELETE", "/integrations/int-shared")).status).toBe(403);
    expect(deleteIntegration).not.toHaveBeenCalled();
  });
  it("admin deleting a shared integration → 204", async () => {
    caller = { userId: "eve", orgId: "org-A", role: "admin" };
    expect((await req("DELETE", "/integrations/int-shared")).status).toBe(204);
    expect(deleteIntegration).toHaveBeenCalledWith("org-A", "int-shared");
  });
  // The org in every lookup must come from the PRINCIPAL. An admin acting in org-B
  // must not reach org-A's resources - and since canView also re-checks the org, a
  // lookup pinned to a hardcoded org would be a silent loss of defence-in-depth
  // rather than an outright hole. Pin it here so it can't rot.
  it("an admin of ANOTHER org can't delete org-A's skill or integration → 404", async () => {
    caller = { userId: "alice", orgId: "org-B", role: "admin" };
    expect((await req("DELETE", "/skills/skill-shared")).status).toBe(404);
    expect((await req("DELETE", "/integrations/int-shared")).status).toBe(404);
    expect(deleteSkill).not.toHaveBeenCalled();
    expect(deleteIntegration).not.toHaveBeenCalled();
    // Assert the LOOKUP's org, not just the outcome: canView re-checks `orgId` too, so
    // a lookup pinned to a hardcoded org yields the same 404 and would otherwise be an
    // invisible loss of defence-in-depth.
    expect(getSkill).toHaveBeenCalledWith("org-B", "skill-shared");
    expect(getIntegration).toHaveBeenCalledWith("org-B", "int-shared");
  });

  it("the CREATOR can delete their own shared skill + integration → 204", async () => {
    caller = { userId: "alice", orgId: "org-A", role: "editor" };
    expect((await req("DELETE", "/skills/skill-shared")).status).toBe(204);
    expect((await req("DELETE", "/integrations/int-shared")).status).toBe(204);
  });
});

describe("managers grant: write yes, re-delegation no", () => {
  it("a granted manager (editor) CAN edit the resource's config", async () => {
    caller = { userId: "bob", orgId: "org-A", role: "editor" }; // bob ∈ agent-managed.managers
    expect((await req("PATCH", "/agents/agent-managed", { systemPrompt: "x" })).status).toBe(200);
  });

  it("a granted manager CANNOT re-delegate: their attempt to add 'eve' is dropped, stored list preserved", async () => {
    caller = { userId: "bob", orgId: "org-A", role: "editor" };
    const res = await req("PATCH", "/agents/agent-managed", { managers: ["bob", "eve"] });
    expect(res.status).toBe(200);
    // The manager PATCH DOES persist metadata (patchManagers returns the preserved
    // list), so assert the write happened AND it kept the stored ["bob"] - never
    // "eve". (Unconditional: if the route stopped writing managers entirely, the
    // old `if (managersWrite)` guard would have hidden that by asserting nothing.)
    const calls = (updateAgent as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const managersWrite = calls.find((c) => c[1] && typeof c[1] === "object" && "managers" in (c[1] as object));
    expect(managersWrite).toBeTruthy();
    expect((managersWrite![1] as { managers: string[] | null }).managers).toEqual(["bob"]);
  });

  it("the CREATOR can re-delegate: a managers change in their PATCH is applied", async () => {
    caller = { userId: "alice", orgId: "org-A", role: "editor" }; // alice created agent-managed
    const res = await req("PATCH", "/agents/agent-managed", { managers: [] });
    expect(res.status).toBe(200);
    const calls = (updateAgent as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const managersWrite = calls.find((c) => c[1] && typeof c[1] === "object" && "managers" in (c[1] as object));
    expect(managersWrite).toBeTruthy();
    // Empty list resolves to undefined → null (REMOVE the attribute).
    expect((managersWrite![1] as { managers: string[] | null }).managers).toBeNull();
  });
});

describe("the managers list is bounded", () => {
  it("caps how many managers a resource can name", async () => {
    // Each id costs one membership read on the write path and is stored on the item,
    // so an unbounded list is unbounded work per request. Excess is dropped rather
    // than 400ing, since the rest of the edit is legitimate.
    caller = { userId: "alice", orgId: "org-A", role: "editor" }; // the creator
    const many = Array.from({ length: 500 }, (_, i) => `user-${i}`);
    const res = await req("PATCH", "/agents/agent-managed", { managers: many });
    expect(res.status).toBe(200);
    const calls = (updateAgent as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const write = calls.find((c) => c[1] && typeof c[1] === "object" && "managers" in (c[1] as object));
    const stored = (write![1] as { managers: string[] | null }).managers ?? [];
    expect(stored.length).toBe(50);
  });
});
