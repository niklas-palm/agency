/**
 * Integrations routes: name uniqueness per ORG + credential redaction on read.
 * Auth is enabled (AUTH_DISABLED unset); a mocked PAT resolves to user-A, an admin
 * of org-A (full scopes). The integrations + agents repos are mocked so we control
 * the org's existing integrations and usage counts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("./repo/memberships.js", () => ({
  getMembership: vi.fn(async (orgId: string, userId: string) =>
    orgId === "org-A" && userId === "user-A"
      ? { orgId: "org-A", userId: "user-A", role: "admin", joinedAt: "2026-01-01T00:00:00Z" }
      : null,
  ),
}));

// One existing integration named "GitHub" owned by owner-A, WITH a secret.
const EXISTING = {
  id: "int-1",
  orgId: "org-A",
  createdBy: "user-A",
  shared: true,
  name: "GitHub",
  description: "GitHub API",
  baseUrl: "https://api.github.com",
  auth: { kind: "bearer" as const },
  operations: [{ operationId: "listRepos", summary: "List repos", method: "GET" as const, path: "/user/repos" }],
  secret: "ghp_supersecret",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
// A discovery-backed integration whose stored discovery.url sits OFF its baseUrl origin
// (validation SSRF-checks the url but doesn't bind it to baseUrl). A refresh must NOT
// send the write-only secret to that off-base host.
const OFF_BASE = {
  id: "int-2",
  orgId: "org-A",
  createdBy: "user-A",
  shared: true,
  name: "OffBase",
  description: "spec hosted off-base",
  baseUrl: "https://api.example.com",
  auth: { kind: "apiKey" as const, header: "x-api-key" },
  operations: [{ operationId: "x", summary: "x", method: "GET" as const, path: "/x" }],
  discovery: {
    url: "https://docs.other-host.com/openapi.json",
    provider: "openapi" as const,
    syncedAt: "2026-01-01T00:00:00Z",
    operations: [{ operationId: "x", summary: "x", method: "GET" as const, path: "/x", enabled: true }],
  },
  secret: "off_base_secret",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
// An oauth2Client integration: the client secret is POSTed to tokenUrl (a SEPARATE
// credential sink from baseUrl), so the exfil guard must cover tokenUrl too.
const OAUTH = {
  id: "int-oauth",
  orgId: "org-A",
  createdBy: "user-A",
  shared: true,
  name: "OAuthApi",
  description: "m2m",
  baseUrl: "https://api.example.com",
  auth: {
    kind: "oauth2Client" as const,
    tokenUrl: "https://auth.example.com/token",
    clientId: "cid",
    authStyle: "basic" as const,
  },
  operations: [{ operationId: "op", summary: "op", method: "GET" as const, path: "/x" }],
  secret: "client_secret_value",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const putIntegration = vi.fn(async (_r: unknown) => {});
/** The refresh path's targeted write. Returns true = "landed" (no conflict). */
const updateDiscoveryResult = vi.fn(async (..._a: unknown[]) => true);
vi.mock("./repo/integrations.js", async () => {
  const actual = await vi.importActual<typeof import("./repo/integrations.js")>("./repo/integrations.js");
  return {
    ...actual,
    listIntegrations: vi.fn(async () => [EXISTING]),
    getIntegration: vi.fn(async (_o: string, id: string) =>
      id === EXISTING.id ? EXISTING : id === OFF_BASE.id ? OFF_BASE : id === OAUTH.id ? OAUTH : null,
    ),
    putIntegration: (r: unknown) => putIntegration(r),
    updateDiscoveryResult: (...a: unknown[]) => updateDiscoveryResult(...a),
    deleteIntegration: vi.fn(async () => {}),
    getIntegrationsByIds: vi.fn(async () => []),
  };
});
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

function integrationBody(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    description: "d",
    baseUrl: "https://api.example.com",
    auth: { kind: "bearer" },
    operations: [{ operationId: "op", summary: "an op", method: "GET", path: "/x" }],
    ...extra,
  };
}
function post(b: unknown) {
  return app.request("/integrations", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(b),
  });
}

describe("integrations routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("409s a create whose name collides (case-insensitive)", async () => {
    const res = await post(integrationBody("github"));
    expect(res.status).toBe(409);
    expect(putIntegration).not.toHaveBeenCalled();
  });

  it("201s a create with a fresh name and never returns the secret", async () => {
    const res = await post(integrationBody("Stripe", { secret: "sk_live_x" }));
    expect(res.status).toBe(201);
    expect(putIntegration).toHaveBeenCalledOnce();
    const stored = putIntegration.mock.calls[0]![0] as Record<string, unknown>;
    expect(stored.secret).toBe("sk_live_x"); // stored server-side
    const resBody = (await res.json()) as { integration: Record<string, unknown> };
    expect(resBody.integration.secret).toBeUndefined(); // never in the response
    expect(resBody.integration.hasSecret).toBe(true);
  });

  it("honors shared:false on create (private integration)", async () => {
    const res = await post(integrationBody("Private", { shared: false }));
    expect(res.status).toBe(201);
    const stored = putIntegration.mock.calls[0]![0] as Record<string, unknown>;
    expect(stored.shared).toBe(false); // NOT silently forced to true
  });

  it("defaults shared:true when omitted on create", async () => {
    const res = await post(integrationBody("DefaultShared"));
    expect(res.status).toBe(201);
    const stored = putIntegration.mock.calls[0]![0] as Record<string, unknown>;
    expect(stored.shared).toBe(true);
  });

  it("PATCH can flip an integration private (shared:false)", async () => {
    const res = await app.request(`/integrations/${EXISTING.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(integrationBody("GitHub", { baseUrl: "https://api.github.com", shared: false })),
    });
    expect(res.status).toBe(200);
    const stored = putIntegration.mock.calls[0]![0] as Record<string, unknown>;
    expect(stored.shared).toBe(false); // flipped from EXISTING.shared === true
  });

  it("PATCH keeps shared as-is when the body omits it", async () => {
    const res = await app.request(`/integrations/${EXISTING.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(integrationBody("GitHub", { baseUrl: "https://api.github.com" })),
    });
    expect(res.status).toBe(200);
    const stored = putIntegration.mock.calls[0]![0] as Record<string, unknown>;
    expect(stored.shared).toBe(true); // preserved from EXISTING
  });

  it("400s an invalid body with details", async () => {
    const res = await post(integrationBody("Bad", { baseUrl: "ftp://x" }));
    expect(res.status).toBe(400);
    const b = (await res.json()) as { details?: string[] };
    expect(b.details?.some((d) => /baseUrl/i.test(d))).toBe(true);
  });

  it("GET redacts the secret and reports hasSecret", async () => {
    const res = await app.request(`/integrations/${EXISTING.id}`, { headers: auth });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { integration: Record<string, unknown> };
    expect(b.integration.secret).toBeUndefined();
    expect(b.integration.hasSecret).toBe(true);
  });

  it("PATCH without a secret keeps the stored credential", async () => {
    const res = await app.request(`/integrations/${EXISTING.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      // same name + same baseUrl origin, no secret
      body: JSON.stringify(integrationBody("GitHub", { baseUrl: "https://api.github.com/v2" })),
    });
    expect(res.status).toBe(200);
    const stored = putIntegration.mock.calls[0]![0] as Record<string, unknown>;
    expect(stored.secret).toBe("ghp_supersecret"); // preserved from EXISTING
  });

  it("PATCH REJECTS a baseUrl-origin change while keeping the stored secret (exfil guard)", async () => {
    // Moving baseUrl to an attacker origin + omitting the secret would ship the stored
    // write-only secret to that host (via the proxy forward AND a discovery fetch).
    const res = await app.request(`/integrations/${EXISTING.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(integrationBody("GitHub", { baseUrl: "https://evil.attacker.com" })),
    });
    expect(res.status).toBe(400);
    const b = (await res.json()) as { error: string };
    expect(b.error).toMatch(/re-entering the credential/i);
    expect(putIntegration).not.toHaveBeenCalled();
  });

  it("PATCH ALLOWS a baseUrl-origin change when the secret is re-entered", async () => {
    const res = await app.request(`/integrations/${EXISTING.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(integrationBody("GitHub", { baseUrl: "https://evil.attacker.com", secret: "new_secret" })),
    });
    expect(res.status).toBe(200); // caller proved they hold a credential by entering one
    const stored = putIntegration.mock.calls[0]![0] as Record<string, unknown>;
    expect(stored.secret).toBe("new_secret");
  });

  it("PATCH REJECTS an oauth2Client tokenUrl-origin change while keeping the stored secret", async () => {
    // The client secret is sent to tokenUrl, not baseUrl - moving tokenUrl to an
    // attacker host + omitting the secret would mint against it with the stored secret.
    const res = await app.request(`/integrations/${OAUTH.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "OAuthApi",
        description: "m2m",
        baseUrl: "https://api.example.com", // unchanged
        auth: { kind: "oauth2Client", tokenUrl: "https://evil.attacker.com/token", clientId: "cid", authStyle: "basic" },
        operations: [{ operationId: "op", summary: "op", method: "GET", path: "/x" }],
      }),
    });
    expect(res.status).toBe(400);
    const b = (await res.json()) as { error: string };
    expect(b.error).toMatch(/re-entering the credential/i);
    expect(putIntegration).not.toHaveBeenCalled();
  });

  it("PATCH ALLOWS an oauth2Client edit that keeps both sink origins (e.g. clientId change)", async () => {
    const res = await app.request(`/integrations/${OAUTH.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "OAuthApi",
        description: "m2m",
        baseUrl: "https://api.example.com",
        auth: { kind: "oauth2Client", tokenUrl: "https://auth.example.com/token2", clientId: "cid-new", authStyle: "basic" },
        operations: [{ operationId: "op", summary: "op", method: "GET", path: "/x" }],
      }),
    });
    expect(res.status).toBe(200); // tokenUrl path changed but ORIGIN is the same
    const stored = putIntegration.mock.calls[0]![0] as Record<string, unknown>;
    expect(stored.secret).toBe("client_secret_value"); // preserved
  });

  // The discovery spec fetch carries the integration credential ONLY when the spec URL
  // is under the integration's baseUrl origin. Since the secret is write-only and the
  // URL is caller-supplied, this stops an write holder from aiming the
  // credentialed fetch at their own host to read the stored secret from the header.
  describe("POST /integrations/discover credential anchoring", () => {
    const OPENAPI = JSON.stringify({ openapi: "3.0.0", paths: { "/x": { get: { operationId: "x", summary: "x" } } } });
    // Simulate an AUTH-GATED spec (the interesting case): 401 unless a credential header
    // is present, so discovery's try-both must fall through to the credentialed retry.
    // `lastHeaders()` then reflects whichever attempt the route ended on.
    const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const h = (init?.headers as Record<string, string>) ?? {};
      const hasCred = Boolean(h.Authorization || h["x-api-key"]);
      if (!hasCred) return new Response("unauthorized", { status: 401 });
      return new Response(OPENAPI, { status: 200, headers: { "content-type": "application/json" } });
    });
    const realFetch = globalThis.fetch;
    beforeEach(() => {
      fetchSpy.mockClear();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });
    function lastHeaders(): Record<string, string> {
      const init = fetchSpy.mock.calls.at(-1)![1] as RequestInit;
      return (init.headers as Record<string, string>) ?? {};
    }
    function discover(b: unknown) {
      return app.request("/integrations/discover", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });
    }

    it("attaches the credential when the spec URL is under baseUrl", async () => {
      const res = await discover({
        url: "https://api.example.com/openapi.json",
        baseUrl: "https://api.example.com",
        auth: { kind: "apiKey", header: "x-api-key" },
        secret: "sekret",
      });
      expect(res.status).toBe(200);
      expect(lastHeaders()["x-api-key"]).toBe("sekret");
    });

    it("does NOT attach the credential when the spec URL is OFF baseUrl (exfil anchor)", async () => {
      // The mock spec is auth-gated, so an off-base (unauthenticated) fetch fails (502) -
      // the point is that the credential was NEVER sent to the off-base host.
      const res = await discover({
        url: "https://evil.attacker.com/x",
        baseUrl: "https://api.example.com",
        auth: { kind: "apiKey", header: "x-api-key" },
        secret: "sekret",
      });
      expect(res.status).toBe(502); // off-base → unauthenticated → the gated spec 401s
      const leaked = fetchSpy.mock.calls.some((c) => (c[1]?.headers as Record<string, string>)?.["x-api-key"]);
      expect(leaked).toBe(false); // credential never attached on any attempt
    });

    it("anchors a STORED-secret fetch to the stored record's baseUrl, not a spoofed one", async () => {
      // EXISTING.baseUrl is https://api.github.com; the caller omits secret (→ stored)
      // but points the spec at their own host. The credential must NOT be sent there.
      const res = await discover({
        url: "https://evil.attacker.com/spec",
        integrationId: EXISTING.id,
        auth: { kind: "bearer" },
      });
      expect(res.status).toBe(502); // off-base → unauthenticated → gated spec fails
      const leaked = fetchSpy.mock.calls.some((c) => (c[1]?.headers as Record<string, string>)?.Authorization);
      expect(leaked).toBe(false);
    });

    it("sends the stored secret when the spec is under the stored record's baseUrl", async () => {
      const res = await discover({
        url: "https://api.github.com/openapi.json",
        integrationId: EXISTING.id,
        auth: { kind: "bearer" },
      });
      expect(res.status).toBe(200);
      expect(lastHeaders()["Authorization"]).toBe("Bearer ghp_supersecret");
    });

    it("preview reusing a STORED secret ignores a caller-supplied off-base tokenUrl (exfil guard)", async () => {
      // Attack: reuse the stored secret (omit it) but supply an oauth2Client auth whose
      // tokenUrl is attacker-controlled - a naive impl would POST the stored secret there.
      // The route must use the STORED record's own auth (bearer, no tokenUrl), not this.
      const res = await discover({
        url: "https://api.github.com/openapi.json", // under EXISTING.baseUrl
        integrationId: EXISTING.id,
        auth: { kind: "oauth2Client", tokenUrl: "https://evil.attacker.com/token", clientId: "x", authStyle: "body" },
      });
      expect(res.status).toBe(200);
      // No mint to the attacker host: the only fetch is the spec GET, authed with the
      // stored bearer secret (stored auth), and nothing was POSTed to evil.attacker.com.
      const hitEvil = fetchSpy.mock.calls.some((c) => String(c[0]).includes("evil.attacker.com"));
      expect(hitEvil).toBe(false);
      expect(lastHeaders()["Authorization"]).toBe("Bearer ghp_supersecret");
    });

    it("refresh does NOT send the credential when the stored discovery.url is off-base", async () => {
      // OFF_BASE.discovery.url is docs.other-host.com but baseUrl is api.example.com -
      // the automated refresh path must anchor the credential too, not just create/PATCH.
      // The gated mock 401s the unauthenticated fetch → 502; the credential never leaks.
      const res = await app.request(`/integrations/${OFF_BASE.id}/refresh`, { method: "POST", headers: auth });
      expect(res.status).toBe(502);
      const leaked = fetchSpy.mock.calls.some((c) => (c[1]?.headers as Record<string, string>)?.["x-api-key"]);
      expect(leaked).toBe(false);
    });

    it("refresh DOES send the credential when the stored discovery.url is under baseUrl", async () => {
      // Same-origin discovery record: getIntegration for a bespoke id.
      const onBase = {
        ...OFF_BASE,
        id: "int-3",
        discovery: { ...OFF_BASE.discovery, url: "https://api.example.com/openapi.json" },
      };
      const repo = await import("./repo/integrations.js");
      vi.mocked(repo.getIntegration).mockResolvedValueOnce(onBase as never);
      const res = await app.request(`/integrations/int-3/refresh`, { method: "POST", headers: auth });
      expect(res.status).toBe(200);
      expect(lastHeaders()["x-api-key"]).toBe("off_base_secret");
    });
  });
});
