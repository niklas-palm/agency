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
 * Scopes the bot needs - exactly one per API method we actually call, and no more. A token that
 * can do more than the code does is blast radius the feature never uses.
 *
 * `channels:read` + `groups:read` are the non-obvious pair: they're required by
 * `conversations.info`, which validates a channel against the connected workspace at setup. The
 * `*:history` scopes do NOT imply them (Slack's scope hierarchy is explicit about this), so
 * requesting history instead would fail channel validation for every user with `missing_scope`.
 * `groups:read` is also what lets a PRIVATE channel be validated and used.
 */
export const SLACK_BOT_SCOPES = [
  // Receive the @-mentions that invoke the agent.
  "app_mentions:read",
  // Resolve a channel at setup (conversations.info): public, then private.
  "channels:read",
  "groups:read",
  // Reply in the thread (chat.postMessage) and signal progress (reactions.add).
  "chat:write",
  "reactions:write",
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
  const name = slackAppName(input.agentName);
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
        display_name: slackBotName(input.agentName),
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
