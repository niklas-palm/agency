/**
 * Schedule trigger entrypoint. EventBridge Scheduler invokes this Lambda on each
 * tick with `{ agentId }`. It loads the agent, reads its schedule trigger's
 * stored prompt, and fires the agent via the same AgentCore invoker the API uses
 * - a fresh session per tick (unattended runs don't share a conversation).
 *
 * Prompt/expression are read from config (the single source of truth), so this
 * needs no per-schedule state beyond the agentId the schedule passes in.
 */
import { scheduleOf } from "@agency/shared";
import { getAgent } from "./repo/agents.js";
import { bumpInvocation } from "./repo/metrics.js";
import { resolveSkills, resolveIntegrations } from "./resolve-attachments.js";
import { recordPrompt } from "./repo/trajectory.js";
import { mintSessionToken } from "./session-token.js";
import { newSessionId } from "./session-id.js";
import { AgentCoreInvoker } from "./invoker/agentcore.js";

const invoker = new AgentCoreInvoker();

export async function handler(event: { agentId?: string }): Promise<void> {
  const agentId = event?.agentId;
  if (!agentId) {
    console.error("schedule trigger missing agentId", event);
    return;
  }

  const record = await getAgent(agentId);
  if (!record) {
    // The agent was deleted but its schedule outlived it - nothing to run.
    console.warn("schedule trigger for unknown agent", agentId);
    return;
  }

  const schedule = scheduleOf(record.config);
  if (!schedule) {
    // Schedule was removed from config but the EventBridge schedule lingered.
    console.warn("schedule trigger for agent with no schedule", agentId);
    return;
  }

  // Attached skills + integrations, resolved by the SAME helpers the API invoke path
  // uses (visibility included), so a scheduled run gets exactly what an API run
  // gets. A read failure throws, which fails this tick - EventBridge retries it,
  // rather than the agent running without its skills and appearing to succeed.
  const [skills, integrations] = await Promise.all([
    resolveSkills(record.orgId, record.createdBy, record.config.skillIds),
    resolveIntegrations(record.orgId, record.createdBy, record.config.integrationIds),
  ]);

  const sessionId = newSessionId();
  const ack = await invoker.invoke({
    agentId: record.id,
    config: record.config,
    version: record.version ?? 1,
    skills,
    integrations: integrations.manifests,
    sessionId,
    prompt: schedule.prompt,
    // Grant the token only the integrations that actually resolved as visible.
    ingestToken: mintSessionToken(
      record.orgId,
      record.createdBy,
      record.id,
      sessionId,
      integrations.grantedIds,
    ),
  });
  // Record the scheduled prompt in the trajectory (control-plane), same as the API
  // invoke path - so the trace shows the message that fired the run. Only for a
  // fresh turn; a scheduled tick always starts a fresh session so it's `triggered`.
  if (ack.status === "triggered") {
    await recordPrompt(ack.sessionId, record.id, schedule.prompt).catch((e) =>
      console.error("recordPrompt failed", e),
    );
  }
  await bumpInvocation(record.id).catch((e) => console.error("bumpInvocation failed", e));
  console.log("schedule fired", { agentId, sessionId: ack.sessionId, status: ack.status });
}
