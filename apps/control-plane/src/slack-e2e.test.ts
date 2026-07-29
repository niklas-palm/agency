/**
 * Slack end-to-end, in-process: the REAL Hono app, the REAL routes, mocked only at the
 * repository boundary and at `fetch` (Slack itself).
 *
 * This exists because the per-module tests each prove one link, and the thing most likely to
 * be wrong is the wiring between them: that a signed mention reaches the invoker with
 * `fromSlack` set, that a second mention in the same thread lands on the SAME session id (which
 * is what makes mid-turn injection work), and that the setup endpoints move the derived state
 * along in the order the UI expects.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { AgentConfig } from "@agency/shared";

const SIGNING_SECRET = "e2e_signing_secret_000000";
const BOT_TOKEN = "bot-token-for-tests-000000";
const AGENT_ID = "agent-e2e-000000";
const CHANNEL = "C0000000001";
const BOT_USER = "U0000000BOT";

/** The in-memory agent record. Mutated by the routes under test, like the real table. */
let stored: Record<string, unknown>;

const getAgent = vi.fn(async () => stored);
const updateAgent = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
  stored = { ...stored, ...patch };
});
const putVersion = vi.fn(async () => {});
const recordPrompt = vi.fn(async () => {});

vi.mock("./repo/agents.js", async () => {
  const actual = await vi.importActual<typeof import("./repo/agents.js")>("./repo/agents.js");
  return { ...actual, getAgent, updateAgent };
});
vi.mock("./repo/versions.js", async () => {
  const actual = await vi.importActual<typeof import("./repo/versions.js")>("./repo/versions.js");
  return { ...actual, putVersion, listVersions: vi.fn(async () => []) };
});
vi.mock("./repo/trajectory.js", async () => {
  const actual = await vi.importActual<typeof import("./repo/trajectory.js")>("./repo/trajectory.js");
  return { ...actual, recordPrompt, recordEvent: vi.fn(async () => {}) };
});
vi.mock("./resolve-attachments.js", () => ({
  resolveSkills: vi.fn(async () => []),
  resolveIntegrations: vi.fn(async () => ({ manifests: [], grantedIds: [] })),
}));

const { buildRoutes } = await import("./routes.js");
const { slackSessionId } = await import("./slack-routes.js");

/** Records what the invoker was asked to do - the assertion surface for the dispatch path. */
const invokes: Array<Record<string, unknown>> = [];
const invoker = {
  invoke: vi.fn(async (args: Record<string, unknown>) => {
    invokes.push(args);
    return { status: "triggered", sessionId: args.sessionId as string };
  }),
};

function app() {
  return buildRoutes({
    invoker,
    scheduleProvisioner: { reconcile: vi.fn(async () => {}) },
    identity: {
      ensureUser: vi.fn(async () => "user-000000"),
      emailForUser: vi.fn(async () => "user@example.com"),
    },
  } as never);
}

function slackRecord(over: { channels?: string[]; secrets?: boolean } = {}) {
  return {
    id: AGENT_ID,
    orgId: "org-000000",
    createdBy: "user-000000",
    shared: false,
    config: {
      name: "e2e-agent",
      systemPrompt: "you are a test",
      model: "claude-sonnet-4-5",
      baseTools: true,
      webSearch: false,
      networkAccess: false,
      networkMode: "public",
      triggers: [
        { type: "api" },
        { type: "slack", channels: over.channels ?? [CHANNEL], botUserId: BOT_USER, appId: "A0000000001", teamId: "T0000000001" },
      ],
    } as unknown as AgentConfig,
    version: 3,
    invokeUrl: "https://api.example.com/agents/agent-e2e-000000/invoke",
    apiKeyHash: "hash",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metrics: { invocations: 0, lastInvokedAt: null },
    ...(over.secrets === false ? {} : { slackSecrets: { signingSecret: SIGNING_SECRET, botToken: BOT_TOKEN } }),
  };
}

function mentionRequest(text: string, over: { ts?: string; threadTs?: string; channel?: string } = {}) {
  const raw = JSON.stringify({
    type: "event_callback",
    team_id: "T0000000001",
    api_app_id: "A0000000001",
    event: {
      type: "app_mention",
      text,
      user: "U0000000HUM",
      channel: over.channel ?? CHANNEL,
      ts: over.ts ?? "1700000000.000100",
      ...(over.threadTs ? { thread_ts: over.threadTs } : {}),
    },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest("hex")}`;
  return new Request(`http://local/webhooks/slack/${AGENT_ID}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    },
    body: raw,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  invokes.length = 0;
  stored = slackRecord();
});

describe("Slack end to end", () => {
  it("a signed mention reaches the invoker with fromSlack and the thread's session id", async () => {
    const res = await app().fetch(mentionRequest(`<@${BOT_USER}> summarise the deploy`));
    expect(res.status).toBe(200);

    // The dispatch is fire-and-forget so the ack isn't blocked; let it settle.
    await new Promise((r) => setTimeout(r, 10));

    expect(invokes).toHaveLength(1);
    expect(invokes[0]).toMatchObject({
      agentId: AGENT_ID,
      prompt: "summarise the deploy",
      fromSlack: true,
      sessionId: slackSessionId(CHANNEL, "1700000000.000100"),
      version: 3,
    });
    // The capability token must be present, or the agent's reply tool can't authenticate.
    expect(typeof invokes[0]!.ingestToken).toBe("string");
    expect(recordPrompt).toHaveBeenCalledTimes(1);
  });

  /**
   * The headline behaviour: a follow-up in the same thread must produce the SAME session id, so
   * the runtime's mailbox injects it into the running turn instead of starting a second run.
   */
  it("a follow-up in the same thread reuses the session id", async () => {
    const a = app();
    await a.fetch(mentionRequest(`<@${BOT_USER}> start`, { ts: "1700000000.000100" }));
    await a.fetch(
      mentionRequest(`<@${BOT_USER}> also check the logs`, {
        ts: "1700000000.000900",
        threadTs: "1700000000.000100",
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(invokes).toHaveLength(2);
    expect(invokes[1]!.sessionId).toBe(invokes[0]!.sessionId);
    expect(invokes[1]!.prompt).toBe("also check the logs");
  });

  it("a mention in a different thread is a different session", async () => {
    const a = app();
    await a.fetch(mentionRequest(`<@${BOT_USER}> one`, { ts: "1700000000.000100" }));
    await a.fetch(mentionRequest(`<@${BOT_USER}> two`, { ts: "1700000000.000200" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(invokes[0]!.sessionId).not.toBe(invokes[1]!.sessionId);
  });

  /**
   * The bug that made the whole feature silently do nothing in production.
   *
   * The route used to fire-and-forget (`void deps.dispatch(...)`). That works in a long-lived Node
   * process, so every test passed - but a Lambda FREEZES the moment it returns its response, so
   * the pending promise was killed before the invoke completed. The webhook 200'd in ~2ms and no
   * run ever started.
   *
   * So: the invoker must have been called BY THE TIME the response resolves. No `await` on a
   * timer, no settling - that's precisely the leniency that hid this.
   */
  it("invokes BEFORE responding, so a frozen Lambda can't kill the dispatch", async () => {
    let invokedBeforeResponse = false;
    const slow = {
      invoke: vi.fn(async (args: Record<string, unknown>) => {
        // A real invoke is a network call; simulate one so a fire-and-forget can't sneak past.
        await new Promise((r) => setTimeout(r, 25));
        invokes.push(args);
        invokedBeforeResponse = true;
        return { status: "triggered", sessionId: args.sessionId as string };
      }),
    };
    const app = buildRoutes({
      invoker: slow,
      scheduleProvisioner: { reconcile: vi.fn(async () => {}) },
      identity: { ensureUser: vi.fn(), emailForUser: vi.fn() },
    } as never);

    const res = await app.fetch(mentionRequest(`<@${BOT_USER}> do the thing`));
    expect(res.status).toBe(200);
    // Asserted with NO intervening await: if the route returned before the invoke finished, the
    // work would be lost in Lambda.
    expect(invokedBeforeResponse, "the route responded before the invoke completed").toBe(true);
    expect(slow.invoke).toHaveBeenCalledTimes(1);
  });

  it("an unsigned mention never reaches the invoker", async () => {
    const raw = JSON.stringify({
      type: "event_callback",
      event: { type: "app_mention", text: `<@${BOT_USER}> do it`, user: "U1", channel: CHANNEL, ts: "1.1" },
    });
    const res = await app().fetch(
      new Request(`http://local/webhooks/slack/${AGENT_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(res.status).toBe(401);
    expect(invokes).toHaveLength(0);
  });

  it("answers the url_verification challenge and records it, without invoking", async () => {
    stored = slackRecord();
    const res = await app().fetch(
      new Request(`http://local/webhooks/slack/${AGENT_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "url_verification", challenge: "chal-abc" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("chal-abc");
    expect(invokes).toHaveLength(0);
    // The trigger is marked verified, which is what flips the UI's state unprompted.
    const triggers = (stored.config as { triggers: Array<Record<string, unknown>> }).triggers;
    expect(triggers.find((t) => t.type === "slack")?.urlVerified).toBe(true);
  });

  it("drops a mention from a channel that isn't allowed", async () => {
    stored = slackRecord({ channels: ["C0000000999"] });
    const res = await app().fetch(mentionRequest(`<@${BOT_USER}> hello`));
    await new Promise((r) => setTimeout(r, 10));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dropped: "channel_not_allowed" });
    expect(invokes).toHaveLength(0);
  });
});

/*
 * The authed setup endpoints (`GET /agents/:id/slack` and the two PUTs) aren't covered here:
 * reaching them needs the full auth middleware harness, and standing one up in this file would
 * mean asserting against my own fake principal rather than the real authorization path. They're
 * covered where the real decisions live - `slack-setup.test.ts` for the state machine and the
 * two Slack calls, `slack-manifest.test.ts` for the manifest's shape, and `routes-scope.test.ts`
 * for scope gating. What THIS file exists to prove is the webhook→invoker wiring above.
 */
