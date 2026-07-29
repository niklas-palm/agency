/**
 * The Slack app manifest we hand the user to paste.
 *
 * This is the whole setup UX. Slack's "create an app from a manifest" flow reads name,
 * scopes, event subscriptions AND the request URL out of one JSON document, which collapses
 * a dozen manual toggles into a single paste. Because our webhook origin is known at deploy
 * time, we can bake the URL in - so nothing is left for the user to type.
 *
 * Why the user pastes this rather than us calling `apps.manifest.create` ourselves: that API
 * needs an app-configuration token, which can create or modify ANY app in the user's
 * workspace, is single-use with a 12h rotation, and dies silently if a rotation isn't
 * persisted. Fine for a script an agent babysits; a support ticket in a self-service UI. The
 * manifest costs the user one extra paste and costs us no high-value credential at all.
 */

/**
 * Scopes the bot needs.
 *
 * The rule I applied first - "one scope per API method we call" - was too narrow, because it
 * described what the code did on day one rather than what a Slack agent has to be able to do. An
 * agent that can only read the words of one @-mention and post a reply is barely an agent: someone
 * says "can you fix this?" three messages into a thread and it has no idea what "this" is.
 *
 * So the set below is what the FEATURE needs, and each entry names the capability rather than the
 * call site. Anything genuinely unused is still excluded - a token that can do more than the
 * product does is blast radius nobody asked for.
 */
export const SLACK_BOT_SCOPES = [
  // Be invoked: receive the @-mentions that start a run.
  "app_mentions:read",

  // READ THE CONVERSATION. Without this the agent sees only the mention text, so a mention that
  // refers to what was said above ("fix this", "why did that fail?") is unanswerable. This is the
  // difference between a bot and a colleague, and it's why `*:history` is here despite no call
  // site on day one - `slack_read_thread` uses it.
  "channels:history",
  "groups:history",

  // Resolve a channel at setup (conversations.info) and list them for the picker
  // (conversations.list): public, then private.
  "channels:read",
  "groups:read",

  // Answer, and signal progress.
  "chat:write",
  "reactions:write",

  // Attach and read files: an agent that produces a diff, a log excerpt or a chart needs somewhere
  // to put it, and one asked about an uploaded file needs to read it. `files:write` also covers
  // posting a snippet too long for a message.
  "files:read",
  "files:write",

  // Resolve a user id to a name, so the agent can address people and attribute what it read
  // rather than emitting raw `U0…` ids.
  "users:read",
] as const;

/** Slack caps `display_information.name` at 35 characters. */
const MAX_APP_NAME = 35;

/** Slack caps `features.bot_user.display_name` at 80. */
const MAX_BOT_NAME = 80;

export interface SlackManifestInput {
  /** The agent's name - becomes the bot people @-mention. */
  agentName: string;
  /** The agent's description, if it has one - shown in Slack's app directory listing. */
  description?: string;
  /** Our public API origin, e.g. `https://api.example.com`. */
  apiOrigin: string;
  /** The agent's id - rides the webhook PATH (see `SlackTrigger`). */
  agentId: string;
  /**
   * What to call the bot, if not the agent's name. Sanitized the same way either way - Slack's
   * charset for a handle is narrow enough that a hand-typed value still needs normalizing.
   */
  botName?: string;
}

/**
 * The app's display name: <=35 chars, and not blank. Slack allows spaces and mixed case here,
 * so the agent's name passes through as the user wrote it.
 */
export function slackAppName(agentName: string): string {
  const trimmed = agentName.trim();
  if (!trimmed) return "agency-agent";
  return trimmed.length > MAX_APP_NAME ? trimmed.slice(0, MAX_APP_NAME) : trimmed;
}

/**
 * The BOT USER's handle - what people actually type after `@`. Slack's rules here are stricter
 * than for the app name: **only `a-z 0-9 - _ .`**, so uppercase and spaces are rejected outright.
 *
 * This is not cosmetic. An invalid value makes Slack refuse the whole manifest, so an agent named
 * with a capital letter - `Slack-bot`, say - produced an app the user had to rename by hand, and
 * the handle they then @-mentioned no longer matched anything we knew about.
 *
 * So we lower-case, replace runs of anything else with a single `-`, and trim stray separators.
 */
export function slackBotName(agentName: string): string {
  const handle = agentName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, MAX_BOT_NAME);
  return handle || "agency-agent";
}

/**
 * Why an agent name can't start with "slack".
 *
 * Slack reserves `slackbot` outright, and names in that space are both liable to be refused and
 * confusing to use: `@slack-deploy` reads as something Slack ships rather than something you run.
 * The handle IS how people address the agent, so a name that fights the platform is a bad name.
 *
 * We REFUSE rather than silently rewrite. A silent fix is what caused the original problem - the
 * app ended up with one name and the bot handle another, and the mention matched neither. Telling
 * the user costs one sentence; guessing costs an afternoon.
 */
export function slackNameProblem(agentName: string): string | null {
  const handle = slackBotName(agentName);
  if (handle === "slackbot" || handle === "slack") {
    return "Slack reserves this name. Pick something else - the name is what people @-mention.";
  }
  if (/^slack[-._]?/.test(handle)) {
    return (
      "A name starting with \"slack\" is reserved or confusing in Slack (it reads as something " +
      "Slack ships). Name the agent after what it DOES - \"deploy-helper\", \"oncall\" - since the " +
      "name is what people @-mention."
    );
  }
  return null;
}

/** The events URL for one agent. The agentId is in the PATH - see `SlackTrigger` for why. */
export function slackRequestUrl(apiOrigin: string, agentId: string): string {
  return `${apiOrigin.replace(/\/+$/, "")}/webhooks/slack/${agentId}`;
}

/**
 * Build the complete manifest. Everything Slack needs is here: no post-creation toggling,
 * which is the failure mode of a "manifest minus events" approach (the user forgets, and the
 * app looks installed but never delivers an event).
 */
export function slackManifest(input: SlackManifestInput): Record<string, unknown> {
  const name = slackAppName(input.botName?.trim() || input.agentName);
  const description =
    input.description?.trim().slice(0, 140) || `An Agency agent. Mention @${name} to run it.`;
  return {
    display_information: {
      name,
      description,
      background_color: "#1f2933",
    },
    features: {
      bot_user: {
        // NOT `name`: the bot handle has a stricter charset than the app name (see slackBotName).
        display_name: slackBotName(input.botName?.trim() || input.agentName),
        // The agent replies in-thread; it doesn't need to appear always-online.
        always_online: false,
      },
    },
    oauth_config: {
      scopes: { bot: [...SLACK_BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: {
        request_url: slackRequestUrl(input.apiOrigin, input.agentId),
        // Only app_mention: the agent acts when addressed. Subscribing to every message in
        // every channel would multiply cost and invite loops for no added capability.
        bot_events: ["app_mention"],
      },
      // Nothing in v1 uses interactive components or slash commands, and an unused
      // interactivity URL is one more thing that can be misconfigured.
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
