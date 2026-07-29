import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@agency/shared";

const getAgent = vi.fn();
vi.mock("./repo/agents.js", () => ({ getAgent }));

const { callSlack, parseSlackSessionId, SLACK_STATUS_EMOJI } = await import("./slack-proxy.js");
const { slackSessionId } = await import("./slack-routes.js");
const { isValidSessionId } = await import("./session-id.js");

/**
 * Obviously-synthetic stand-ins. Nothing validates a token's FORMAT, so these carry no
 * `xoxb-` prefix - a real-looking literal in a fixture trips secret scanners for no gain.
 */
const FAKE_BOT_TOKEN = "bot-token-for-tests-000000";

const CHANNEL = "C0000000001";
const THREAD = "1700000000.000100";
const SESSION = slackSessionId(CHANNEL, THREAD);

function record(over: { channels?: string[]; botToken?: string | null } = {}) {
  return {
    id: "agent-000000",
    orgId: "org-000000",
    createdBy: "user-000000",
    shared: false,
    config: {
      name: "a",
      triggers: [{ type: "api" }, { type: "slack", channels: over.channels ?? [CHANNEL] }],
    } as unknown as AgentConfig,
    version: 1,
    invokeUrl: "https://api.example.com/x",
    apiKeyHash: "h",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metrics: { invocations: 0, lastInvokedAt: null },
    slackSecrets:
      over.botToken === null ? undefined : { botToken: over.botToken ?? FAKE_BOT_TOKEN, signingSecret: "s" },
  };
}

describe("parseSlackSessionId", () => {
  it("round-trips a channel and thread ts", () => {
    expect(parseSlackSessionId(SESSION)).toEqual({ channel: CHANNEL, threadTs: THREAD });
  });

  /**
   * Every id we mint must satisfy the platform's own validator - AgentCore's charset excludes
   * the DOT in Slack's thread_ts, and a short channel id would fall under the 33-char floor.
   * These pass today even when malformed (the runtime-facing id is a hash and the poll route
   * doesn't validate), so without this test the trap would only spring when something
   * downstream starts validating.
   */
  it("mints ids that satisfy isValidSessionId, and round-trips each one", () => {
    const cases: Array<[string, string]> = [
      ["C0000000001", "1700000000.000100"],
      ["C123", "1700000000.000100"], // short channel → needs padding
      ["G0000000001", "1700000000.000000"], // a ts ending in zeros must survive intact
      ["C00000000000000000001", "1799999999.999999"],
    ];
    for (const [channel, ts] of cases) {
      const id = slackSessionId(channel, ts);
      expect(isValidSessionId(id), `not AgentCore-compliant: ${id}`).toBe(true);
      expect(parseSlackSessionId(id), `did not round-trip: ${id}`).toEqual({ channel, threadTs: ts });
    }
  });

  it("returns null for a non-Slack session, so Slack tools can't act on an API run", () => {
    expect(parseSlackSessionId("abcdefghijklmnopqrstuvwxyz0123456")).toBeNull();
    expect(parseSlackSessionId("slack-")).toBeNull();
    expect(parseSlackSessionId("slack-C123")).toBeNull();
  });
});

describe("callSlack", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    getAgent.mockResolvedValue(record());
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true, ts: "1.2" }), status: 200 });
  });
  afterEach(() => vi.unstubAllGlobals());

  /**
   * The capability-scoping claim: the target channel and thread come from the SESSION ID, and
   * the request body has no channel field at all. A prompt-injected agent has no parameter to
   * aim somewhere else.
   */
  it("posts to the channel+thread derived from the session id", async () => {
    await callSlack("agent-000000", SESSION, { action: "reply", text: "hello" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toMatchObject({ channel: CHANNEL, thread_ts: THREAD, text: "hello" });
  });

  it("sends the bot token as a bearer header, never in the body", async () => {
    await callSlack("agent-000000", SESSION, { action: "reply", text: "x" });
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe(`Bearer ${FAKE_BOT_TOKEN}`);
    expect((init as { body: string }).body).not.toContain(FAKE_BOT_TOKEN);
  });

  it("maps each status to its reaction", async () => {
    for (const status of Object.keys(SLACK_STATUS_EMOJI) as Array<keyof typeof SLACK_STATUS_EMOJI>) {
      fetchMock.mockClear();
      await callSlack("agent-000000", SESSION, { action: "set_status", status });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://slack.com/api/reactions.add");
      expect(JSON.parse((init as { body: string }).body)).toMatchObject({
        channel: CHANNEL,
        timestamp: THREAD,
        name: SLACK_STATUS_EMOJI[status],
      });
    }
  });

  /**
   * The bug this fixes: for a mention INSIDE a thread, the session's thread key is the thread
   * PARENT - often someone else's message, possibly days old. Reacting to it decorated the wrong
   * message while the message that actually invoked the agent got nothing.
   */
  it("reacts to the message that invoked the agent, not the thread root", async () => {
    const invokingTs = "1700000000.000900";
    await callSlack("agent-000000", SESSION, { action: "set_status", status: "working" }, invokingTs);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({
      channel: CHANNEL,
      timestamp: invokingTs,
    });
  });

  it("falls back to the thread root when no reply target was minted", async () => {
    await callSlack("agent-000000", SESSION, { action: "set_status", status: "done" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({ timestamp: THREAD });
  });

  /** A reply always goes to the THREAD, whatever message invoked it - that's the conversation. */
  it("replies in the thread even when the invoking message differs", async () => {
    await callSlack("agent-000000", SESSION, { action: "reply", text: "hi" }, "1700000000.000900");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({ thread_ts: THREAD });
  });

  it("reads the thread it was called into, oldest first", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        messages: [
          { user: "U1", text: "the deploy failed", ts: "1.1" },
          { user: "U2", text: "can you fix this?", ts: "1.2" },
        ],
      }),
      status: 200,
    });
    const res = await callSlack("agent-000000", SESSION, { action: "read_thread" });
    expect(res).toMatchObject({
      ok: true,
      messages: [
        { user: "U1", text: "the deploy failed" },
        { user: "U2", text: "can you fix this?" },
      ],
    });
    // Scoped to the session's own thread - no channel or ts parameter the agent could supply.
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(`channel=${CHANNEL}`);
    expect(String(url)).toContain(`ts=${THREAD}`);
  });

  it("flags a truncated thread rather than implying it saw everything", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: true, messages: [], has_more: true }),
      status: 200,
    });
    expect(await callSlack("agent-000000", SESSION, { action: "read_thread" })).toMatchObject({
      truncated: true,
    });
  });

  it("refuses to act on a non-Slack session", async () => {
    const res = await callSlack("agent-000000", "abcdefghijklmnopqrstuvwxyz0123456", {
      action: "reply",
      text: "x",
    });
    expect(res).toMatchObject({ error: expect.stringContaining("not a Slack session") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * Defence in depth: the channel came from the token, but if the user has since removed it
   * from the allowlist a live thread must stop being answerable.
   */
  it("refuses a channel that has been removed from the allowlist mid-thread", async () => {
    getAgent.mockResolvedValue(record({ channels: ["C0000000999"] }));
    const res = await callSlack("agent-000000", SESSION, { action: "reply", text: "x" });
    expect(res).toMatchObject({ error: expect.stringContaining("no longer allowed") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a reply outside the list when allChannels is set", async () => {
    // The token carries the channel, but the allowlist is re-read on every call - so this flag
    // has to be honoured here too, or a reply would fail after the run had already started.
    const base = record({ channels: [] });
    getAgent.mockResolvedValue({
      ...base,
      config: {
        ...base.config,
        triggers: [{ type: "api" }, { type: "slack", channels: [], allChannels: true }],
      } as unknown as AgentConfig,
    });
    const res = await callSlack("agent-000000", SESSION, { action: "reply", text: "hi" });
    expect(res).toMatchObject({ ok: true });
  });

  it("returns an error+hint (never throws) when Slack is not configured", async () => {
    getAgent.mockResolvedValue(record({ botToken: null }));
    const res = await callSlack("agent-000000", SESSION, { action: "reply", text: "x" });
    expect(res).toMatchObject({ error: expect.any(String), hint: expect.any(String) });
  });

  it("turns Slack's ok:false into an error+hint the model can act on", async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: false, error: "not_in_channel" }), status: 200 });
    const res = await callSlack("agent-000000", SESSION, { action: "reply", text: "x" });
    expect(res).toMatchObject({ hint: expect.stringContaining("/invite") });
  });

  it("does not throw when Slack is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    const res = await callSlack("agent-000000", SESSION, { action: "reply", text: "x" });
    expect(res).toMatchObject({ error: expect.stringContaining("could not reach Slack") });
  });

  it("rejects an empty reply and an unknown status without calling Slack", async () => {
    expect(await callSlack("agent-000000", SESSION, { action: "reply", text: "   " })).toMatchObject({
      error: expect.stringContaining("text is required"),
    });
    expect(
      await callSlack("agent-000000", SESSION, { action: "set_status", status: "bogus" as never }),
    ).toMatchObject({ error: expect.stringContaining("unknown status") });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
