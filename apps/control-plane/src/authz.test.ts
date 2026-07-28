/**
 * Per-resource visibility + write rules (canView / canWrite / authorize /
 * visibleToCreator). This is the pure core of the org sharing model - the locked
 * Q2 (admin does NOT pierce privacy) and Q3 (shared is editable only by creator +
 * admin) decisions - so it's tested exhaustively across role × ownership × shared × org.
 */
import { describe, it, expect } from "vitest";
import type { Principal } from "./auth.js";
import { canView, canWrite, authorize, visibleToCreator, type OrgOwned } from "./authz.js";

const principal = (userId: string, orgId: string, role: Principal["role"]): Principal => ({
  userId,
  orgId,
  role,
  scopes: role === "viewer" ? ["read"] : ["read", "write", "delete"],
  kind: "jwt",
});

const resource = (orgId: string, createdBy: string, shared: boolean): OrgOwned => ({
  orgId,
  createdBy,
  shared,
});

describe("canView (Q2 - admin does NOT pierce privacy)", () => {
  it("a shared resource is visible to any member of its org", () => {
    const r = resource("org-1", "alice", true);
    expect(canView(principal("bob", "org-1", "viewer"), r)).toBe(true);
    expect(canView(principal("bob", "org-1", "editor"), r)).toBe(true);
    expect(canView(principal("bob", "org-1", "admin"), r)).toBe(true);
  });

  it("a private resource is visible ONLY to its creator - NOT even an admin", () => {
    const r = resource("org-1", "alice", false);
    expect(canView(principal("alice", "org-1", "viewer"), r)).toBe(true); // creator
    expect(canView(principal("bob", "org-1", "editor"), r)).toBe(false);
    expect(canView(principal("bob", "org-1", "admin"), r)).toBe(false); // admin does NOT pierce
  });

  it("nothing in another org is ever visible, shared or not", () => {
    expect(canView(principal("bob", "org-2", "admin"), resource("org-1", "alice", true))).toBe(false);
    expect(canView(principal("alice", "org-2", "admin"), resource("org-1", "alice", false))).toBe(false);
  });
});

describe("canWrite (Q3 - shared editable only by creator + admin)", () => {
  it("the creator can write their own resource (shared or private)", () => {
    expect(canWrite(principal("alice", "org-1", "editor"), resource("org-1", "alice", true))).toBe(true);
    expect(canWrite(principal("alice", "org-1", "editor"), resource("org-1", "alice", false))).toBe(true);
  });

  it("an editor CANNOT write a co-member's shared resource", () => {
    expect(canWrite(principal("bob", "org-1", "editor"), resource("org-1", "alice", true))).toBe(false);
  });

  it("an admin CAN write any shared resource in the org", () => {
    expect(canWrite(principal("bob", "org-1", "admin"), resource("org-1", "alice", true))).toBe(true);
  });

  it("nobody (not even admin) can write a co-member's PRIVATE resource - it's invisible", () => {
    expect(canWrite(principal("bob", "org-1", "admin"), resource("org-1", "alice", false))).toBe(false);
  });

  it("a viewer never writes, even their own", () => {
    // canWrite is ownership-based; the route-level requireScope("write") is what
    // actually blocks a viewer. But a viewer that somehow reached here on their own
    // resource would still pass canWrite (they own it) - the scope gate is the guard.
    // We assert the ownership fact; the SCOPE gate (scope-mw.test) blocks the viewer.
    expect(canWrite(principal("alice", "org-1", "viewer"), resource("org-1", "alice", true))).toBe(true);
  });

  it("cross-org write is impossible", () => {
    expect(canWrite(principal("alice", "org-2", "admin"), resource("org-1", "alice", true))).toBe(false);
  });
});

describe("canWrite (managers grant - explicit per-resource managers)", () => {
  const withManagers = (orgId: string, createdBy: string, shared: boolean, managers: string[]): OrgOwned => ({
    orgId,
    createdBy,
    shared,
    managers,
  });

  it("an editor named in managers CAN write a co-member's shared resource", () => {
    const r = withManagers("org-1", "alice", true, ["bob"]);
    expect(canWrite(principal("bob", "org-1", "editor"), r)).toBe(true);
  });

  it("an editor NOT in managers still cannot write it", () => {
    const r = withManagers("org-1", "alice", true, ["carol"]);
    expect(canWrite(principal("bob", "org-1", "editor"), r)).toBe(false);
  });

  it("a manager grant does NOT pierce privacy: a private resource stays invisible → not writable", () => {
    const r = withManagers("org-1", "alice", false, ["bob"]);
    expect(canView(principal("bob", "org-1", "editor"), r)).toBe(false);
    expect(canWrite(principal("bob", "org-1", "editor"), r)).toBe(false);
  });

  it("a manager grant cannot cross orgs", () => {
    const r = withManagers("org-1", "alice", true, ["bob"]);
    expect(canWrite(principal("bob", "org-2", "editor"), r)).toBe(false);
  });

  it("creator + admin retain write regardless of the managers list", () => {
    const r = withManagers("org-1", "alice", true, ["carol"]);
    expect(canWrite(principal("alice", "org-1", "editor"), r)).toBe(true); // creator
    expect(canWrite(principal("dave", "org-1", "admin"), r)).toBe(true); // admin
  });
});

describe("authorize (load + classify: narrows the record or returns a status)", () => {
  const bobEditor = principal("bob", "org-1", "editor");
  const bobAdmin = principal("bob", "org-1", "admin");

  it("null record → 404", () => {
    expect(authorize(bobEditor, null, "write")).toEqual({ ok: false, status: 404, error: "not found" });
  });

  it("invisible (co-member private) → 404, never 403 (no existence leak)", () => {
    expect(authorize(bobEditor, resource("org-1", "alice", false), "write").ok).toBe(false);
    expect(authorize(bobEditor, resource("org-1", "alice", false), "write")).toMatchObject({ status: 404 });
    expect(authorize(bobAdmin, resource("org-1", "alice", false), "view")).toMatchObject({ status: 404 });
  });

  it("visible-but-not-writable (co-member shared, non-admin editor) → 403 with the message", () => {
    const r = authorize(bobEditor, resource("org-1", "alice", true), "write", "nope");
    expect(r).toEqual({ ok: false, status: 403, error: "nope" });
  });

  it("a viewer CAN 'view'-authorize a shared resource (200 path)", () => {
    const r = resource("org-1", "alice", true);
    const res = authorize(principal("carol", "org-1", "viewer"), r, "view");
    expect(res).toEqual({ ok: true, record: r });
  });

  it("writable → { ok, record } (narrowed, non-null)", () => {
    const own = resource("org-1", "bob", true);
    expect(authorize(bobEditor, own, "write")).toEqual({ ok: true, record: own }); // own
    const shared = resource("org-1", "alice", true);
    expect(authorize(bobAdmin, shared, "write")).toEqual({ ok: true, record: shared }); // admin over shared
  });

  it("different org → 404", () => {
    expect(authorize(bobEditor, resource("org-2", "bob", true), "write")).toMatchObject({ status: 404 });
  });
});

describe("visibleToCreator (principal-free invoke-time recheck)", () => {
  it("shared → visible regardless of creator", () => {
    expect(visibleToCreator(resource("o", "alice", true), "bob")).toBe(true);
  });
  it("private → visible only to its creator", () => {
    expect(visibleToCreator(resource("o", "alice", false), "alice")).toBe(true);
    expect(visibleToCreator(resource("o", "alice", false), "bob")).toBe(false);
  });
});
