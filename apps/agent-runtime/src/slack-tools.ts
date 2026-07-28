/**
 * Slack tools: how an agent answers in the thread that invoked it, WITHOUT ever holding the
 * bot token. Wired only when the invoke payload says this run came from Slack - the trigger
 * IS the signal, exactly as integration tools are wired only when integrations were resolved.
 *
 * Both tools POST to the control-plane (`/internal/slack/call`) with the per-session ingest
 * token, and the control-plane derives the target channel + thread from that token's
 * `sessionId`. So there is no channel parameter here to get wrong or to poison: the agent can
 * only ever reply where it was called.
 *
 * Platform convention: never throw. A thrown exception reaches the model as an opaque stack
 * trace; `{ error, hint }` lets it adapt.
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { postIngestRaw } from "./ingest.js";

/** Slack is normally fast; a hang here would hold the agent turn open. */
const SLACK_TIMEOUT_MS = 15_000;

/** Matches the control-plane's `SLACK_STATUS_EMOJI` keys. */
const STATUSES = ["working", "done", "failed", "needs_input"] as const;

async function call(body: Record<string, unknown>): Promise<unknown> {
  const res = await postIngestRaw("/internal/slack/call", body, SLACK_TIMEOUT_MS);
  if (!res?.ok) {
    return {
      error: `Slack call failed (${res?.status ?? "no response"})`,
      hint: "The platform holds the Slack credential; this is not something you can fix. Report it in your answer.",
    };
  }
  return res.json ?? { ok: true };
}

/**
 * Build the Slack tools. Returns an empty array when this run didn't come from Slack, so the
 * caller can spread unconditionally.
 */
export function buildSlackTools(fromSlack: boolean) {
  if (!fromSlack) return [];

  const reply = tool({
    name: "slack_reply",
    description:
      "Post a message into the Slack thread that invoked you. This is how the person who " +
      "mentioned you sees your answer - text you merely return does NOT reach Slack. Use " +
      "Slack mrkdwn: *bold*, _italic_, `code`, ```blocks```. Call this once with your final " +
      "answer; use slack_set_status for progress instead of posting partial updates.",
    inputSchema: z.object({
      text: z.string().min(1).describe("The message to post, in Slack mrkdwn."),
    }),
    callback: async ({ text }) => call({ action: "reply", text }),
  });

  const setStatus = tool({
    name: "slack_set_status",
    description:
      "Signal progress by reacting to the message that invoked you. 'working' when you start " +
      "something slow, 'done' when you've answered, 'failed' if you couldn't, 'needs_input' " +
      "if you're blocked on a question. Cheaper and less noisy than posting progress messages.",
    inputSchema: z.object({
      status: z.enum(STATUSES).describe("Which status to show."),
    }),
    callback: async ({ status }) => call({ action: "set_status", status }),
  });

  return [reply, setStatus];
}

/**
 * The Slack-specific system-prompt block, composed like ISOLATED_PROMPT. The model needs to be
 * told that returning text is not the same as posting it - this is the single most likely way a
 * Slack run "succeeds" while the user sees nothing.
 */
export const SLACK_PROMPT = [
  "You were invoked by someone mentioning you in a Slack thread.",
  "",
  "- Your reply reaches them ONLY if you call `slack_reply`. Text you return is not posted.",
  "- Reply in the thread you were called from - that is where `slack_reply` posts.",
  "- Use `slack_set_status` to show progress: 'working' when starting something slow, then",
  "  'done' or 'failed' at the end. Prefer a status reaction over chatty progress messages.",
  "- Slack formatting is mrkdwn, not Markdown: *bold*, _italic_, `code`, ```blocks```.",
  "  Links are <https://example.com|label>.",
  "- Be brief. A Slack thread is a conversation, not a report.",
].join("\n");
