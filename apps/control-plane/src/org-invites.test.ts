/**
 * Invite lifecycle via an interactive (JWT) principal. The invite inbox is
 * JWT-only, so we exercise it with AUTH_DISABLED, which yields a `local-dev` JWT
 * principal whose email is `local-dev@example.com` - matching the requireAuth
 * bypass. This tests the real accept/decline/list logic (email matching →
 * membership creation → invite deletion) that the PAT path can't reach.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Membership, Org, Invite } from "@agency/shared";

// Force the local-dev auth bypass (JWT principal with a fixed email) regardless of
// env load order, by mocking config.ts's AUTH_DISABLED. Keep the other config
// values real (via importActual) so the app wires normally in local mode.
vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return { ...actual, AUTH_DISABLED: true };
});

const LOCAL_USER = "local-dev";
const LOCAL_EMAIL = "local-dev@example.com";

const orgs = new Map<string, Org>();
const memberships = new Map<string, Membership>();
const invites = new Map<string, Invite>();
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
  // Faithful fake of the transaction: the write lands ONLY while the witness is
  // still an admin (else DynamoDB cancels the transaction).
  // Faithful fake of the CONDITIONAL write: only sets `email`, only on a row that
  // still exists and has none. A whole-item Put here would hide the races below.
  // Faithful fake of the shared conditional write: never creates a row, and honours
  // the onlyIfAbsent guard. Both properties are what the races below assert.
  setMembershipEmail: vi.fn(async (o: string, u: string, email: string, when: string) => {
    const cur = memberships.get(mkey(o, u));
    if (!cur) return; // deleted - must NOT be recreated
    if (when === "onlyIfAbsent" && cur.email) return;
    memberships.set(mkey(o, u), { ...cur, email });
  }),
  backfillMembershipEmail: vi.fn(async (o: string, u: string, email: string) => {
    const cur = memberships.get(mkey(o, u));
    if (!cur || cur.email) return; // deleted, or the member self-healed first
    memberships.set(mkey(o, u), { ...cur, email });
  }),
  // Faithful fake of the guarded role UPDATE: only touches `role`, and only on a row
  // that still exists - so a concurrent removal wins instead of being undone.
  updateMembershipRole: vi.fn(async (o: string, u: string, role: Membership["role"]) => {
    const cur = memberships.get(mkey(o, u));
    if (!cur) return false; // removed under us - must NOT be recreated
    memberships.set(mkey(o, u), { ...cur, role });
    return true;
  }),
  demoteAdminIfWitnessRemains: vi.fn(
    async (o: string, target: Membership, change: "delete" | Membership, witness: string) => {
      if (memberships.get(mkey(o, witness))?.role !== "admin") {
        throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
      }
      if (change === "delete") memberships.delete(mkey(o, target.userId));
      // The real transaction guards the Put on attribute_exists(userId), so a
      // concurrently-removed target is not resurrected.
      else if (memberships.has(mkey(o, change.userId))) memberships.set(mkey(o, change.userId), change);
      else throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
    },
  ),
}));
const putToken = vi.fn(async (_r: unknown) => {});
vi.mock("./repo/tokens.js", () => ({
  // Keep the record: asserting only "a token was stored" can't see a handler that
  // stores scopes other than the ones requested.
  putToken: (r: unknown) => putToken(r),
  listTokensByOwner: vi.fn(async () => []),
  deleteTokenById: vi.fn(async () => false),
  getTokenByHash: vi.fn(async () => null),
  touchToken: vi.fn(async () => {}),
  toPublicToken: (r: Record<string, unknown>) => r,
}));
vi.mock("./repo/invites.js", () => ({
  putInvite: vi.fn(async (i: Invite) => void invites.set(ikey(i.email, i.orgId), i)),
  getInvite: vi.fn(async (e: string, o: string) => invites.get(ikey(e, o)) ?? null),
  listInvitesByEmail: vi.fn(async (e: string) => [...invites.values()].filter((i) => i.email === e.toLowerCase())),
  listInvitesByOrg: vi.fn(async (o: string) => [...invites.values()].filter((i) => i.orgId === o)),
  deleteInvite: vi.fn(async (e: string, o: string) => void invites.delete(ikey(e, o))),
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
}));

// Resource repos: in-memory, so the org-delete cascade AND the manager-grant
// revocation on member removal operate on real records. Empty by default.
type Res = { id: string; orgId: string; createdBy: string; shared: boolean; managers?: string[] };
const agents = new Map<string, Res>();
const skills = new Map<string, Res>();
const integrations = new Map<string, Res>();

vi.mock("./repo/agents.js", () => ({
  listAgentsByOrg: vi.fn(async (o: string) => [...agents.values()].filter((a) => a.orgId === o)),
  getAgent: vi.fn(async (id: string) => agents.get(id) ?? null),
  deleteAgent: vi.fn(async (id: string) => void agents.delete(id)),
  putAgent: vi.fn(async (a: Res) => void agents.set(a.id, a)),
  // Mirrors the real patch semantics for managers: array SETs, null REMOVEs.
  updateAgent: vi.fn(async (id: string, patch: { managers?: string[] | null }) => {
    const cur = agents.get(id);
    if (!cur) return;
    if (patch.managers === null) delete cur.managers;
    else if (patch.managers) cur.managers = patch.managers;
  }),
  toPublic: (r: Record<string, unknown>) => ({ ...r }),
  normalizeConfig: (c: Record<string, unknown>) => c,
  freshMetrics: () => ({ invocations: 0, lastInvokedAt: null }),
}));
vi.mock("./repo/skills.js", () => ({
  listSkills: vi.fn(async (o: string) => [...skills.values()].filter((s) => s.orgId === o)),
  putSkill: vi.fn(async (s: Res) => void skills.set(s.id, s)),
  deleteSkill: vi.fn(async (_o: string, id: string) => void skills.delete(id)),
}));
vi.mock("./repo/integrations.js", async () => {
  const actual = await vi.importActual<typeof import("./repo/integrations.js")>("./repo/integrations.js");
  return {
    ...actual,
    listIntegrations: vi.fn(async (o: string) => [...integrations.values()].filter((i) => i.orgId === o)),
    putIntegration: vi.fn(async (i: Res) => void integrations.set(i.id, i)),
    deleteIntegration: vi.fn(async (_o: string, id: string) => void integrations.delete(id)),
  };
});

import { buildApp } from "./app.js";
import type { Deps } from "./app.js";

const app = buildApp();

// A spy identity provider for the invite→login bridge test (the default app uses
// the local no-op provider; here we assert the route actually invokes ensureUser).
const ensureUser = vi.fn(async () => "created" as const);
const spyDeps: Deps = {
  scheduler: { reconcile: async () => {}, remove: async () => {} },
  invoker: { invoke: async () => ({ status: "triggered", sessionId: "s" }) },
  identity: { ensureUser, emailFor: async () => undefined },
};
const spyApp = buildApp(spyDeps);

// An app whose identity store knows emails, for the roster-backfill test below.
const emailFor = vi.fn(async (userId: string) =>
  userId === "never-signed-in" ? "colleague@example.com" : undefined,
);
const rosterApp = buildApp({
  scheduler: { reconcile: async () => {}, remove: async () => {} },
  invoker: { invoke: async () => ({ status: "triggered", sessionId: "s" }) },
  identity: { ensureUser, emailFor },
});
async function req(method: string, path: string, body?: unknown) {
  // No Authorization header needed: AUTH_DISABLED yields the local-dev principal.
  return app.request(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  orgs.clear();
  memberships.clear();
  invites.clear();
  agents.clear();
  skills.clear();
  integrations.clear();
  // A team org B (created by someone else) with a pending invite for local-dev.
  orgs.set("org-b", { orgId: "org-b", name: "B", kind: "team", createdBy: "zed", createdAt: "t" });
  invites.set(ikey(LOCAL_EMAIL, "org-b"), {
    email: LOCAL_EMAIL,
    orgId: "org-b",
    orgName: "B",
    role: "editor",
    invitedBy: "zed",
    createdAt: "t",
  });
});

describe("invite lifecycle (JWT principal)", () => {
  it("GET /invites lists the caller's invites by email", async () => {
    const res = await req("GET", "/invites");
    expect(res.status).toBe(200);
    const { invites: inv } = (await res.json()) as { invites: { orgId: string; role: string }[] };
    expect(inv.map((i) => i.orgId)).toEqual(["org-b"]);
  });

  it("accepting creates a membership with the invited role + email, and deletes the invite", async () => {
    const res = await req("POST", "/invites/org-b/accept");
    expect(res.status).toBe(200);
    const membership = memberships.get(mkey("org-b", LOCAL_USER));
    expect(membership?.role).toBe("editor");
    // The verified email is captured onto the membership (so the roster + managers
    // picker show a readable name, not the Cognito sub).
    expect(membership?.email).toBe(LOCAL_EMAIL);
    expect(invites.get(ikey(LOCAL_EMAIL, "org-b"))).toBeUndefined();
  });

  it("404s accepting an invite that isn't for the caller", async () => {
    const res = await req("POST", "/invites/org-nonexistent/accept");
    expect(res.status).toBe(404);
    expect(memberships.get(mkey("org-nonexistent", LOCAL_USER))).toBeUndefined();
  });

  it("declining deletes the invite without creating a membership", async () => {
    const res = await req("POST", "/invites/org-b/decline");
    expect(res.status).toBe(204);
    expect(invites.get(ikey(LOCAL_EMAIL, "org-b"))).toBeUndefined();
    expect(memberships.get(mkey("org-b", LOCAL_USER))).toBeUndefined();
  });
});

describe("org create + rename + delete (JWT admin)", () => {
  it("POST /orgs creates a team org with the caller as admin", async () => {
    const res = await req("POST", "/orgs", { name: "My Team" });
    expect(res.status).toBe(201);
    const { org } = (await res.json()) as { org: Org };
    expect(org.kind).toBe("team");
    expect(org.createdBy).toBe(LOCAL_USER);
    expect(memberships.get(mkey(org.orgId, LOCAL_USER))?.role).toBe("admin");
  });

  it("PATCH renames an org the caller admins", async () => {
    orgs.set("org-x", { orgId: "org-x", name: "Old", kind: "team", createdBy: LOCAL_USER, createdAt: "t" });
    memberships.set(mkey("org-x", LOCAL_USER), { orgId: "org-x", userId: LOCAL_USER, role: "admin", joinedAt: "t" });
    const res = await req("PATCH", "/orgs/org-x", { name: "New" });
    expect(res.status).toBe(200);
    expect(orgs.get("org-x")?.name).toBe("New");
  });

  it("refuses to delete a PERSONAL org", async () => {
    // local-dev's personal org id == userId.
    orgs.set(LOCAL_USER, { orgId: LOCAL_USER, name: "personal", kind: "personal", createdBy: LOCAL_USER, createdAt: "t" });
    memberships.set(mkey(LOCAL_USER, LOCAL_USER), { orgId: LOCAL_USER, userId: LOCAL_USER, role: "admin", joinedAt: "t" });
    const res = await req("DELETE", `/orgs/${LOCAL_USER}`);
    expect(res.status).toBe(400);
    expect(orgs.get(LOCAL_USER)).toBeDefined(); // not deleted
  });

  it("deletes a team org the caller admins (cascade)", async () => {
    orgs.set("org-x", { orgId: "org-x", name: "X", kind: "team", createdBy: LOCAL_USER, createdAt: "t" });
    memberships.set(mkey("org-x", LOCAL_USER), { orgId: "org-x", userId: LOCAL_USER, role: "admin", joinedAt: "t" });
    const res = await req("DELETE", "/orgs/org-x");
    expect(res.status).toBe(204);
    expect(orgs.get("org-x")).toBeUndefined();
    expect(memberships.get(mkey("org-x", LOCAL_USER))).toBeUndefined();
  });
});

describe("member role changes + last-admin invariant (JWT admin)", () => {
  beforeEach(() => {
    orgs.set("org-x", { orgId: "org-x", name: "X", kind: "team", createdBy: LOCAL_USER, createdAt: "t" });
    memberships.set(mkey("org-x", LOCAL_USER), { orgId: "org-x", userId: LOCAL_USER, role: "admin", joinedAt: "t" });
  });

  it("changes a member's role", async () => {
    memberships.set(mkey("org-x", "bob"), { orgId: "org-x", userId: "bob", role: "viewer", joinedAt: "t" });
    const res = await req("PATCH", "/orgs/org-x/members/bob", { role: "editor" });
    expect(res.status).toBe(200);
    expect(memberships.get(mkey("org-x", "bob"))?.role).toBe("editor");
  });

  it("refuses to demote the LAST admin", async () => {
    // local-dev is the only admin of org-x.
    const res = await req("PATCH", `/orgs/org-x/members/${LOCAL_USER}`, { role: "editor" });
    expect(res.status).toBe(400);
    expect(memberships.get(mkey("org-x", LOCAL_USER))?.role).toBe("admin"); // unchanged
  });

  it("refuses to remove the LAST admin", async () => {
    const res = await req("DELETE", `/orgs/org-x/members/${LOCAL_USER}`);
    expect(res.status).toBe(400);
    expect(memberships.get(mkey("org-x", LOCAL_USER))).toBeDefined();
  });

  it("allows demoting an admin when another admin remains", async () => {
    memberships.set(mkey("org-x", "carol"), { orgId: "org-x", userId: "carol", role: "admin", joinedAt: "t" });
    const res = await req("PATCH", `/orgs/org-x/members/${LOCAL_USER}`, { role: "editor" });
    expect(res.status).toBe(200);
    expect(memberships.get(mkey("org-x", LOCAL_USER))?.role).toBe("editor");
  });

  // The race the witness-conditional write exists to close: in a 2-admin org, two
  // requests demoting the two DIFFERENT admins each see "another admin remains".
  // A plain count-then-write lets both land and leaves ZERO admins - a state no
  // route can repair, since they all require an admin. The second write must lose.
  it("can't empty an org of admins when two concurrent demotes each see the other", async () => {
    memberships.set(mkey("org-x", "carol"), { orgId: "org-x", userId: "carol", role: "admin", joinedAt: "t" });
    // Both requests read the roster while both are still admins (the racing read),
    // then both attempt their write.
    const [a, b] = await Promise.all([
      req("PATCH", `/orgs/org-x/members/${LOCAL_USER}`, { role: "editor" }),
      req("PATCH", "/orgs/org-x/members/carol", { role: "editor" }),
    ]);
    const admins = [...memberships.values()].filter((m) => m.orgId === "org-x" && m.role === "admin");
    expect(admins).toHaveLength(1); // the invariant holds
    // One succeeded; the loser got a 409 telling it to reload (not a 500).
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  // A manager grant names a userId and nothing re-checks it against membership at
  // read time, so a grant left behind on removal is a latent write permission: the
  // user gets re-added later as a plain EDITOR and silently regains write on
  // resources nobody re-granted them.
  it("revokes a removed member's manager grants across agents, skills and integrations", async () => {
    memberships.set(mkey("org-x", "bob"), { orgId: "org-x", userId: "bob", role: "editor", joinedAt: "t" });
    const base = { orgId: "org-x", createdBy: LOCAL_USER, shared: true };
    agents.set("ag-1", { ...base, id: "ag-1", managers: ["bob", "carol"] });
    skills.set("sk-1", { ...base, id: "sk-1", managers: ["bob"] });
    integrations.set("in-1", { ...base, id: "in-1", managers: ["bob"] });
    agents.set("ag-2", { ...base, id: "ag-2", managers: ["carol"] }); // untouched

    const res = await req("DELETE", "/orgs/org-x/members/bob");
    expect(res.status).toBe(204);

    // bob's grants are gone everywhere...
    expect(agents.get("ag-1")!.managers).toEqual(["carol"]); // carol's survives
    // ...and a list emptied by the removal is stored as ABSENT, not [], so it reads
    // back as "creator + admins only" like a resource that never had managers.
    expect(skills.get("sk-1")!.managers).toBeUndefined();
    expect(integrations.get("in-1")!.managers).toBeUndefined();
    expect(agents.get("ag-2")!.managers).toEqual(["carol"]); // unrelated, unchanged
  });

  it("removing an admin also holds the invariant under the same race", async () => {
    memberships.set(mkey("org-x", "carol"), { orgId: "org-x", userId: "carol", role: "admin", joinedAt: "t" });
    const [a, b] = await Promise.all([
      req("DELETE", `/orgs/org-x/members/${LOCAL_USER}`),
      req("DELETE", "/orgs/org-x/members/carol"),
    ]);
    const admins = [...memberships.values()].filter((m) => m.orgId === "org-x" && m.role === "admin");
    expect(admins).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual([204, 409]);
  });
});

describe("invite creation (JWT admin)", () => {
  beforeEach(() => {
    orgs.set("org-x", { orgId: "org-x", name: "X", kind: "team", createdBy: LOCAL_USER, createdAt: "t" });
    memberships.set(mkey("org-x", LOCAL_USER), { orgId: "org-x", userId: LOCAL_USER, role: "admin", joinedAt: "t" });
  });

  it("creates a pending invite by email", async () => {
    const res = await req("POST", "/orgs/org-x/invites", { email: "New@Example.CO", role: "viewer" });
    expect(res.status).toBe(201);
    // Stored lowercased for the email key.
    expect(invites.get(ikey("new@example.co", "org-x"))?.role).toBe("viewer");
  });

  it("provisions a login for the invited email, without disclosing whether it existed", async () => {
    // The route bridges invite → Cognito: it must call identity.ensureUser with the
    // NORMALIZED email before writing the invite. (The default app uses the no-op
    // provider, so drive the spy app here.)
    const res = await spyApp.request("/orgs/org-x/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "New@Example.CO", role: "viewer" }),
    });
    expect(res.status).toBe(201);
    expect(ensureUser).toHaveBeenCalledWith("new@example.co");
    // The "created" vs "exists" outcome is deliberately NOT on the wire: it's a Cognito
    // user-existence oracle on a caller-chosen email, and nothing consumed it.
    expect(await res.json()).not.toHaveProperty("identity");
  });

  it("400s an invalid email or role", async () => {
    expect((await req("POST", "/orgs/org-x/invites", { email: "nope", role: "viewer" })).status).toBe(400);
    expect((await req("POST", "/orgs/org-x/invites", { email: "a@b.co", role: "boss" })).status).toBe(400);
  });

  it("409s inviting an email that is ALREADY a member (an invite must not become a role change)", async () => {
    // Regression: accept() overwrites the membership role, so allowing an invite for
    // a sitting member let an admin demote them - including demoting the LAST admin,
    // routing around the last-admin guard on PATCH /orgs/:id/members/:userId.
    memberships.set(mkey("org-x", "user-b"), {
      orgId: "org-x", userId: "user-b", role: "admin", joinedAt: "t", email: "bee@example.co",
    });
    const res = await req("POST", "/orgs/org-x/invites", { email: "Bee@Example.CO", role: "viewer" });
    expect(res.status).toBe(409);
    // And no invite row was written.
    expect(invites.get(ikey("bee@example.co", "org-x"))).toBeUndefined();
  });

  it("accepting an invite never overwrites an existing membership's role (keeps the sitting role)", async () => {
    // Defense-in-depth for an invite that pre-dates a membership: accept must not
    // demote the caller; it keeps the existing role and clears the stale invite.
    memberships.set(mkey("org-y", LOCAL_USER), {
      orgId: "org-y", userId: LOCAL_USER, role: "admin", joinedAt: "t", email: LOCAL_EMAIL,
    });
    orgs.set("org-y", { orgId: "org-y", name: "Y", kind: "team", createdBy: "zed", createdAt: "t" });
    invites.set(ikey(LOCAL_EMAIL, "org-y"), {
      email: LOCAL_EMAIL, orgId: "org-y", orgName: "Y", role: "viewer", invitedBy: "zed", createdAt: "t",
    });
    const res = await req("POST", "/invites/org-y/accept");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("admin"); // NOT demoted to viewer
    expect(memberships.get(mkey("org-y", LOCAL_USER))?.role).toBe("admin");
    expect(invites.get(ikey(LOCAL_EMAIL, "org-y"))).toBeUndefined(); // stale invite cleared
  });

  it("404s inviting to an org the caller doesn't admin", async () => {
    const res = await req("POST", "/orgs/org-unknown/invites", { email: "a@b.co", role: "viewer" });
    expect(res.status).toBe(404);
  });
});

// A PAT's scopes are intersected with the owner's role on every request, so a token
// stamped beyond the minter's role is already inert. Validating at MINT closes the
// dormant case: a viewer could mint a `delete` token, and an admin promoting them to
// editor would silently arm that existing token string - no re-mint, no re-consent.
describe("POST /tokens can't stamp a scope the minter's role lacks", () => {
  const mint = (scopes: string[]) => req("POST", "/tokens", { name: "t", scopes });

  it("403s a viewer asking for write or delete, and stores nothing", async () => {
    memberships.set(mkey(LOCAL_USER, LOCAL_USER), { orgId: LOCAL_USER, userId: LOCAL_USER, role: "viewer", joinedAt: "t" });
    for (const scopes of [["delete"], ["read", "write"], ["read", "write", "delete"]]) {
      const res = await mint(scopes);
      expect(res.status, scopes.join("+")).toBe(403);
      expect((await res.json() as { error: string }).error).toMatch(/viewer/);
    }
    expect(putToken).not.toHaveBeenCalled();
  });

  it("400s an unknown scope, and a missing/empty scope list", async () => {
    memberships.set(mkey(LOCAL_USER, LOCAL_USER), { orgId: LOCAL_USER, userId: LOCAL_USER, role: "admin", joinedAt: "t" });
    // Same handler as the gate, one line above it - and previously untested.
    expect((await mint(["nope"])).status).toBe(400);
    expect((await mint([])).status).toBe(400);
    expect(putToken).not.toHaveBeenCalled();
  });

  it("lets a viewer mint a read-only token, storing exactly that", async () => {
    memberships.set(mkey(LOCAL_USER, LOCAL_USER), { orgId: LOCAL_USER, userId: LOCAL_USER, role: "viewer", joinedAt: "t" });
    expect((await mint(["read"])).status).toBe(201);
    // Assert what was STORED: a handler that over-grants on the way to DynamoDB
    // would otherwise pass, since the response only echoes metadata.
    expect((putToken.mock.calls[0]![0] as { scopes: string[] }).scopes).toEqual(["read"]);
  });

  it("lets an admin mint the full set, delete included", async () => {
    memberships.set(mkey(LOCAL_USER, LOCAL_USER), { orgId: LOCAL_USER, userId: LOCAL_USER, role: "admin", joinedAt: "t" });
    expect((await mint(["read", "write", "delete"])).status).toBe(201);
    expect((putToken.mock.calls[0]![0] as { scopes: string[] }).scopes).toEqual(["read", "write", "delete"]);
  });

  it("lets an EDITOR mint delete too - editor and admin share a scope set", async () => {
    // The role difference is per-resource (canWrite), not per-scope, so gating an
    // editor as if they were a viewer would be wrong - and previously invisible.
    memberships.set(mkey(LOCAL_USER, LOCAL_USER), { orgId: LOCAL_USER, userId: LOCAL_USER, role: "editor", joinedAt: "t" });
    expect((await mint(["read", "write", "delete"])).status).toBe(201);
  });

  it("de-dupes a repeated scope in the stored record", async () => {
    memberships.set(mkey(LOCAL_USER, LOCAL_USER), { orgId: LOCAL_USER, userId: LOCAL_USER, role: "admin", joinedAt: "t" });
    expect((await mint(["read", "read", "write"])).status).toBe(201);
    expect((putToken.mock.calls[0]![0] as { scopes: string[] }).scopes).toEqual(["read", "write"]);
  });
});

/**
 * A membership row caches the member's email; a member who has never signed in has
 * none, so the roster resolves it from the identity store and persists it - one lookup
 * per member once it resolves (an unresolved one caches nothing and is re-asked).
 */
describe("GET /orgs/:id/members resolves + persists a missing email", () => {
  beforeEach(() => {
    orgs.set("org-x", { orgId: "org-x", name: "X", kind: "team", createdBy: LOCAL_USER, createdAt: "t" });
    memberships.set(mkey("org-x", LOCAL_USER), { orgId: "org-x", userId: LOCAL_USER, role: "admin", joinedAt: "t", email: LOCAL_EMAIL });
    // A member with NO cached email - the case that rendered as a raw sub.
    memberships.set(mkey("org-x", "never-signed-in"), { orgId: "org-x", userId: "never-signed-in", role: "editor", joinedAt: "t" });
  });

  const roster = async () => {
    const res = await rosterApp.request("/orgs/org-x/members");
    return (await res.json()) as { members: { userId: string; email?: string }[] };
  };

  it("fills the gap from the identity store", async () => {
    const { members } = await roster();
    const m = members.find((x) => x.userId === "never-signed-in")!;
    expect(m.email).toBe("colleague@example.com");
    expect(emailFor).toHaveBeenCalledWith("never-signed-in");
  });

  it("writes it back, so the next read needs no lookup", async () => {
    await roster();
    // Persisted on the membership row...
    expect(memberships.get(mkey("org-x", "never-signed-in"))?.email).toBe("colleague@example.com");
    // ...so a second read serves it from the row and never asks Cognito again.
    emailFor.mockClear();
    const { members } = await roster();
    expect(members.find((x) => x.userId === "never-signed-in")?.email).toBe("colleague@example.com");
    expect(emailFor).not.toHaveBeenCalled();
  });

  it("never asks for a member whose email is already cached", async () => {
    await roster();
    expect(emailFor).not.toHaveBeenCalledWith(LOCAL_USER);
  });

  it("falls back to the userId when the identity store doesn't know either", async () => {
    memberships.set(mkey("org-x", "ghost"), { orgId: "org-x", userId: "ghost", role: "viewer", joinedAt: "t" });
    const { members } = await roster();
    const g = members.find((x) => x.userId === "ghost")!;
    expect(g.email).toBeUndefined(); // the UI renders the userId - no crash, no blank
  });
});

/**
 * The roster resolves a missing email over a SLOW network call, then caches it. The
 * write must therefore touch only `email` on a row that still exists - anything wider
 * reverts whatever an admin changed during the lookup. This is the authority-source
 * table: `role` gates every request and removal is promised to be immediate, so a
 * cosmetic label must never write either.
 */
describe("the email backfill can't clobber a concurrent admin action", () => {
  /** Resolves only once `release()` is called, so we can interleave precisely. */
  function gated() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const emailFor = vi.fn(async (userId: string) => {
      await gate;
      return userId === "bob" ? "bob@example.com" : undefined;
    });
    return { emailFor, release };
  }

  const build = (emailFor: (u: string) => Promise<string | undefined>) =>
    buildApp({
      scheduler: { reconcile: async () => {}, remove: async () => {} },
      invoker: { invoke: async () => ({ status: "triggered", sessionId: "s" }) },
      identity: { ensureUser, emailFor },
    });

  beforeEach(() => {
    orgs.set("org-x", { orgId: "org-x", name: "X", kind: "team", createdBy: LOCAL_USER, createdAt: "t" });
    memberships.set(mkey("org-x", LOCAL_USER), { orgId: "org-x", userId: LOCAL_USER, role: "admin", joinedAt: "t", email: LOCAL_EMAIL });
    memberships.set(mkey("org-x", "bob"), { orgId: "org-x", userId: "bob", role: "viewer", joinedAt: "t" });
  });

  it("does not revert a role change that landed mid-lookup", async () => {
    const { emailFor, release } = gated();
    const app = build(emailFor);
    const roster = app.request("/orgs/org-x/members"); // blocks inside emailFor
    await req("PATCH", "/orgs/org-x/members/bob", { role: "editor" }); // admin promotes
    release();
    await roster;
    // The promotion survives, and the email still lands.
    expect(memberships.get(mkey("org-x", "bob"))?.role).toBe("editor");
    expect(memberships.get(mkey("org-x", "bob"))?.email).toBe("bob@example.com");
  });

  it("does not resurrect a membership removed mid-lookup", async () => {
    const { emailFor, release } = gated();
    const app = build(emailFor);
    const roster = app.request("/orgs/org-x/members");
    expect((await req("DELETE", "/orgs/org-x/members/bob")).status).toBe(204);
    release();
    await roster;
    // Removal is immediate and permanent - a cosmetic backfill must not undo it,
    // which would restore the removed member's access.
    expect(memberships.get(mkey("org-x", "bob"))).toBeUndefined();
  });

  it("a role PATCH does not resurrect a member removed concurrently", async () => {
    // The role write used to be a read-modify-write with an unconditional whole-item
    // Put, so a DELETE landing between the read and the write was UNDONE - the removed
    // member came back at the role being set. A promotion restored them as an ADMIN,
    // and their PATs bound to this org started authenticating again.
    memberships.delete(mkey("org-x", "bob")); // the concurrent removal already landed
    const res = await req("PATCH", "/orgs/org-x/members/bob", { role: "admin" });
    expect(res.status).toBe(404);
    expect(memberships.get(mkey("org-x", "bob"))).toBeUndefined();
  });

  it("a DEMOTION does not resurrect a member removed concurrently either", async () => {
    // The last-admin path writes through the witness transaction, which guarded only
    // the witness - never that the target still existed.
    memberships.set(mkey("org-x", "carol"), { orgId: "org-x", userId: "carol", role: "admin", joinedAt: "t" });
    memberships.delete(mkey("org-x", "carol"));
    const res = await req("PATCH", "/orgs/org-x/members/carol", { role: "viewer" });
    expect(res.status).toBe(404);
    expect(memberships.get(mkey("org-x", "carol"))).toBeUndefined();
  });

  it("survives a backfill WRITE failure without an unhandled rejection", async () => {
    // The write is fire-and-forget, so a throttled/5xx memberships table rejects a
    // floating promise - which on Node 22 Lambda kills the execution environment
    // AFTER the response, surfacing as a 502 on someone else's next request.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const mod = await import("./repo/memberships.js");
      vi.spyOn(mod, "backfillMembershipEmail").mockRejectedValueOnce(
        Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }),
      );
      const app = build(async (u: string) => (u === "bob" ? "bob@example.com" : undefined));
      expect((await app.request("/orgs/org-x/members")).status).toBe(200);
      await new Promise((r) => setTimeout(r, 20)); // let the floating promise settle
      expect(unhandled).toEqual([]);
      expect(spy).toHaveBeenCalled(); // and it's logged, not silently dropped
    } finally {
      process.off("unhandledRejection", onUnhandled);
      spy.mockRestore();
    }
  });

  it("still 200s (email absent) when the identity store REJECTS", async () => {
    // A label is cosmetic: one unresolvable member must not fail the whole roster.
    const app = build(async () => {
      throw new Error("cognito throttled");
    });
    const res = await app.request("/orgs/org-x/members");
    expect(res.status).toBe(200);
    const { members } = (await res.json()) as { members: { userId: string; email?: string }[] };
    expect(members.find((m) => m.userId === "bob")?.email).toBeUndefined();
  });

  it("resolves SEVERAL missing emails in one read, and keeps them apart", async () => {
    memberships.set(mkey("org-x", "carol"), { orgId: "org-x", userId: "carol", role: "editor", joinedAt: "t" });
    const emailFor = vi.fn(async (u: string) => (u === "bob" ? "bob@x.co" : u === "carol" ? "carol@x.co" : undefined));
    const res = await build(emailFor).request("/orgs/org-x/members");
    const { members } = (await res.json()) as { members: { userId: string; email?: string; role: string }[] };
    expect(members.find((m) => m.userId === "bob")?.email).toBe("bob@x.co");
    expect(members.find((m) => m.userId === "carol")?.email).toBe("carol@x.co");
    // The rest of the projection must survive the added email resolution.
    expect(members.find((m) => m.userId === "bob")?.role).toBe("viewer");
    expect(members.find((m) => m.userId === "carol")?.role).toBe("editor");
  });
});

/**
 * The email SELF-HEAL (auth.ts, on every authenticated request) had the same shape the
 * roster backfill was just fixed for: a whole-item Put of the row it read a moment
 * earlier. Its window is much shorter - no network call inside it - but not zero, and
 * this is the table where `role` gates every request and removal is immediate.
 */
describe("the email self-heal can't resurrect a removed membership", () => {
  it("does not recreate the caller's own row after a concurrent removal", async () => {
    const { setMembershipEmail } = await import("./repo/memberships.js");
    // The row is gone (an admin just removed them); the self-heal fires with a
    // freshly-learned email. It must be a no-op, not a resurrection.
    memberships.delete(mkey("org-gone", "bob"));
    await setMembershipEmail("org-gone", "bob", "bob@example.com", "always");
    expect(memberships.get(mkey("org-gone", "bob"))).toBeUndefined();
  });

  it("DOES correct a stale email on a row that still exists", async () => {
    // The point of the self-heal - `always` must overwrite, unlike the roster backfill.
    const { setMembershipEmail } = await import("./repo/memberships.js");
    memberships.set(mkey("org-x", "bob"), { orgId: "org-x", userId: "bob", role: "editor", joinedAt: "t", email: "old@example.com" });
    await setMembershipEmail("org-x", "bob", "new@example.com", "always");
    expect(memberships.get(mkey("org-x", "bob"))?.email).toBe("new@example.com");
  });

  it("the roster backfill defers to an email the member already self-healed", async () => {
    const { setMembershipEmail } = await import("./repo/memberships.js");
    memberships.set(mkey("org-x", "bob"), { orgId: "org-x", userId: "bob", role: "editor", joinedAt: "t", email: "verified@example.com" });
    await setMembershipEmail("org-x", "bob", "stale@example.com", "onlyIfAbsent");
    // The member's own verified claim is the more authoritative source.
    expect(memberships.get(mkey("org-x", "bob"))?.email).toBe("verified@example.com");
  });
});
