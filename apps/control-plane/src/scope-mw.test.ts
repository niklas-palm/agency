/**
 * Scope + role + credential-kind enforcement (requireScope / requireRole /
 * requireUser). These guards can't be exercised via the local stack (AUTH_DISABLED
 * grants an admin local-dev principal), so we test the middleware directly with a
 * synthetic principal - the same check that runs on the deployed, auth-enabled
 * stack.
 *
 * In the org model a JWT no longer bypasses scopes: every principal carries exactly
 * its ROLE's effective scope set (a PAT further narrowed by its own scopes), so
 * hasScope is a simple membership test regardless of `kind`.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Principal } from "./auth.js";
import { hasScope, requireScope, requireUser } from "./auth.js";

/** A Hono app that injects `principal` then applies the middleware under test. */
function appWith(
  principal: Principal,
  mw: ReturnType<typeof requireScope> | typeof requireUser,
) {
  const app = new Hono<{ Variables: { principal: Principal } }>();
  app.use("*", async (c, next) => {
    c.set("principal", principal);
    return next();
  });
  app.get("/x", mw, (c) => c.json({ ok: true }));
  return app;
}

// A principal with a given role's scopes + kind. Mirrors how requireAuth builds it.
const mk = (
  scopes: Principal["scopes"],
  role: Principal["role"],
  kind: Principal["kind"] = "jwt",
): Principal => ({ userId: "u", orgId: "org-u", role, scopes, kind });

describe("requireScope", () => {
  it("allows a principal holding the scope", async () => {
    const res = await appWith(mk(["read"], "viewer"), requireScope("read")).request("/x");
    expect(res.status).toBe(200);
  });

  it("403s a principal missing the scope (viewer → write)", async () => {
    const res = await appWith(mk(["read"], "viewer"), requireScope("write")).request("/x");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/write/);
  });

  it("a viewer JWT is blocked from write - a JWT no longer bypasses scopes", async () => {
    const res = await appWith(mk(["read"], "viewer", "jwt"), requireScope("write")).request("/x");
    expect(res.status).toBe(403);
  });

  it("an editor JWT clears write + delete", async () => {
    expect((await appWith(mk(["read", "write", "delete"], "editor"), requireScope("write")).request("/x")).status).toBe(200);
    expect((await appWith(mk(["read", "write", "delete"], "editor"), requireScope("delete")).request("/x")).status).toBe(200);
  });
});

describe("hasScope (the single authority rule)", () => {
  it("holds a scope iff it's in the principal's effective set - kind-independent", () => {
    const viewer = mk(["read"], "viewer", "jwt");
    expect(hasScope(viewer, "read")).toBe(true);
    expect(hasScope(viewer, "write")).toBe(false);
    expect(hasScope(viewer, "delete")).toBe(false);
    const editor = mk(["read", "write", "delete"], "editor", "token");
    expect(hasScope(editor, "write")).toBe(true);
    expect(hasScope(editor, "delete")).toBe(true);
  });
});

// Org-role gating (requireOrgRole) is tested at the route level in
// org-routes.test.ts / org-invites.test.ts, since it re-reads membership for the
// org named in the PATH (not the active-org principal), so a unit stub can't
// exercise it meaningfully.

describe("requireUser", () => {
  it("allows a JWT (interactive/M2M) principal", async () => {
    const res = await appWith(mk(["read"], "admin", "jwt"), requireUser).request("/x");
    expect(res.status).toBe(200);
  });

  it("403s a PAT principal - a token can't manage tokens/orgs", async () => {
    const res = await appWith(mk(["read", "write", "delete"], "admin", "token"), requireUser).request("/x");
    expect(res.status).toBe(403);
  });
});
