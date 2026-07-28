/**
 * The invoke route's failure contract. Invoking is NOT idempotent - a second
 * invoke on the same sessionId is INJECTED into the running turn - so what we tell
 * a client after a failure decides whether it duplicates the user's prompt.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Deps } from "./app.js";

const AGENT_ID = "agent-1";
const API_KEY = "ak_test_key_for_invoke_route_00000";

vi.mock("./apikey.js", async () => {
  const actual = await vi.importActual<typeof import("./apikey.js")>("./apikey.js");
  return { ...actual, verifyApiKey: (key: string) => key === API_KEY };
});

const AGENT = {
  id: AGENT_ID,
  orgId: "org-A",
  createdBy: "user-A",
  shared: true,
  config: {
    name: "a", systemPrompt: "s", model: "haiku-4.5", baseTools: false,
    webSearch: false, networkAccess: true, triggers: [{ type: "api" }],
    skillIds: ["skill-1"], // so the skill resolver actually runs
  },
  version: 3,
  invokeUrl: "http://x",
  apiKeyHash: "hash",
  createdAt: "t",
  updatedAt: "t",
  metrics: { invocations: 0, lastInvokedAt: null },
};

vi.mock("./repo/agents.js", () => ({
  getAgent: vi.fn(async (id: string) => (id === AGENT_ID ? { ...AGENT } : null)),
  listAgentsByOrg: vi.fn(async () => []),
  putAgent: vi.fn(async () => {}),
  updateAgent: vi.fn(async () => {}),
  deleteAgent: vi.fn(async () => {}),
  toPublic: (r: Record<string, unknown>) => ({ ...r }),
  normalizeConfig: (c: Record<string, unknown>) => c,
  freshMetrics: () => ({ invocations: 0, lastInvokedAt: null }),
}));
const recordPrompt = vi.fn(async () => {});
vi.mock("./repo/trajectory.js", () => ({
  recordPrompt: (...a: unknown[]) => recordPrompt(...(a as [])),
  recordEvent: vi.fn(async () => {}),
  readSession: vi.fn(async () => ({ delta: [], status: "working" })),
}));
vi.mock("./repo/metrics.js", () => ({ bumpInvocation: vi.fn(async () => {}) }));
const getSkillsByIds = vi.fn(async () => [] as unknown[]);
vi.mock("./repo/skills.js", () => ({
  getSkillsByIds: (...a: unknown[]) => getSkillsByIds(...(a as [])),
  listSkills: vi.fn(async () => []),
}));

import { buildApp } from "./app.js";

/** Build an app whose invoker behaves as given. */
function appWith(invoke: Deps["invoker"]["invoke"]) {
  return buildApp({
    scheduler: { reconcile: async () => {}, remove: async () => {} },
    invoker: { invoke },
    identity: { ensureUser: async () => "exists" as const, emailFor: async () => undefined },
  });
}

function post(app: ReturnType<typeof buildApp>, body: unknown) {
  return app.request(`/agents/${AGENT_ID}/invoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const timeout = () => Object.assign(new Error("socket hang up"), { name: "TimeoutError" });

beforeEach(() => vi.clearAllMocks());

describe("invoke route", () => {
  it("returns the sessionId and status on success", async () => {
    const app = appWith(async ({ sessionId }) => ({ status: "triggered", sessionId }));
    const res = await post(app, { prompt: "hello" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; status: string };
    expect(body.status).toBe("triggered");
    expect(body.sessionId.length).toBeGreaterThanOrEqual(33); // AgentCore's floor
  });

  it("504s an ambiguous timeout instead of inviting a duplicate-prompt retry", async () => {
    // A timed-out invoke may have been accepted by the runtime. The generic
    // transient path would answer 503 "retry shortly", and that retry would inject
    // the same prompt into the turn that is already running. So: 504 + the
    // sessionId, so the client polls to find out what actually happened.
    const app = appWith(async () => {
      throw timeout();
    });
    const res = await post(app, { prompt: "hello" });
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: string; sessionId: string };
    expect(body.sessionId.length).toBeGreaterThanOrEqual(33); // pollable
    expect(body.error).toMatch(/poll/i);
    // No prompt event: we don't know whether the turn started, so claiming it did
    // would put a phantom message in the trajectory.
    expect(recordPrompt).not.toHaveBeenCalled();
  });

  it("still surfaces an unambiguous failure through the normal error path", async () => {
    const app = appWith(async () => {
      throw Object.assign(new Error("nope"), { name: "AccessDeniedException" });
    });
    const res = await post(app, { prompt: "hello" });
    expect(res.status).toBe(500); // not swallowed, not mislabelled as a timeout
  });

  it("503s instead of running an agent whose skills failed to load", async () => {
    // A skills read failure used to resolve to [] and invoke anyway: the agent would
    // run WITHOUT the instructions it was configured with, improvise, and the call
    // would report success. A retryable error is the honest answer.
    getSkillsByIds.mockRejectedValueOnce(
      Object.assign(new Error("ddb down"), { name: "InternalServerException" }),
    );
    const invoke = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      status: "triggered" as const,
      sessionId,
    }));
    const app = appWith(invoke);
    const res = await post(app, { prompt: "hello" });
    expect(res.status).toBe(503);
    expect(invoke).not.toHaveBeenCalled(); // never reached the runtime
  });

  // A real support incident: someone pasted the docs' `AGENT_ID` placeholder AND used a
  // key from another agent, then reported the platform broken. Both mistakes produce the
  // SAME 401 - deliberately, so agent ids can't be enumerated - so the message has to name
  // both causes, and these cases pin that the two really are indistinguishable.
  describe("the invoke/poll 401", () => {
    const app = appWith(async ({ sessionId }) => ({ status: "triggered" as const, sessionId }));
    const invoke = (headers: Record<string, string>) =>
      app.request(`/agents/${AGENT_ID}/invoke`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      });

    it("is byte-identical for a wrong key and an unknown agent id", async () => {
      const wrongKey = await invoke({ Authorization: "Bearer ag_not_the_right_key" });
      const unknownId = await app.request("/agents/no-such-agent/invoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      });
      expect(wrongKey.status).toBe(401);
      expect(unknownId.status).toBe(401);
      // Same body: the response must not reveal WHICH of the two was wrong.
      expect(await wrongKey.json()).toEqual(await unknownId.json());
    });

    it("names both causes, so a caller knows what to check", async () => {
      const body = (await (await invoke({ Authorization: "Bearer ag_wrong" })).json()) as { error: string };
      expect(body.error).toMatch(/agent id/i); // check the URL
      expect(body.error).toMatch(/key/i); //     ...and the key
    });

    it("accepts the key with OR without the `Bearer` prefix", async () => {
      // The docs show `Bearer`, but the prefix is stripped optionally - so a caller who
      // omits it isn't the cause of a 401, and shouldn't be sent chasing it.
      expect((await invoke({ Authorization: `Bearer ${API_KEY}` })).status).toBe(200);
      expect((await invoke({ Authorization: API_KEY })).status).toBe(200);
    });

    it("401s a missing Authorization header", async () => {
      expect((await invoke({})).status).toBe(401);
    });
  });

  it("records the prompt only for a fresh turn, not an injection", async () => {
    const injected = appWith(async ({ sessionId }) => ({ status: "injected", sessionId }));
    await post(injected, { prompt: "second message" });
    // An injected message is recorded by the runtime hook as an `injected` event;
    // writing a `prompt` event here too would double it in the trace.
    expect(recordPrompt).not.toHaveBeenCalled();
  });
});
