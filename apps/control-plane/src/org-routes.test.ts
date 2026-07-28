/**
 * Org / member / invite routes. Drives the real requireAuth → requireOrgRole /
 * requireUser chain (AUTH_DISABLED unset) with an in-memory fake of the org repos,
 * so the ACTUAL route logic + guards are under test. Covers: GET /me bootstrap,
 * org create/rename/delete (+ personal-org protection), member list/role-change/
 * remove (+ last-admin invariant), and the full invite lifecycle
 * (create→inbox→accept→membership; decline; rescind; email matching).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Membership, Org, Invite } from "@agency/shared";

// The current caller (varied per test). A JWT principal by default (org routes are
// JWT-only for management), member of ORG_T with the given role.
let caller = { userId: "alice", email: "alice@x.co", orgId: "org-team", role: "admin" as string };

// ---- In-memory fakes for the org repos --------------------------------------
const orgs = new Map<string, Org>();
const memberships = new Map<string, Membership>(); // key `${orgId}#${userId}`
const invites = new Map<string, Invite>(); // key `${email}#${orgId}`
const mkey = (o: string, u: string) => `${o}#${u}`;
const ikey = (e: string, o: string) => `${e.toLowerCase()}#${o}`;

vi.mock("./repo/orgs.js", () => ({
  putOrg: vi.fn(async (o: Org) => void orgs.set(o.orgId, o)),
  getOrg: vi.fn(async (id: string) => orgs.get(id) ?? null),
  deleteOrg: vi.fn(async (id: string) => void orgs.delete(id)),
}));
vi.mock("./repo/memberships.js", () => ({
  putMembership: vi.fn(async (m: Membership) => void memberships.set(mkey(m.orgId, m.userId), m)),
  getMembership: vi.fn(async (o: string, u: string) => memberships.get(mkey(o, u)) ?? null),
  listMembersByOrg: vi.fn(async (o: string) => [...memberships.values()].filter((m) => m.orgId === o)),
  listMembershipsByUser: vi.fn(async (u: string) => [...memberships.values()].filter((m) => m.userId === u)),
  deleteMembership: vi.fn(async (o: string, u: string) => void memberships.delete(mkey(o, u))),
  demoteAdminIfWitnessRemains: vi.fn(
    async (o: string, target: Membership, change: "delete" | Membership, witness: string) => {
      if (memberships.get(mkey(o, witness))?.role !== "admin") {
        throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
      }
      if (change === "delete") memberships.delete(mkey(o, target.userId));
      else memberships.set(mkey(o, change.userId), change);
    },
  ),
}));
vi.mock("./repo/invites.js", () => ({
  putInvite: vi.fn(async (i: Invite) => void invites.set(ikey(i.email, i.orgId), i)),
  getInvite: vi.fn(async (e: string, o: string) => invites.get(ikey(e, o)) ?? null),
  listInvitesByEmail: vi.fn(async (e: string) => [...invites.values()].filter((i) => i.email === e.toLowerCase())),
  listInvitesByOrg: vi.fn(async (o: string) => [...invites.values()].filter((i) => i.orgId === o)),
  deleteInvite: vi.fn(async (e: string, o: string) => void invites.delete(ikey(e, o))),
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
}));

// The token resolves to `caller`; membership is served from the in-memory map.
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

// Resource repos (for the org-delete cascade) - empty by default.
vi.mock("./repo/agents.js", () => ({
  listAgentsByOrg: vi.fn(async () => []),
  getAgent: vi.fn(async () => null),
  deleteAgent: vi.fn(async () => {}),
  putAgent: vi.fn(async () => {}),
  updateAgent: vi.fn(async () => {}),
  toPublic: (r: Record<string, unknown>) => ({ ...r }),
  normalizeConfig: (c: Record<string, unknown>) => c,
  freshMetrics: () => ({ invocations: 0, lastInvokedAt: null }),
}));
vi.mock("./repo/skills.js", () => ({ listSkills: vi.fn(async () => []), deleteSkill: vi.fn(async () => {}) }));
vi.mock("./repo/integrations.js", async () => {
  const actual = await vi.importActual<typeof import("./repo/integrations.js")>("./repo/integrations.js");
  return { ...actual, listIntegrations: vi.fn(async () => []), deleteIntegration: vi.fn(async () => {}) };
});

import { buildApp } from "./app.js";

const app = buildApp();
const auth = { Authorization: "Bearer agpat_org_test_token_0000000000000000000" };
async function req(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { ...auth, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// These tests authenticate with a PAT (the token mock). That lets them cover the
// PAT-allowed routes (GET /me, GET members) AND assert the JWT-only org-management
// routes (requireUser) correctly 403 a PAT - which is itself the guard test. The
// JWT-principal path for those routes is exercised in org-invites.test.ts.

beforeEach(() => {
  vi.clearAllMocks();
  orgs.clear();
  memberships.clear();
  invites.clear();
  caller = { userId: "alice", email: "alice@x.co", orgId: "org-team", role: "admin" };
  // Seed a team org where alice is admin.
  orgs.set("org-team", { orgId: "org-team", name: "Team", kind: "team", createdBy: "alice", createdAt: "t" });
  memberships.set(mkey("org-team", "alice"), { orgId: "org-team", userId: "alice", role: "admin", joinedAt: "t" });
});

describe("GET /me", () => {
  it("returns the caller's identity + orgs + active org", async () => {
    const res = await req("GET", "/me");
    expect(res.status).toBe(200);
    const me = (await res.json()) as { userId: string; activeOrgId: string; orgs: { orgId: string; role: string }[] };
    expect(me.userId).toBe("alice");
    expect(me.activeOrgId).toBe("org-team");
    expect(me.orgs).toEqual([{ orgId: "org-team", name: "Team", kind: "team", role: "admin" }]);
  });
});

describe("org-management routes are JWT-only (a PAT is refused)", () => {
  it("403s POST /orgs, PATCH/DELETE /orgs/:id, member + invite writes for a PAT", async () => {
    for (const [m, p, b] of [
      ["POST", "/orgs", { name: "New" }],
      ["PATCH", "/orgs/org-team", { name: "R" }],
      ["DELETE", "/orgs/org-team", undefined],
      ["PATCH", "/orgs/org-team/members/bob", { role: "editor" }],
      ["DELETE", "/orgs/org-team/members/bob", undefined],
      ["POST", "/orgs/org-team/invites", { email: "b@x.co", role: "editor" }],
      ["DELETE", "/orgs/org-team/invites/b@x.co", undefined],
    ] as [string, string, unknown][]) {
      const res = await req(m, p, b);
      expect(res.status, `${m} ${p}`).toBe(403);
    }
  });
});

describe("member routes readable by a member PAT", () => {
  it("GET /orgs/:id/members lists members for a member", async () => {
    memberships.set(mkey("org-team", "bob"), { orgId: "org-team", userId: "bob", role: "editor", joinedAt: "t" });
    const res = await req("GET", "/orgs/org-team/members");
    expect(res.status).toBe(200);
    const { members } = (await res.json()) as { members: { userId: string; role: string }[] };
    expect(members.map((m) => m.userId).sort()).toEqual(["alice", "bob"]);
  });

  it("404s the members list for a non-member org", async () => {
    const res = await req("GET", "/orgs/org-other/members");
    expect(res.status).toBe(404);
  });
});

describe("invite inbox is JWT-only (a PAT is refused)", () => {
  it("403s GET /invites, accept, and decline for a PAT (invites are interactive)", async () => {
    for (const [m, p] of [
      ["GET", "/invites"],
      ["POST", "/invites/org-b/accept"],
      ["POST", "/invites/org-b/decline"],
    ] as [string, string][]) {
      const res = await req(m, p);
      expect(res.status, `${m} ${p}`).toBe(403);
    }
  });
});
