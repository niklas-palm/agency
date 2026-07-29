import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AgentConfig } from "@agency/shared";
import {
  missingRequiredScopes,
  slackAuthTest,
  slackChannelInfo,
  slackSetupState,
  withSlackVerification,
} from "./slack-setup.js";

/**
 * Obviously-synthetic stand-ins. Nothing validates a token's FORMAT, so these carry no
 * `xoxb-` prefix - a real-looking literal in a fixture trips secret scanners for no gain.
 */
const FAKE_BOT_TOKEN = "bot-token-for-tests-000000";
const FAKE_BAD_TOKEN = "rejected-token-000000";

function agent(over: {
  channels?: string[];
  urlVerified?: boolean;
  botToken?: string;
  teamId?: string;
  noTrigger?: boolean;
}) {
  const slack = {
    type: "slack",
    channels: over.channels ?? [],
    ...(over.urlVerified ? { urlVerified: true } : {}),
    ...(over.teamId ? { teamId: over.teamId } : {}),
  };
  return {
    id: "agent-000000",
    orgId: "org-000000",
    createdBy: "user-000000",
    shared: false,
    config: {
      name: "a",
      triggers: over.noTrigger ? [{ type: "api" }] : [{ type: "api" }, slack],
    } as unknown as AgentConfig,
    version: 1,
    invokeUrl: "https://api.example.com/x",
    apiKeyHash: "h",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metrics: { invocations: 0, lastInvokedAt: null },
    ...(over.botToken ? { slackSecrets: { botToken: over.botToken, signingSecret: "s" } } : {}),
  };
}

describe("slackSetupState", () => {
  it("is null when the agent has no Slack trigger", () => {
    expect(slackSetupState(agent({ noTrigger: true }))).toBeNull();
  });

  it("walks the states in order as setup progresses", () => {
    expect(slackSetupState(agent({}))).toBe("manifest_ready");
    expect(slackSetupState(agent({ urlVerified: true }))).toBe("url_verified");
    // token stored but auth.test hasn't landed a teamId yet
    expect(slackSetupState(agent({ urlVerified: true, botToken: FAKE_BOT_TOKEN }))).toBe("needs_bot_token");
    expect(slackSetupState(agent({ urlVerified: true, botToken: FAKE_BOT_TOKEN, teamId: "T1" }))).toBe("verified");
    expect(
      slackSetupState(agent({ urlVerified: true, botToken: FAKE_BOT_TOKEN, teamId: "T1", channels: ["C1"] })),
    ).toBe("live");
  });

  /**
   * A connected app with no allowed channel answers NOWHERE. It must not read as `live`, or the
   * UI would tell the user they're done while every mention is silently dropped.
   */
  it("is not live without a channel, even when fully connected", () => {
    expect(slackSetupState(agent({ botToken: FAKE_BOT_TOKEN, teamId: "T1", channels: [] }))).toBe("verified");
  });
});

describe("slackAuthTest", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  function reply(body: unknown, scopes?: string) {
    return {
      json: async () => body,
      headers: new Headers(scopes ? { "x-oauth-scopes": scopes } : {}),
      status: 200,
    };
  }

  it("returns the workspace and the GRANTED scopes from the header", async () => {
    fetchMock.mockResolvedValue(
      reply({ ok: true, team_id: "T0000000001", team: "Example", user_id: "U0000000BOT" },
        "app_mentions:read, chat:write ,groups:read"),
    );
    const res = await slackAuthTest(FAKE_BOT_TOKEN);
    expect(res).toEqual({
      ok: true,
      teamId: "T0000000001",
      teamName: "Example",
      botUserId: "U0000000BOT",
      // trimmed and split - Slack's header is comma-separated with irregular spacing
      grantedScopes: ["app_mentions:read", "chat:write", "groups:read"],
    });
  });

  it("surfaces Slack's own error with an actionable hint", async () => {
    fetchMock.mockResolvedValue(reply({ ok: false, error: "invalid_auth" }));
    const res = await slackAuthTest(FAKE_BAD_TOKEN);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.hint).toMatch(/xoxb-/);
  });

  it("treats a missing team_id as a failure rather than storing a partial record", async () => {
    fetchMock.mockResolvedValue(reply({ ok: true, user_id: "U1" }));
    expect((await slackAuthTest(FAKE_BOT_TOKEN)).ok).toBe(false);
  });

  it("does not throw when Slack is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    const res = await slackAuthTest(FAKE_BOT_TOKEN);
    expect(res.ok).toBe(false);
  });

  it("has no granted scopes when the header is absent, rather than failing", async () => {
    fetchMock.mockResolvedValue(reply({ ok: true, team_id: "T1", team: "E", user_id: "U1" }));
    const res = await slackAuthTest(FAKE_BOT_TOKEN);
    expect(res.ok && res.grantedScopes).toEqual([]);
  });
});

describe("slackChannelInfo", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  const reply = (body: unknown) => ({ json: async () => body, status: 200, headers: new Headers() });

  it("resolves a channel in the expected workspace", async () => {
    fetchMock.mockResolvedValue(
      reply({ ok: true, channel: { id: "C0000000001", name: "deploys", is_private: false, context_team_id: "T1" } }),
    );
    expect(await slackChannelInfo(FAKE_BOT_TOKEN, "C0000000001", "T1")).toEqual({
      id: "C0000000001",
      name: "deploys",
      isPrivate: false,
    });
  });

  it("resolves a PRIVATE channel - private channels are supported", async () => {
    fetchMock.mockResolvedValue(
      reply({ ok: true, channel: { id: "G0000000001", name: "secret", is_private: true, context_team_id: "T1" } }),
    );
    const res = await slackChannelInfo(FAKE_BOT_TOKEN, "G0000000001", "T1");
    expect(res).toMatchObject({ id: "G0000000001", isPrivate: true });
  });

  /**
   * The failure we hit for real: a well-formed channel id from ANOTHER workspace. Accepting it
   * produces an agent that looks configured and silently ignores every mention.
   */
  it("refuses a channel belonging to a different workspace", async () => {
    fetchMock.mockResolvedValue(
      reply({ ok: true, channel: { id: "C0000000001", name: "x", context_team_id: "T_OTHER" } }),
    );
    const res = await slackChannelInfo(FAKE_BOT_TOKEN, "C0000000001", "T1");
    expect(res).toMatchObject({ ok: false });
    if ("hint" in res) expect(res.hint).toMatch(/workspace-specific/);
  });

  it("accepts a payload with no context_team_id rather than inventing a failure", async () => {
    // The token already scopes us to one workspace; an older payload shape shouldn't block setup.
    fetchMock.mockResolvedValue(reply({ ok: true, channel: { id: "C0000000001", name: "x" } }));
    expect(await slackChannelInfo(FAKE_BOT_TOKEN, "C0000000001", "T1")).toMatchObject({ id: "C0000000001" });
  });

  it("gives a private-channel-specific hint on channel_not_found", async () => {
    fetchMock.mockResolvedValue(reply({ ok: false, error: "channel_not_found" }));
    const res = await slackChannelInfo(FAKE_BOT_TOKEN, "C0000000009", "T1");
    expect(res).toMatchObject({ ok: false });
    if ("hint" in res) expect(res.hint).toMatch(/invite the app/i);
  });
});

describe("withSlackVerification", () => {
  it("records the workspace details without disturbing the channel list", () => {
    const out = withSlackVerification(
      { type: "slack", channels: ["C1"], urlVerified: true },
      { ok: true, teamId: "T1", teamName: "E", botUserId: "U1", grantedScopes: ["chat:write"] },
    );
    expect(out).toEqual({
      type: "slack",
      channels: ["C1"],
      urlVerified: true,
      teamId: "T1",
      teamName: "E",
      botUserId: "U1",
      grantedScopes: ["chat:write"],
    });
  });
});


/**
 * The check that would have prevented every round of this feature's silence.
 *
 * Pattern across all of them: the manifest was right, the TOKEN wasn't - because Slack grants what
 * the app had at INSTALL time, and neither warns nor errors when that's less than the manifest
 * asked for. We read `auth.test`'s granted list, stored it, displayed it, and made no decision with
 * it, so setup reported "live" for an agent Slack would never deliver a mention to.
 */
describe("missingRequiredScopes", () => {
  const FULL = [
    "app_mentions:read", "channels:history", "groups:history", "channels:read",
    "groups:read", "chat:write", "reactions:write", "files:read", "files:write", "users:read",
  ];

  it("passes a token granted the full set", () => {
    expect(missingRequiredScopes(FULL)).toEqual([]);
  });

  /** The exact token that reached "live" and produced silence, twice. */
  it("catches the 2-scope token that shipped as live", () => {
    expect(missingRequiredScopes(["channels:history", "chat:write"])).toEqual([
      "app_mentions:read",
      "reactions:write",
    ]);
  });

  it("treats app_mentions:read as required - Slack won't DELIVER without it", () => {
    expect(missingRequiredScopes(FULL.filter((s) => s !== "app_mentions:read"))).toContain(
      "app_mentions:read",
    );
  });

  it("requires what the PLATFORM does on every run, not just what the agent might call", () => {
    // chat:write posts the answer; reactions:write is 👀 and the status circles. Both are the
    // platform's own behaviour, so missing them means silence rather than a degraded tool.
    expect(missingRequiredScopes(FULL.filter((s) => s !== "chat:write"))).toContain("chat:write");
    expect(missingRequiredScopes(FULL.filter((s) => s !== "reactions:write"))).toContain("reactions:write");
  });

  /** Optional scopes degrade honestly - the tool fails with a hint - so they must NOT block setup. */
  it("does not require the scopes whose absence only degrades a tool", () => {
    for (const optional of ["channels:history", "groups:history", "files:read", "files:write", "users:read"]) {
      expect(missingRequiredScopes(FULL.filter((s) => s !== optional)), optional).toEqual([]);
    }
  });

  it("reports everything missing at once, so one reinstall fixes it all", () => {
    expect(missingRequiredScopes([])).toEqual(["app_mentions:read", "chat:write", "reactions:write"]);
  });
});





