/**
 * Role model + role→scope derivation. This is the pure core of the org authority
 * rework: a principal's effective resource-scopes come from its role (§4.3 of the
 * org design), so getting this right is the foundation the `hasScope` change and
 * the whole route×role matrix rest on.
 */
import { describe, it, expect } from "vitest";
import { ROLES, ALL_ROLES, isRole, scopesForRole, type Role } from "./org.js";
import { ALL_SCOPES } from "./scopes.js";

describe("roles", () => {
  it("has exactly admin/editor/viewer", () => {
    expect(ALL_ROLES.sort()).toEqual(["admin", "editor", "viewer"]);
  });

  it("every role has a human description", () => {
    for (const r of ALL_ROLES) expect(ROLES[r].length).toBeGreaterThan(0);
  });

  it("isRole accepts known roles and rejects everything else", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("editor")).toBe(true);
    expect(isRole("viewer")).toBe(true);
    expect(isRole("owner")).toBe(false); // not one of ours
    expect(isRole("")).toBe(false);
    expect(isRole("toString")).toBe(false); // prototype-chain guard (hasOwnProperty)
    expect(isRole("__proto__")).toBe(false);
  });
});

describe("scopesForRole", () => {
  it("viewer → read only (strictly read-only)", () => {
    expect(scopesForRole("viewer")).toEqual(["read"]);
  });

  it("editor → read + write + delete", () => {
    expect(scopesForRole("editor").sort()).toEqual(["delete", "read", "write"]);
  });

  it("admin → read + write + delete (extra powers are role-gated, not scoped)", () => {
    expect(scopesForRole("admin").sort()).toEqual(["delete", "read", "write"]);
  });

  it("fails CLOSED on a role outside the union (a legacy/corrupt DB row)", () => {
    // `role` is cast off a DynamoDB row, not validated, so data can carry a string
    // no Role case handles. Returning undefined there put undefined in principal.scopes
    // and crashed hasScope with a 500; [] means every guarded route 403s instead.
    expect(scopesForRole("member" as Role)).toEqual([]);
    expect(scopesForRole("owner" as Role)).toEqual([]);
    expect(scopesForRole("" as Role)).toEqual([]);
    expect(scopesForRole(undefined as unknown as Role)).toEqual([]);
  });

  it("never yields a scope outside ALL_SCOPES", () => {
    for (const r of ALL_ROLES) {
      for (const s of scopesForRole(r)) expect(ALL_SCOPES).toContain(s);
    }
  });

  it("viewer cannot write or delete; editor/admin can", () => {
    const can = (role: Role, scope: string) => scopesForRole(role).includes(scope as never);
    expect(can("viewer", "write")).toBe(false);
    expect(can("viewer", "delete")).toBe(false);
    expect(can("editor", "write")).toBe(true);
    expect(can("editor", "delete")).toBe(true);
    expect(can("admin", "write")).toBe(true);
    expect(can("admin", "delete")).toBe(true);
  });
});
