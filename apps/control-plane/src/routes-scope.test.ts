/**
 * Integration guard: the management routes are actually WIRED with the right
 * scope (and token routes with requireUser). The middleware unit tests
 * (scope-mw.test.ts) prove requireScope/requireUser behave; this proves each
 * route carries the correct one - so dropping a `requireScope` from a route
 * fails a test rather than silently shipping. Coverage spans all three
 * org-scoped resources - agents, skills, AND integrations - so a guard dropped
 * from any of them is caught, not just the agents routes.
 *
 * We mock only the auth lookup: a presented PAT resolves to a principal whose
 * scopes we set per test. Coverage is symmetric - a read-only token must be
 * blocked from write routes, AND a write-only token must be blocked from read
 * routes (a 200 alone can't prove a read guard, since requireAuth already admits
 * any valid PAT). requireScope 403s BEFORE the handler body, so dropping a guard
 * flips the response off 403 and fails the relevant case. Auth is enabled here
 * (AUTH_DISABLED unset in the test env), so the real requireAuth → requireScope
 * chain runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Scope } from "@agency/shared";

// The scopes the mocked PAT carries - set per test so we can present a read-only
// token (to prove write routes are guarded) AND a write-only token (to prove read
// routes are guarded - a 200 alone can't prove that, since requireAuth already
// admits any valid PAT).
let patScopes: Scope[] = ["read", "write"];

// getTokenByHash returns a token bound to org-1 with patScopes; touchToken is a
// no-op. This drives requireAuth down the real PAT path. The owner is an ADMIN of
// org-1, so the role grants all scopes and the effective set = roleScopes ∩
// patScopes = patScopes - i.e. patScopes IS the narrowing under test.
vi.mock("./repo/tokens.js", () => ({
  getTokenByHash: vi.fn(async () => ({
    tokenHash: "h",
    id: "tok-1",
    ownerId: "user-1",
    orgId: "org-1",
    name: "test",
    scopes: patScopes,
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
  getMembership: vi.fn(async () => ({
    orgId: "org-1",
    userId: "user-1",
    role: "admin",
    joinedAt: "2026-01-01T00:00:00Z",
  })),
}));

// The read route that IS allowed reaches listAgentsByOrg; everything else 403s
// before touching a repo. Keep the rest as harmless stubs.
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

// Skills + integrations: "not found" stubs. Needed because the delete-scope cases
// below deliberately CLEAR the guard and reach the handler - without these, those
// requests would hit real DynamoDB instead of returning a clean 404.
vi.mock("./repo/skills.js", () => ({
  listSkills: vi.fn(async () => []),
  getSkill: vi.fn(async () => null),
  putSkill: vi.fn(async () => {}),
  deleteSkill: vi.fn(async () => {}),
  getSkillsByIds: vi.fn(async () => []),
}));
vi.mock("./repo/integrations.js", async () => {
  const actual = await vi.importActual<typeof import("./repo/integrations.js")>("./repo/integrations.js");
  return {
    ...actual,
    listIntegrations: vi.fn(async () => []),
    getIntegration: vi.fn(async () => null),
    putIntegration: vi.fn(async () => {}),
    deleteIntegration: vi.fn(async () => {}),
    getIntegrationsByIds: vi.fn(async () => []),
  };
});

import { buildApp } from "./app.js";

const app = buildApp();
const PAT = "agpat_readonly_test_token_value_1234567890";
const auth = { Authorization: `Bearer ${PAT}` };

async function req(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { ...auth, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("route ↔ scope wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  // A read-only token: it must be BLOCKED from every write route. If a
  // requireScope("write") were dropped, the route would 201/404 (handler
  // reached) instead of 403 - failing this test.
  it("read-only PAT is blocked from write-scoped routes → 403", async () => {
    patScopes = ["read"];
    // Every write route across all three resources - agents, skills, integrations -
    // must 403 for a read-only token. requireScope runs before the handler, so a
    // dropped guard on ANY of these flips it off 403 and fails here.
    const cases: [string, string, unknown?][] = [
      ["POST", "/agents", { name: "x", systemPrompt: "y", model: "haiku-4.5" }],
      ["PATCH", "/agents/abc", { systemPrompt: "z" }],
      ["POST", "/agents/abc/rotate-key"],
      ["POST", "/agents/abc/versions/1/restore"],
      ["POST", "/skills", { name: "s", content: "c" }],
      ["PATCH", "/skills/abc", { name: "s" }],
      ["POST", "/integrations", { name: "i", baseUrl: "https://example.com" }],
      ["POST", "/integrations/discover", { specUrl: "https://example.com/openapi.json" }],
      ["PATCH", "/integrations/abc", { name: "i" }],
      ["POST", "/integrations/abc/refresh"],
    ];
    for (const [method, path, body] of cases) {
      const res = await req(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  // Every delete route: `delete` spans all three resources, not just agents.
  const DELETE_ROUTES = ["/agents/abc", "/skills/abc", "/integrations/abc"];

  // The load-bearing case: a default agentic token (read+write, DEFAULT_SCOPES) must
  // be unable to destroy ANYTHING. If a delete route were still wired to `write`,
  // it would reach the handler and 404 instead of 403 here.
  it("read+write PAT (the DEFAULT_SCOPES set) is blocked from every delete → 403", async () => {
    patScopes = ["read", "write"];
    for (const path of DELETE_ROUTES) {
      const res = await req("DELETE", path);
      expect(res.status, `DELETE ${path}`).toBe(403);
    }
  });

  // The positive complement: with `delete`, each route clears the guard and reaches
  // its handler (repos mocked → not found → 404). Proves the routes are wired to
  // `delete` specifically, not merely that some guard rejects a write token.
  it("PAT with delete clears the guard on every delete route", async () => {
    patScopes = ["delete"];
    for (const path of DELETE_ROUTES) {
      const res = await req("DELETE", path);
      expect(res.status, `DELETE ${path}`).toBe(404); // past requireScope
      // Assert the HANDLER's 404 body, not just the status: Hono answers an
      // unrouted path with 404 too, so status alone would keep passing if a route
      // registration were deleted or mistyped.
      expect(await res.json(), `DELETE ${path}`).toEqual({ error: "not found" });
    }
  });

  // The write routes' positive case. Without it, OVER-restriction is invisible: wiring
  // an author route to `delete` (the inverse of the mistake this suite exists to catch)
  // would break every default read+write PAT while the whole suite stayed green.
  it("read+write PAT reaches the author routes it should", async () => {
    patScopes = ["read", "write"];
    for (const [method, path, body] of [
      ["PATCH", "/skills/abc", { content: "c" }],
      ["PATCH", "/integrations/abc", { name: "i" }],
      ["POST", "/agents/abc/rotate-key", undefined],
    ] as [string, string, unknown?][]) {
      const res = await req(method, path, body);
      // Past the guard: the mocked repos have no such record, so the handler 404s.
      // Anything but 404 here means the route rejected a token that should pass.
      expect(res.status, `${method} ${path}`).toBe(404);
      // The handler's JSON body, not just the status - Hono answers an UNROUTED path
      // with 404 too, so status alone would keep passing if a route registration were
      // removed (the same trap as the delete case above).
      expect(await res.json(), `${method} ${path}`).toEqual({ error: "not found" });
    }
  });

  // A write-only token (no read): it must be BLOCKED from every read
  // route. A 200 could never prove the read guard is present (requireAuth admits
  // any valid PAT); only this negative case pins requireScope("read").
  it("write-only PAT is blocked from read-scoped routes → 403", async () => {
    patScopes = ["write"];
    // Symmetric to the write case: every read route across all three resources
    // must 403 for a write-only token. Pins requireScope("read") on each.
    const paths = [
      "/agents", "/agents/abc", "/agents/abc/versions", "/agents/abc/metrics",
      // Both runs routes, incl. the nested one - the nested path needs its OWN
      // requireAuth/requireScope registration (a prefix doesn't cover it), so it's the
      // easiest to ship ungated.
      "/agents/abc/runs", "/agents/abc/runs/019fa3fe-de0f-75b6-bc98-5b99ad349fe6",
      // The member roster is a read too. It was the one management route outside the
      // scope gate, so a credential with NO effective scopes (stamped `write`, owner
      // demoted to viewer → write ∩ read = empty) could still harvest member emails.
      "/orgs/org-1/members",
      "/skills", "/skills/abc",
      "/integrations", "/integrations/abc",
    ];
    for (const path of paths) {
      const res = await req("GET", path);
      expect(res.status, `GET ${path}`).toBe(403);
    }
  });

  // A full-scope token reaches the read handlers (proves the routes are live and
  // the read guard admits a holder - the positive complement to the case above).
  it("full-scope PAT is admitted to read routes", async () => {
    patScopes = ["read", "write"];
    expect((await req("GET", "/agents")).status).toBe(200); // listAgentsByOrg mocked → []
    expect((await req("GET", "/agents/abc")).status).toBe(404); // getAgent mocked → null (past the guard)
  });

  it("blocks token-management routes for a PAT (requireUser) → 403", async () => {
    patScopes = ["read", "write"];
    for (const [method, path, body] of [
      ["POST", "/tokens", { name: "n", scopes: ["read"] }],
      ["GET", "/tokens"],
      ["DELETE", "/tokens/abc"],
    ] as [string, string, unknown?][]) {
      const res = await req(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });
});
