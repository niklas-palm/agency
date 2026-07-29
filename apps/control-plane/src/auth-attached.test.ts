/**
 * Every authed route must answer 401 without a credential.
 *
 * `requireAuth` is attached per-path (`app.use("/agents/:id", …)`), and a nested path is NOT
 * covered by its parent's prefix - `/agents/:id/slack` needs its own line, exactly as
 * `/integrations/:id/refresh` does. Forgetting one doesn't fail a typecheck and doesn't fail any
 * handler test: the route just reaches `requireScope` with no principal.
 *
 * That shipped once (the three Slack setup routes), where it surfaced as a 500 instead of a 401 -
 * accidental safety that depended on a property dereference throwing. This test enumerates the
 * routes so the next omission is caught by shape, not by luck.
 *
 * A 401-only check is NOT sufficient, and that shipped too: `requireAuth` was never attached to
 * `/agents/:id/slack/bot-name`, so it 401'd for EVERYONE - which this file happily called a pass,
 * since a missing guard and a working guard give the same answer to an unauthenticated request. The
 * bot-rename feature was dead in production and no test objected. So the second describe below
 * sends a VALID credential and asserts the route gets past auth: only a route whose middleware is
 * actually attached can do that.
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("./repo/agents.js", () => ({
  getAgent: vi.fn(async () => null),
  updateAgent: vi.fn(async () => {}),
  listAgentsByOrg: vi.fn(async () => []),
}));

// A PAT that resolves to an admin with every scope, so the positive block below is testing whether
// the route is GUARDED - not whether this particular principal is allowed to do the thing.
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
}));
vi.mock("./repo/memberships.js", () => ({
  getMembership: vi.fn(async () => ({
    orgId: "org-A",
    userId: "user-A",
    role: "admin",
    joinedAt: "2026-01-01T00:00:00Z",
  })),
}));

const { buildRoutes } = await import("./routes.js");
const { buildApp } = await import("./app.js");

/** Every management route, as (method, path). The run API (invoke/poll) is deliberately absent:
 *  it authenticates with the agent's own API key inside the handler, not via requireAuth. */
const AUTHED: Array<[string, string]> = [
  ["GET", "/agents"],
  ["POST", "/agents"],
  ["GET", "/agents/a1"],
  ["PATCH", "/agents/a1"],
  ["DELETE", "/agents/a1"],
  ["POST", "/agents/a1/rotate-key"],
  ["GET", "/agents/a1/versions"],
  ["POST", "/agents/a1/versions/1/restore"],
  ["GET", "/agents/a1/metrics"],
  ["GET", "/agents/a1/runs"],
  ["GET", "/agents/a1/runs/r1"],
  // The three that were missing. Nested under /agents/:id, so not covered by its prefix.
  ["GET", "/agents/a1/slack"],
  ["DELETE", "/agents/a1/slack"],
  ["PATCH", "/agents/a1/slack/bot-name"],
  ["PATCH", "/agents/a1/slack/credentials"],
  ["PATCH", "/agents/a1/slack/channels"],
  ["GET", "/skills"],
  ["POST", "/skills"],
  ["GET", "/skills/s1"],
  ["GET", "/integrations"],
  ["POST", "/integrations"],
  ["GET", "/integrations/i1"],
  ["POST", "/integrations/i1/refresh"],
  ["GET", "/tokens"],
  ["POST", "/tokens"],
  ["GET", "/me"],
  ["POST", "/orgs"],
  ["GET", "/orgs/o1/members"],
  ["GET", "/invites"],
];

function app() {
  const a = new Hono();
  a.route(
    "/",
    buildRoutes({
      invoker: { invoke: vi.fn() },
      scheduleProvisioner: { reconcile: vi.fn(async () => {}) },
      identity: { ensureUser: vi.fn(), emailForUser: vi.fn() },
    } as never),
  );
  return a;
}

/** The full app, so the real auth middleware resolves the mocked PAT above. */
function authedApp() {
  return buildApp();
}

describe("requireAuth is attached to every management route", () => {
  it.each(AUTHED)("%s %s answers 401 with no credential", async (method, path) => {
    const res = await app().fetch(
      new Request(`http://local${path}`, {
        method,
        ...(method === "POST" || method === "PATCH" || method === "PUT"
          ? { headers: { "content-type": "application/json" }, body: "{}" }
          : {}),
      }),
    );
    // 401 specifically: a 500 would mean the route reached a handler with no principal, and a
    // 403 would mean it decided a scope question it had no identity to answer.
    expect(res.status).toBe(401);
  });
});

/**
 * The other half: with a valid credential, an attached route must get PAST auth. A route missing
 * its `app.use(requireAuth)` line 401s no matter who calls it, which the block above cannot
 * distinguish from a correctly-guarded route. Anything but 401 means auth resolved a principal -
 * the handler is then free to 403/404/400, which is the handlers' business, not this file's.
 */
describe("an attached route admits a VALID credential", () => {
  it.each(AUTHED)("%s %s does not 401 with a valid token", async (method, path) => {
    const res = await authedApp().fetch(
      new Request(`http://local${path}`, {
        method,
        headers: {
          Authorization: "Bearer agpat_test_token_value_0000000000000000",
          ...(method === "POST" || method === "PATCH" || method === "PUT"
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(method === "POST" || method === "PATCH" || method === "PUT" ? { body: "{}" } : {}),
      }),
    );
    expect(res.status).not.toBe(401);
  });
});
