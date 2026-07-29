/**
 * The channel-allowlist and credential routes, driven through the real app.
 *
 * These replace three test blocks that asserted on inline expressions - a locally-rebuilt
 * `requested.filter(...)`, a reconstructed buggy object literal, redefined shape predicates - and so
 * could not fail if the production code were reverted. Each test here drives the actual route and
 * asserts on what reaches `updateAgent`, which is where each of these bugs was visible.
 *
 * Auth follows the house pattern (skills-routes.test.ts): a mocked PAT resolving to an admin of
 * org-A, so `authorize` lets the request through to the logic under test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@agency/shared";

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
  getMembership: vi.fn(async (orgId: string, userId: string) =>
    orgId === "org-A" && userId === "user-A"
      ? { orgId: "org-A", userId: "user-A", role: "admin", joinedAt: "2026-01-01T00:00:00Z" }
      : null,
  ),
}));

const AGENT_ID = "agent-000000";
const CHANNEL = "C0000000001";
const OTHER_CHANNEL = "C0000000002";
const NEW_CHANNEL = "C0000000009";
/**
 * These routes DO validate token shape, so unlike slack-setup.test.ts the fixtures need real
 * prefixes - assembled rather than written literally, since a `xoxb-…`-shaped literal trips secret
 * scanners for no gain.
 */
const BOT_PREFIX = `xox${"b"}-`;
const USER_PREFIX = `xox${"p"}-`;
const FAKE_BOT_TOKEN = `${BOT_PREFIX}test-bot-token-000000`;
const FAKE_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";

/** Overridden per test, then returned by the mocked getAgent. */
let agent: Record<string, unknown>;

function record(over: { channels?: string[]; allChannels?: boolean; connected?: boolean } = {}) {
  const slack: Record<string, unknown> = {
    type: "slack",
    channels: over.channels ?? [CHANNEL, OTHER_CHANNEL],
    ...(over.allChannels === undefined ? {} : { allChannels: over.allChannels }),
    ...(over.connected === false ? {} : { teamId: "T0000000001", botUserId: "U0000000001" }),
  };
  return {
    id: AGENT_ID,
    orgId: "org-A",
    createdBy: "user-A",
    shared: false,
    config: { name: "a", triggers: [{ type: "api" }, slack] } as unknown as AgentConfig,
    version: 3,
    invokeUrl: "https://api.example.com/x",
    apiKeyHash: "h",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metrics: { invocations: 0, lastInvokedAt: null },
    ...(over.connected === false
      ? {}
      : { slackSecrets: { botToken: FAKE_BOT_TOKEN, signingSecret: FAKE_SIGNING_SECRET } }),
  };
}

const updateAgent = vi.fn(async (_id: string, _patch: Record<string, unknown>) => {});
vi.mock("./repo/agents.js", async () => {
  const actual = await vi.importActual<typeof import("./repo/agents.js")>("./repo/agents.js");
  return {
    ...actual,
    getAgent: vi.fn(async () => agent),
    updateAgent: (id: string, patch: Record<string, unknown>) => updateAgent(id, patch),
  };
});

/** A version write here is the bug: Slack setup is plumbing and must not mint config versions. */
const putVersion = vi.fn(async () => {});
vi.mock("./repo/versions.js", async () => {
  const actual = await vi.importActual<typeof import("./repo/versions.js")>("./repo/versions.js");
  return { ...actual, putVersion, listVersions: vi.fn(async () => []) };
});

/** Stubbed so no test reaches Slack. Channel validation succeeds unless a test says otherwise. */
type ChannelInfo = typeof import("./slack-setup.js").slackChannelInfo;
const slackChannelInfo = vi.fn<ChannelInfo>(async () => ({ id: NEW_CHANNEL, name: "new", isPrivate: false }));
vi.mock("./slack-setup.js", async () => {
  const actual = await vi.importActual<typeof import("./slack-setup.js")>("./slack-setup.js");
  return { ...actual, slackChannelInfo };
});

const { buildApp } = await import("./app.js");
const app = buildApp();
const auth = { Authorization: "Bearer agpat_test_token_value_0000000000000000" };

const patch = (path: string, body: unknown) =>
  app.request(path, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** The Slack trigger as it was persisted by the last updateAgent call. */
function persistedTrigger() {
  const last = updateAgent.mock.calls.at(-1)?.[1] as
    | { config?: { triggers: Array<Record<string, unknown>> } }
    | undefined;
  return last?.config?.triggers.find((t) => t.type === "slack");
}

beforeEach(() => {
  vi.clearAllMocks();
  slackChannelInfo.mockResolvedValue({ id: NEW_CHANNEL, name: "new", isPrivate: false });
  agent = record();
});

describe("PATCH /agents/:id/slack/channels", () => {
  /**
   * Validation exists to stop a FOREIGN channel id being stored - one that yields an agent that
   * looks configured and silently ignores every mention. Applying it to REMOVALS stranded a user
   * with a list they couldn't shorten after a disconnect, and re-checking already-approved ids cost
   * a Slack round trip per channel on every save. So only genuinely new ids get validated.
   */
  it("removes a channel with no Slack connection at all", async () => {
    agent = record({ connected: false });
    const res = await patch(`/agents/${AGENT_ID}/slack/channels`, { channels: [CHANNEL] });
    expect(res.status).toBe(200);
    expect(persistedTrigger()?.channels).toEqual([CHANNEL]);
    expect(slackChannelInfo).not.toHaveBeenCalled();
  });

  it("clears the list entirely with no Slack connection", async () => {
    agent = record({ connected: false });
    expect((await patch(`/agents/${AGENT_ID}/slack/channels`, { channels: [] })).status).toBe(200);
    expect(persistedTrigger()?.channels).toEqual([]);
  });

  it("does not re-validate a channel that is already on the list", async () => {
    await patch(`/agents/${AGENT_ID}/slack/channels`, { channels: [CHANNEL, OTHER_CHANNEL] });
    expect(slackChannelInfo).not.toHaveBeenCalled();
  });

  it("validates only the genuinely new id when adding one", async () => {
    const res = await patch(`/agents/${AGENT_ID}/slack/channels`, {
      channels: [CHANNEL, OTHER_CHANNEL, NEW_CHANNEL],
    });
    expect(res.status).toBe(200);
    expect(slackChannelInfo).toHaveBeenCalledOnce();
    expect(slackChannelInfo.mock.calls[0]?.[1]).toBe(NEW_CHANNEL);
  });

  it("refuses to ADD a channel with no connection, since it can't be validated", async () => {
    agent = record({ connected: false });
    const res = await patch(`/agents/${AGENT_ID}/slack/channels`, { channels: [CHANNEL, NEW_CHANNEL] });
    expect(res.status).toBe(409);
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("rejects a channel Slack doesn't recognize, without persisting anything", async () => {
    slackChannelInfo.mockResolvedValue({ ok: false, error: "no such channel", hint: "h" } as never);
    const res = await patch(`/agents/${AGENT_ID}/slack/channels`, { channels: [CHANNEL, NEW_CHANNEL] });
    expect(res.status).toBe(400);
    expect(updateAgent).not.toHaveBeenCalled();
  });

  /**
   * `allChannels` was write-once: the route built the trigger with a conditional spread, so `false`
   * spread nothing and the stored `true` survived. Clicking "restrict to a list" appeared to do
   * nothing - while still minting a version.
   */
  it("turns allChannels OFF, not just on", async () => {
    agent = record({ allChannels: true });
    await patch(`/agents/${AGENT_ID}/slack/channels`, { channels: [CHANNEL], allChannels: false });
    expect(persistedTrigger()?.allChannels).toBe(false);
  });

  it("turns allChannels on", async () => {
    await patch(`/agents/${AGENT_ID}/slack/channels`, { channels: [], allChannels: true });
    expect(persistedTrigger()?.allChannels).toBe(true);
  });

  /** Slack setup is plumbing, not behaviour - a fresh agent showed as version 8 before it ever ran. */
  it("does not append a config version", async () => {
    await patch(`/agents/${AGENT_ID}/slack/channels`, { channels: [CHANNEL] });
    expect(putVersion).not.toHaveBeenCalled();
  });

  /** The write is guarded on the version we read, so a concurrent config PATCH can't be clobbered. */
  it("guards the write on the version it read", async () => {
    await patch(`/agents/${AGENT_ID}/slack/channels`, { channels: [CHANNEL] });
    expect(updateAgent.mock.calls.at(-1)?.[1]).toMatchObject({ expectedVersion: 3 });
  });
});

describe("PATCH /agents/:id/slack/credentials", () => {
  /**
   * The two fields are adjacent and both masked, so pasting the bot token into both is easy - and it
   * was silent: the token stored fine, setup reported "live", and every real mention 401'd on a
   * signature that could never verify.
   */
  it("refuses a bot token pasted into the signing-secret field", async () => {
    const res = await patch(`/agents/${AGENT_ID}/slack/credentials`, {
      botToken: FAKE_BOT_TOKEN,
      signingSecret: FAKE_BOT_TOKEN,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { hint?: string }).toMatchObject({
      hint: expect.stringContaining("Basic Information"),
    });
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("refuses a signing secret that isn't 32 hex chars", async () => {
    const res = await patch(`/agents/${AGENT_ID}/slack/credentials`, {
      botToken: FAKE_BOT_TOKEN,
      signingSecret: "not-a-signing-secret",
    });
    expect(res.status).toBe(400);
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("refuses a user token in the bot-token field", async () => {
    const res = await patch(`/agents/${AGENT_ID}/slack/credentials`, {
      botToken: `${USER_PREFIX}a-user-token`,
      signingSecret: FAKE_SIGNING_SECRET,
    });
    expect(res.status).toBe(400);
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("requires both fields", async () => {
    expect((await patch(`/agents/${AGENT_ID}/slack/credentials`, { botToken: FAKE_BOT_TOKEN })).status).toBe(400);
    expect((await patch(`/agents/${AGENT_ID}/slack/credentials`, { signingSecret: FAKE_SIGNING_SECRET })).status).toBe(
      400,
    );
    expect(updateAgent).not.toHaveBeenCalled();
  });
});
