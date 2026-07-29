import { describe, expect, it } from "vitest";
import {
  SLACK_BOT_SCOPES,
  slackAppName,
  slackBotName,
  slackNameProblem,
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

describe("slackBotName", () => {
  /**
   * The regression that cost a real debugging session: an agent named `Slack-bot` produced a
   * manifest Slack REFUSED, because `features.bot_user.display_name` allows only `a-z 0-9 - _ .`
   * The user renamed the bot by hand, and the handle they then @-mentioned no longer matched
   * anything we had stored.
   */
  it("lower-cases, so a capitalised agent name doesn't invalidate the manifest", () => {
    expect(slackBotName("Slack-bot")).toBe("slack-bot");
    expect(slackBotName("Deploy Helper")).toBe("deploy-helper");
  });

  it("replaces every disallowed character, collapsing runs", () => {
    expect(slackBotName("My Agent!! (v2)")).toBe("my-agent-v2");
    expect(slackBotName("a@@@b")).toBe("a-b");
  });

  it("keeps the characters Slack does allow", () => {
    expect(slackBotName("deploy_bot.v1-x")).toBe("deploy_bot.v1-x");
  });

  it("trims separators from the ends, which Slack also rejects", () => {
    expect(slackBotName("--agent--")).toBe("agent");
    expect(slackBotName("...agent...")).toBe("agent");
  });

  it("falls back rather than emitting an empty handle", () => {
    expect(slackBotName("!!!")).toBe("agency-agent");
    expect(slackBotName("   ")).toBe("agency-agent");
  });

  it("only ever emits Slack's allowed charset", () => {
    for (const name of ["Slack-bot", "My Agent!! (v2)", "ÄÖÜ agent", "a".repeat(120), "!!!"]) {
      expect(slackBotName(name), name).toMatch(/^[a-z0-9._-]+$/);
      expect(slackBotName(name).length).toBeLessThanOrEqual(80);
    }
  });
});

describe("slackNameProblem", () => {
  /**
   * Refusing beats rewriting here. Silently turning `slack-bot` into `bot` would recreate the
   * original failure - an app named one thing, a handle named another, and a mention matching
   * neither. The user renames the agent once and everything agrees.
   */
  it("refuses the names Slack reserves outright", () => {
    expect(slackNameProblem("slackbot")).toMatch(/reserves/i);
    expect(slackNameProblem("Slackbot")).toMatch(/reserves/i);
    expect(slackNameProblem("slack")).toMatch(/reserves/i);
  });

  it("refuses anything starting with slack, however punctuated", () => {
    for (const n of ["slack-bot", "Slack-bot", "slack_bot", "slack.bot", "slackdeploy", "SLACK BOT"]) {
      expect(slackNameProblem(n), n).not.toBeNull();
    }
  });

  it("says what to do instead, not just what's wrong", () => {
    // The message has to name the fix: the agent is renamed elsewhere, so "invalid" alone leaves
    // the user stuck on a step they can't act on.
    expect(slackNameProblem("slack-bot")).toMatch(/name the agent after what it does/i);
  });

  it("allows a normal name, including one that merely contains slack", () => {
    for (const n of ["deploy-helper", "oncall", "Deploy Bot", "my-slack-helper", "unslack"]) {
      expect(slackNameProblem(n), n).toBeNull();
    }
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

  it("names the app as written but the bot handle sanitized", () => {
    const m = slackManifest({ ...input, agentName: "Deploy Bot" }) as Record<string, any>;
    // The app name keeps the user's capitalisation and spaces - Slack allows both here.
    expect(m.display_information.name).toBe("Deploy Bot");
    // The handle can't: Slack rejects uppercase and spaces in a bot display_name.
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
