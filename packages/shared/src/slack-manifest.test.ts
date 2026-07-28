import { describe, expect, it } from "vitest";
import {
  SLACK_BOT_SCOPES,
  slackAppName,
  slackManifest,
  slackRequestUrl,
} from "./slack-manifest.js";

const input = {
  agentName: "deploy-bot",
  description: "Watches deploys",
  apiOrigin: "https://api.example.com",
  agentId: "agent-000000",
};

describe("slackRequestUrl", () => {
  it("puts the agentId in the PATH", () => {
    expect(slackRequestUrl("https://api.example.com", "agent-000000")).toBe(
      "https://api.example.com/webhooks/slack/agent-000000",
    );
  });

  it("tolerates a trailing slash on the origin", () => {
    expect(slackRequestUrl("https://api.example.com/", "a1")).toBe(
      "https://api.example.com/webhooks/slack/a1",
    );
  });
});

describe("slackAppName", () => {
  it("uses the agent name", () => {
    expect(slackAppName("deploy-bot")).toBe("deploy-bot");
  });

  it("truncates to Slack's 35-char limit rather than letting Slack reject it", () => {
    expect(slackAppName("x".repeat(50))).toHaveLength(35);
  });

  it("falls back to a usable name when the agent name is blank", () => {
    expect(slackAppName("   ")).toBe("agency-agent");
  });
});

describe("slackManifest", () => {
  it("bakes in the request url, so nothing is left to toggle after creation", () => {
    const m = slackManifest(input) as Record<string, any>;
    expect(m.settings.event_subscriptions.request_url).toBe(
      "https://api.example.com/webhooks/slack/agent-000000",
    );
    expect(m.settings.event_subscriptions.bot_events).toEqual(["app_mention"]);
  });

  it("requests the scopes every API method we call actually needs", () => {
    const m = slackManifest(input) as Record<string, any>;
    expect(m.oauth_config.scopes.bot).toEqual([...SLACK_BOT_SCOPES]);
  });

  /**
   * conversations.info - which validates a channel against the connected workspace at setup -
   * requires channels:read/groups:read. The *:history scopes do NOT imply them, so an earlier
   * version of this manifest would have failed channel validation for every user.
   */
  it("requests the read scopes conversations.info needs, so channel validation works", () => {
    const scopes = (slackManifest(input) as Record<string, any>).oauth_config.scopes.bot;
    expect(scopes).toContain("channels:read");
    expect(scopes).toContain("groups:read"); // and this is what makes PRIVATE channels usable
  });

  /** A token that can do more than the code does is blast radius the feature never uses. */
  it("requests nothing it has no call site for", () => {
    const scopes: string[] = (slackManifest(input) as Record<string, any>).oauth_config.scopes.bot;
    // We call exactly four methods: auth.test, conversations.info, chat.postMessage, reactions.add.
    for (const unused of ["files:read", "files:write", "channels:history", "groups:history", "users:read"]) {
      expect(scopes, `${unused} has no call site`).not.toContain(unused);
    }
  });

  it("names the bot after the agent - the bot IS the agent's identity", () => {
    const m = slackManifest(input) as Record<string, any>;
    expect(m.display_information.name).toBe("deploy-bot");
    expect(m.features.bot_user.display_name).toBe("deploy-bot");
  });

  it("falls back to a self-describing description when the agent has none", () => {
    const m = slackManifest({ ...input, description: undefined }) as Record<string, any>;
    expect(m.display_information.description).toContain("deploy-bot");
  });

  it("caps the description, which Slack length-limits", () => {
    const m = slackManifest({ ...input, description: "y".repeat(300) }) as Record<string, any>;
    expect(m.display_information.description.length).toBeLessThanOrEqual(140);
  });

  it("does not enable socket mode - it would stop events reaching our URL", () => {
    const m = slackManifest(input) as Record<string, any>;
    expect(m.settings.socket_mode_enabled).toBe(false);
  });

});
