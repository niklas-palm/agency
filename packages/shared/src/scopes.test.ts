/**
 * The scope CATALOG's own invariants. `scopesForRole` is tested in org.test.ts and
 * `isScope` in the control-plane's token.test.ts, beside the code they belong to -
 * this file covers only what scopes.ts itself owns, which had no tests.
 */
import { describe, it, expect } from "vitest";
import { SCOPES, ALL_SCOPES, DEFAULT_SCOPES, ALL_ROLES, scopesForRole } from "./index.js";

describe("scope catalog", () => {
  it("is exactly the three destructiveness tiers", () => {
    // Resource-neutral TIERS, not per-resource scopes. Adding a fourth is a design
    // decision (and a bigger PAT picker), so it should break this test on purpose.
    expect([...ALL_SCOPES].sort()).toEqual(["delete", "read", "write"]);
  });

  it("describes each tier as spanning all three resources", () => {
    // Each scope covers agents + skills + integrations, so no description needs a
    // per-resource carve-out to be true - and these strings are exactly what the PAT
    // picker shows whoever grants the token.
    for (const scope of ALL_SCOPES) {
      expect(SCOPES[scope], scope).toMatch(/agents, skills, and integrations/);
    }
  });
});

describe("DEFAULT_SCOPES (what a freshly minted PAT carries)", () => {
  it("grants authoring but never destruction", () => {
    // The whole point of splitting `delete` out: a token pasted into a coding agent
    // can build and edit, but cannot destroy an agent, a skill, or an integration.
    expect(DEFAULT_SCOPES).toEqual(["read", "write"]);
    expect(DEFAULT_SCOPES).not.toContain("delete");
  });

  it("only contains real scopes", () => {
    for (const scope of DEFAULT_SCOPES) expect(ALL_SCOPES).toContain(scope);
  });
});

describe("the catalog and the roles agree", () => {
  it("grants every scope to at least one role - a scope no role grants is dead", () => {
    const granted = new Set(ALL_ROLES.flatMap((r) => scopesForRole(r)));
    for (const scope of ALL_SCOPES) expect(granted, scope).toContain(scope);
  });
});
