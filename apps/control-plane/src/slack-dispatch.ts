/**
 * Starting an agent run from a Slack mention.
 *
 * Shares the resolve → mint → invoke path with the API route (`resolve-attachments.ts` +
 * `mintSessionToken` + the `AgentInvoker` seam), so a Slack-triggered run is the same kind of
 * run as any other: same trajectory, same metrics, same version snapshot. The only differences
 * are that the prompt comes from a mention and that `fromSlack` rides the payload so the
 * runtime wires its Slack tools.
 *
 * Mid-turn injection falls out for free. One Slack thread is one session id, so a follow-up
 * mention in a live thread lands on the SAME session - and the runtime's mailbox injects it
 * into the running turn rather than starting a second one. That's the platform's load-bearing
 * feature surfacing as something a Slack user can feel, with no extra machinery here.
 */
import type { AgentInvoker } from "./invoker/invoker.js";
import type { AgentRecord } from "./repo/agents.js";
import { resolveSkills, resolveIntegrations } from "./resolve-attachments.js";
import { mintSessionToken } from "./session-token.js";
import { recordPrompt } from "./repo/trajectory.js";
import { bumpInvocation } from "./repo/metrics.js";

export interface SlackDispatchArgs {
  record: AgentRecord;
  prompt: string;
  sessionId: string;
  /** The ts of the message that invoked the agent - the reaction target, carried in the token. */
  messageTs: string;
  /** Who mentioned the agent, so the turn frame can name them. */
  slackUser?: string;
}

/**
 * Resolve attachments, mint the capability token, and invoke. Errors propagate to the caller,
 * which decides what to do - the webhook route swallows them (Slack has already been acked and
 * would only retry into the same failure) while the trajectory records what happened.
 */
export async function dispatchSlackRun(
  invoker: AgentInvoker,
  { record, prompt, sessionId, messageTs, slackUser }: SlackDispatchArgs,
): Promise<void> {
  const [skills, integrations] = await Promise.all([
    resolveSkills(record.orgId, record.createdBy, record.config.skillIds),
    resolveIntegrations(record.orgId, record.createdBy, record.config.integrationIds),
  ]);

  // Frame the turn as a Slack mention, in the PROMPT itself.
  //
  // The system prompt says "you were invoked from Slack", but the turn text was the bare user
  // message - so from the model's position this looked like any other invoke, and it answered in
  // text. Asking it explicitly to use the Slack tools worked, which is the tell: the guidance was
  // present, the SITUATION wasn't. A per-turn frame is what ties the two together, and it survives
  // a long conversation where a system prompt from many turns ago has faded.
  const framed = [
    "[Slack mention]",
    `Someone mentioned you in a Slack thread${slackUser ? ` (<@${slackUser}>)` : ""}. Answer them by`,
    "calling `slack_reply` - text you return does not reach them.",
    "",
    prompt,
  ].join("\n");

  const ack = await invoker.invoke({
    agentId: record.id,
    config: record.config,
    version: record.version ?? 1,
    skills,
    integrations: integrations.manifests,
    sessionId,
    prompt: framed,
    fromSlack: true,
    ingestToken: mintSessionToken(
      record.orgId,
      record.createdBy,
      record.id,
      sessionId,
      integrations.grantedIds,
      undefined,
      messageTs,
    ),
  });

  // Record the user's message so the trace shows what was asked, exactly as the API route
  // does. Only for a fresh turn: an injected message is recorded by the runtime's hook.
  if (ack.status === "triggered") {
    // The user's own words, not the framed version - a trace should show what was asked.
    await recordPrompt(ack.sessionId, record.id, prompt).catch((e) =>
      console.error("recordPrompt failed", e),
    );
  }
  // The roster's invocation count + lastInvokedAt. Both other invoke paths do this; without it a
  // busy Slack agent reads as never invoked.
  await bumpInvocation(record.id).catch((e) => console.error("bumpInvocation failed", e));
}
