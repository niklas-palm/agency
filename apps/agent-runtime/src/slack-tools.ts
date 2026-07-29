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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { postIngestRaw } from "./ingest.js";
import { workDir, sandboxed } from "./tools.js";

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
      "Post a message into the Slack thread you were summoned from. THIS IS HOW THE PERSON HEARS " +
      "FROM YOU. Your assistant text reaches nobody - only what you post here. ALWAYS use it for " +
      "your substantive answer, and for a progress note if the work will take a while. " +
      "Slack mrkdwn, not GitHub markdown: *bold* (single asterisks), _italic_, `code`, " +
      "```blocks```, <https://url|label> links, - bullets. NO # headings, NO **double asterisks**, " +
      "NO tables.",
    inputSchema: z.object({
      text: z.string().min(1).describe("The message to post, in Slack mrkdwn."),
    }),
    callback: async ({ text }) => call({ action: "reply", text }),
  });

  const setStatus = tool({
    name: "slack_set_status",
    description:
      "Set the thread's status reaction on the message that invoked you. The four are MUTUALLY " +
      "EXCLUSIVE - setting one clears the others, so the message always shows exactly one state. " +
      "🟡 'working' as soon as you know the answer will take more than a moment; then 🟢 'done' " +
      "when you have replied, 🔴 'failed' if you could not, or ❓ 'needs_input' if you are blocked " +
      "on a question. A status is not a substitute for slack_reply - it tells people whether to " +
      "wait, and your answer still has to be posted.",
    inputSchema: z.object({
      status: z.enum(STATUSES).describe("Which status to show."),
    }),
    callback: async ({ status }) => call({ action: "set_status", status }),
  });

  const readThread = tool({
    name: "slack_read_thread",
    description:
      "Read the Slack thread you were mentioned in, oldest message first. Call this FIRST whenever " +
      "the mention refers to something you can't see - 'fix this', 'why did that fail', 'as " +
      "discussed above'. You are given only the text of the mention itself, so without this you " +
      "are guessing at what the conversation was about.",
    inputSchema: z.object({}),
    callback: async () => call({ action: "read_thread" }),
  });

  const askUser = tool({
    name: "slack_ask_user",
    description:
      "Ask the person a question in the thread and STOP. Posts the question, sets the ❓ status, " +
      "and ends your turn - they must @-mention you again to continue. Use it when a request is " +
      "genuinely ambiguous or the decision is theirs, not to confirm routine steps. Guessing and " +
      "being wrong costs them more than being asked.",
    inputSchema: z.object({ text: z.string().min(1).describe("The question, in Slack mrkdwn.") }),
    callback: async ({ text }) => call({ action: "ask_user", text }),
  });

  const uploadFile = tool({
    name: "slack_upload_file",
    description:
      "Upload a file from your workspace into the thread - a log, a diff, a report, an image. " +
      "Prefer this over pasting a long block into a message: the person cannot see your workspace, " +
      "so a path is useless to them. Max ~3 MB.",
    inputSchema: z.object({
      path: z.string().describe("Relative path in your workspace, e.g. out/report.md"),
      filename: z.string().optional().describe("Name to show in Slack. Defaults to the file's name."),
    }),
    callback: async ({ path, filename }) => {
      // Confined to the workspace by the same helper write_file uses - an agent must not be able to
      // upload /proc/1/environ or an AWS credential file to a channel.
      const full = sandboxed(workDir(), path);
      if (!full) {
        return { error: "path escapes the workspace", hint: "Use a relative path inside your workspace." };
      }
      let content: string;
      try {
        content = (await readFile(full)).toString("base64");
      } catch {
        return { error: `cannot read ${path}`, hint: "Check the file exists - use run_bash to list it." };
      }
      return call({ action: "upload_file", content, filename: filename ?? path.split("/").pop() });
    },
  });

  const downloadFile = tool({
    name: "slack_download_file",
    description:
      "Download a file someone attached to THIS thread into your workspace so you can read it. " +
      "Call slack_read_thread first to find the file id - each message lists the files on it.",
    inputSchema: z.object({
      fileId: z.string().describe("File id from slack_read_thread."),
      path: z.string().describe("Where to write it in your workspace, e.g. in/attachment.csv"),
    }),
    callback: async ({ fileId, path }) => {
      const full = sandboxed(workDir(), path);
      if (!full) {
        return { error: "path escapes the workspace", hint: "Use a relative path inside your workspace." };
      }
      const res = (await call({ action: "download_file", fileId })) as {
        content?: string;
        file?: { name?: string; bytes?: number };
        error?: string;
      };
      if (res.error || typeof res.content !== "string") return res;
      try {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, Buffer.from(res.content, "base64"));
      } catch {
        return { error: `could not write ${path}`, hint: "Pick a different path in your workspace." };
      }
      // Deliberately does NOT return the content: it's on disk now, and echoing it back would put
      // the whole file in the model's context - the thing writing it to a file avoids.
      return { ok: true, path, bytes: res.file?.bytes, name: res.file?.name };
    },
  });

  return [reply, setStatus, readThread, askUser, uploadFile, downloadFile];
}
