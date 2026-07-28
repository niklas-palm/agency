/**
 * HTTP-level tests for the integrations proxy route (POST /internal/integrations/call).
 * These guard the AUTHORIZATION wiring: the session token must verify against the
 * body's agentId/sessionId, the requested integrationId must be in the token's
 * granted set, and the integration is resolved ORG-SCOPED from the token's
 * orgId (never an agent-supplied org). The downstream fetch is stubbed via the
 * integration record's baseUrl using a mocked forwardCall-free path: we mock the
 * integrations repo and let the real proxy compose the URL against a fake fetch.
 *
 * The signing key is stubbed before importing the app (session-token reads it at load).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.stubEnv("RUNTIME_INGEST_KEY", "test-ingest-signing-key");

const ORG = "org-A";
const CREATOR = "user-A";
const AGENT = "agent-1";
const SESSION = "sess-0123456789012345678901234567890123";
const GRANTED = "int-granted";
const OTHER = "int-other";

const RECORD = {
  id: GRANTED,
  orgId: ORG,
  createdBy: CREATOR,
  shared: true,
  name: "Petstore",
  description: "d",
  baseUrl: "https://downstream.example.com/v1",
  auth: { kind: "bearer" as const },
  operations: [{ operationId: "ping", summary: "ping", method: "GET" as const, path: "/ping" }],
  secret: "downstream-secret",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const getIntegration = vi.fn(async (org: string, id: string) =>
  org === ORG && id === GRANTED ? RECORD : null,
);
vi.mock("./repo/integrations.js", async () => {
  const actual = await vi.importActual<typeof import("./repo/integrations.js")>("./repo/integrations.js");
  return { ...actual, getIntegration: (o: string, id: string) => getIntegration(o, id) };
});

// Keep the telemetry repos quiet (buildApp wires the same routes).
vi.mock("./repo/trajectory.js", () => ({
  recordEvent: vi.fn(async () => {}),
  recordPrompt: vi.fn(async () => {}),
  readSession: vi.fn(async () => ({ status: "idle", events: [], cursor: null })),
}));
vi.mock("./repo/sessions.js", () => ({ writeSummary: vi.fn(async () => {}), metricsFor: vi.fn(async () => ({})) }));

const { buildApp } = await import("./app.js");
const { mintSessionToken } = await import("./session-token.js");

const app = buildApp();

// Stub global fetch so the proxy's forwarded request hits our fake downstream.
const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("pong", { status: 200 }));
vi.stubGlobal("fetch", fetchMock);

function callBody(over: Record<string, unknown> = {}) {
  return { agentId: AGENT, sessionId: SESSION, integrationId: GRANTED, operationId: "ping", ...over };
}
function req(token: string, body: unknown) {
  return app.request("/internal/integrations/call", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agency-Ingest-Token": token },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  fetchMock.mockClear();
  getIntegration.mockClear();
});

describe("POST /internal/integrations/call", () => {
  it("forwards a granted integration and returns the downstream status + body", async () => {
    const token = mintSessionToken(ORG, CREATOR, AGENT, SESSION, [GRANTED]);
    const res = await req(token, callBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 200, body: "pong" });
    // Resolved org-scoped from the TOKEN's orgId, and the downstream got the secret.
    expect(getIntegration).toHaveBeenCalledWith(ORG, GRANTED);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer downstream-secret");
  });

  it("403s an integration NOT in the token's grant (no forward)", async () => {
    const token = mintSessionToken(ORG, CREATOR, AGENT, SESSION, [GRANTED]);
    const res = await req(token, callBody({ integrationId: OTHER }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401s a forged token (no forward, no lookup)", async () => {
    const res = await req("forged.garbage.token", callBody());
    expect(res.status).toBe(401);
    expect(getIntegration).not.toHaveBeenCalled();
  });

  it("401s when the token is for a different session", async () => {
    const token = mintSessionToken(ORG, CREATOR, AGENT, "sess-9999999999999999999999999999999999", [GRANTED]);
    const res = await req(token, callBody());
    expect(res.status).toBe(401);
  });

  it("404s a granted-but-missing integration (deleted since attach)", async () => {
    // Token grants an id the repo no longer has.
    const token = mintSessionToken(ORG, CREATOR, AGENT, SESSION, ["int-ghost"]);
    const res = await req(token, callBody({ integrationId: "int-ghost" }));
    expect(res.status).toBe(404);
  });
});
