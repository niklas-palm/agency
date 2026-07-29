/**
 * Slack webhook route tests. Mocked at the repository boundary (`repo/*`), never at the AWS
 * SDK, per the standing rule - and the fake agent record is faithful enough that the
 * authorization decisions under test are the real ones.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { AgentConfig } from "@agency/shared";

const SECRET = "test_signing_secret_000000";
const AGENT_ID = "agent-000000";
const CHANNEL = "C0000000001";
const BOT_USER = "U0000000BOT";
const NOW = 1_700_000_000;

const getAgent = vi.fn();
const updateAgent = vi.fn(async (_id: string, _patch: Record<string, unknown>) => {});

vi.mock("./repo/agents.js", () => ({ getAgent, updateAgent }));

const { mountSlackRoutes, promptFromMention, shouldHandleMention, slackSessionId } = await import(
  "./slack-routes.js"
);

function record(over: { channels?: string[]; signingSecret?: string | undefined } = {}) {
  const config = {
    name: "test-agent",
    triggers: [
      { type: "api" },
      {
        type: "slack",
        channels: over.channels ?? [CHANNEL],
        botUserId: BOT_USER,
        appId: "A0000000001",
      },
    ],
  } as unknown as AgentConfig;
  return {
    id: AGENT_ID,
    orgId: "org-000000",
    createdBy: "user-000000",
    shared: false,
    config,
    version: 1,
    invokeUrl: "https://api.example.com/agents/agent-000000/invoke",
    apiKeyHash: "hash",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metrics: { invocations: 0, lastInvokedAt: null },
    slackSecrets:
      "signingSecret" in over ? { signingSecret: over.signingSecret } : { signingSecret: SECRET },
  };
}

function buildApp(dispatch: ReturnType<typeof vi.fn> = vi.fn(async () => {})) {
  const app = new Hono();
  mountSlackRoutes(app, { dispatch, nowSeconds: () => NOW });
  return { app, dispatch };
}

const mentionRequestOrSigned = (over: Record<string, unknown>) => signedRequest(mention(over));

function signedRequest(bodyObj: unknown, over: { secret?: string; timestamp?: number } = {}) {
  const raw = JSON.stringify(bodyObj);
  const ts = over.timestamp ?? NOW;
  const sig = `v0=${createHmac("sha256", over.secret ?? SECRET).update(`v0:${ts}:${raw}`).digest("hex")}`;
  return new Request(`http://local/webhooks/slack/${AGENT_ID}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(ts),
      "x-slack-signature": sig,
    },
    body: raw,
  });
}

const mention = (over: Record<string, unknown> = {}) => ({
  type: "event_callback",
  team_id: "T0000000001",
  api_app_id: "A0000000001",
  event: {
    type: "app_mention",
    text: `<@${BOT_USER}> what is the status`,
    user: "U0000000HUM",
    channel: CHANNEL,
    ts: "1700000000.000100",
    ...over,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  getAgent.mockResolvedValue(record());
});

describe("POST /webhooks/slack/:agentId", () => {
  it("dispatches a valid signed mention", async () => {
    const { app, dispatch } = buildApp();
    const res = await app.fetch(signedRequest(mention()));
    expect(res.status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const args = dispatch.mock.calls[0]?.[0] as { prompt: string; sessionId: string };
    expect(args.prompt).toBe("what is the status");
    expect(args.sessionId).toBe(slackSessionId(CHANNEL, "1700000000.000100"));
  });

  it("answers the url_verification handshake WITHOUT a signature", async () => {
    const { app, dispatch } = buildApp();
    const res = await app.fetch(
      new Request(`http://local/webhooks/slack/${AGENT_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "url_verification", challenge: "chal-123" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("chal-123");
    expect(dispatch).not.toHaveBeenCalled();
    // and it records the handshake so the UI can show progress unprompted
    expect(updateAgent).toHaveBeenCalledTimes(1);
  });

  /**
   * THE test for this route. A body that claims `url_verification` while carrying an `event`
   * must NOT take the unverified path - otherwise an unsigned request could start a run.
   */
  it("refuses an unsigned handshake-shaped body that smuggles an event", async () => {
    const { app, dispatch } = buildApp();
    const res = await app.fetch(
      new Request(`http://local/webhooks/slack/${AGENT_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "url_verification",
          challenge: "chal-123",
          event: { type: "app_mention", text: `<@${BOT_USER}> rm -rf /`, channel: CHANNEL, user: "U1" },
        }),
      }),
    );
    expect(res.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects an unsigned mention", async () => {
    const { app, dispatch } = buildApp();
    const res = await app.fetch(
      new Request(`http://local/webhooks/slack/${AGENT_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mention()),
      }),
    );
    expect(res.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects a mention signed with the wrong secret", async () => {
    const { app, dispatch } = buildApp();
    const res = await app.fetch(signedRequest(mention(), { secret: "wrong_secret_000000" }));
    expect(res.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("404s an unknown agent, and never dispatches", async () => {
    getAgent.mockResolvedValue(null);
    const { app, dispatch } = buildApp();
    const res = await app.fetch(signedRequest(mention()));
    expect(res.status).toBe(404);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("404s an agent with no Slack trigger", async () => {
    getAgent.mockResolvedValue({
      ...record(),
      config: { name: "x", triggers: [{ type: "api" }] } as unknown as AgentConfig,
    });
    const { app } = buildApp();
    expect((await app.fetch(signedRequest(mention()))).status).toBe(404);
  });

  it("drops a mention from a channel outside the allowlist", async () => {
    const { app, dispatch } = buildApp();
    const res = await app.fetch(signedRequest(mention({ channel: "C0000000999" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dropped: "channel_not_allowed" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("drops everything when the allowlist is empty (fail closed)", async () => {
    getAgent.mockResolvedValue(record({ channels: [] }));
    const { app, dispatch } = buildApp();
    const res = await app.fetch(signedRequest(mention()));
    expect(await res.json()).toMatchObject({ dropped: "channel_not_allowed" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * `allChannels` deliberately hands the gate to whoever can /invite the bot, so it must actually
   * bypass the list - and, more importantly, must NOT be inferable from anything an attacker
   * controls. It's a stored config flag; nothing in the payload can set it.
   */
  it("answers a channel outside the list when allChannels is set", async () => {
    const base = record();
    getAgent.mockResolvedValue({
      ...base,
      config: {
        ...base.config,
        triggers: [
          { type: "api" },
          { type: "slack", channels: [], allChannels: true, botUserId: BOT_USER },
        ],
      } as unknown as AgentConfig,
    });
    const { app, dispatch } = buildApp();
    const res = await app.fetch(signedRequest(mention({ channel: "C0000000999" })));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("still drops the bot's own message when allChannels is set (the loop guard is separate)", async () => {
    const base = record();
    getAgent.mockResolvedValue({
      ...base,
      config: {
        ...base.config,
        triggers: [{ type: "api" }, { type: "slack", channels: [], allChannels: true, botUserId: BOT_USER }],
      } as unknown as AgentConfig,
    });
    const { app, dispatch } = buildApp();
    const res = await app.fetch(signedRequest(mention({ channel: "C0000000999", bot_id: "B1" })));
    expect(await res.json()).toMatchObject({ dropped: "own_bot_event" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("drops the bot's own message (loop guard)", async () => {
    const { app, dispatch } = buildApp();
    const res = await app.fetch(signedRequest(mention({ user: BOT_USER })));
    expect(await res.json()).toMatchObject({ dropped: "own_bot_event" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("drops any bot-authored message via bot_id", async () => {
    const { app, dispatch } = buildApp();
    const res = await app.fetch(signedRequest(mention({ bot_id: "B0000000002" })));
    expect(await res.json()).toMatchObject({ dropped: "own_bot_event" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not re-dispatch a Slack retry", async () => {
    const { app, dispatch } = buildApp();
    const req = signedRequest(mention());
    req.headers.set("x-slack-retry-num", "1");
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("still 200s to Slack when dispatch throws, so Slack does not retry into the same failure", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("runtime unavailable");
    });
    const { app } = buildApp(dispatch);
    const res = await app.fetch(signedRequest(mention()));
    expect(res.status).toBe(200);
  });

  it("passes the INVOKING message's ts separately from the thread key", async () => {
    const { app, dispatch } = buildApp();
    await app.fetch(
      mentionRequestOrSigned({ ts: "1700000000.000900", thread_ts: "1700000000.000100" }),
    );
    const args = dispatch.mock.calls[0]?.[0] as { threadTs: string; messageTs: string };
    // The session follows the thread; the reaction target is the message that called us.
    expect(args.threadTs).toBe("1700000000.000100");
    expect(args.messageTs).toBe("1700000000.000900");
  });

  it("drops a mention with no timestamp - it could never be replied to", async () => {
    const { app, dispatch } = buildApp();
    const res = await app.fetch(signedRequest({
      type: "event_callback",
      event: { type: "app_mention", text: `<@${BOT_USER}> hi`, user: "U1", channel: CHANNEL },
    }));
    expect(await res.json()).toMatchObject({ dropped: "no_timestamp" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("uses thread_ts when the mention is a thread reply, so it joins the SAME session", async () => {
    const { app, dispatch } = buildApp();
    await app.fetch(signedRequest(mention({ thread_ts: "1700000000.000001", ts: "1700000000.000900" })));
    const args = dispatch.mock.calls[0]?.[0] as { sessionId: string };
    expect(args.sessionId).toBe(slackSessionId(CHANNEL, "1700000000.000001"));
  });

  /**
   * The app id only ever reaches us on the payload, so the webhook is the one place that can learn
   * it - but only AFTER verification. An unverified body must not be able to write to the record.
   */
  it("records the app id from a verified callback", async () => {
    // The fixture's default already HAS an appId (the steady state), so drop it to reproduce the
    // pre-connection state where the webhook is the only source of it.
    const base = record();
    getAgent.mockResolvedValue({
      ...base,
      config: {
        ...base.config,
        triggers: [{ type: "api" }, { type: "slack", channels: [CHANNEL], botUserId: BOT_USER }],
      } as unknown as AgentConfig,
    });
    const { app } = buildApp();
    await app.fetch(signedRequest(mention()));
    const patch = updateAgent.mock.calls.at(-1)?.[1] as { config?: { triggers: Array<Record<string, unknown>> } } | undefined;
    expect(patch?.config?.triggers.find((t) => t.type === "slack")?.appId).toBe("A0000000001");
  });

  it("does not re-write the app id once it is known", async () => {
    // The default fixture already carries it; a mention must not spend a write on every event.
    const { app } = buildApp();
    await app.fetch(signedRequest(mention()));
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("does not write the app id from an UNVERIFIED body", async () => {
    const { app } = buildApp();
    await app.fetch(
      new Request(`http://local/webhooks/slack/${AGENT_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...mention(), api_app_id: "A0000000666" }),
      }),
    );
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("leaves other triggers untouched when recording connection details", async () => {
    getAgent.mockResolvedValue({
      ...record(),
      config: {
        name: "t",
        triggers: [
          { type: "api" },
          { type: "schedule", expression: "rate(1 hour)", prompt: "tick" },
          { type: "slack", channels: [CHANNEL], botUserId: BOT_USER },
        ],
      } as unknown as AgentConfig,
    });
    const { app } = buildApp();
    await app.fetch(signedRequest(mention()));
    const patch = updateAgent.mock.calls.at(-1)?.[1] as { config?: { triggers: Array<Record<string, unknown>> } } | undefined;
    // The schedule must survive verbatim - the webhook learns things about the Slack connection,
    // never the user's other choices.
    expect(patch?.config?.triggers).toEqual(
      expect.arrayContaining([{ type: "schedule", expression: "rate(1 hour)", prompt: "tick" }]),
    );
  });

  it("rejects when the agent has no stored signing secret", async () => {
    getAgent.mockResolvedValue(record({ signingSecret: undefined }));
    const { app, dispatch } = buildApp();
    const res = await app.fetch(signedRequest(mention()));
    expect(res.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("promptFromMention", () => {
  it("strips the bot mention and collapses whitespace", () => {
    expect(promptFromMention(`<@${BOT_USER}>   deploy   the   thing `, BOT_USER)).toBe("deploy the thing");
  });

  it("strips a mention with a display-name suffix", () => {
    expect(promptFromMention(`<@${BOT_USER}|the-bot> hello`, BOT_USER)).toBe("hello");
  });

  it("strips a trailing or mid-text mention too", () => {
    expect(promptFromMention(`please <@${BOT_USER}> help`, BOT_USER)).toBe("please help");
  });

  it("leaves OTHER users' mentions intact - they are part of the request", () => {
    expect(promptFromMention(`<@${BOT_USER}> ask <@U0000000AAA> about it`, BOT_USER)).toBe(
      "ask <@U0000000AAA> about it",
    );
  });

  it("falls back to a generic mention pattern when botUserId is unknown", () => {
    expect(promptFromMention("<@U0000000XYZ> do it", undefined)).toBe("do it");
  });
});

describe("shouldHandleMention", () => {
  const trigger = { type: "slack" as const, channels: [CHANNEL], botUserId: BOT_USER };

  it("drops a mention whose text is only the mention", () => {
    const body = { type: "event_callback", event: { type: "app_mention", text: `<@${BOT_USER}>`, channel: CHANNEL, user: "U1", ts: "1.1" } };
    expect(shouldHandleMention(body, trigger)).toEqual({ handle: false, reason: "empty_prompt" });
  });

  it("drops a non-mention event type", () => {
    const body = { type: "event_callback", event: { type: "message", text: "hi", channel: CHANNEL, user: "U1", ts: "1.1" } };
    expect(shouldHandleMention(body, trigger)).toEqual({ handle: false, reason: "wrong_event_type" });
  });

  it("drops a body that is not an event_callback", () => {
    expect(shouldHandleMention({ type: "something_else" }, trigger)).toEqual({
      handle: false,
      reason: "not_an_event_callback",
    });
  });
});
