/**
 * AgentInvoker seam: triggering a shared agent runtime. Prod does a SigV4
 * InvokeAgentRuntime against the AgentCore runtime picked by the agent's network
 * mode (runtimeArnFor - public or isolated); local POSTs to the shared runtime
 * container's /invocations endpoint. Both are async-by-contract: they resolve as
 * soon as the runtime accepts (returns triggered/injected), never on completion.
 * The agent's identity + behavior ride the payload (agentId/config/skills/version),
 * so the invoker needs no per-agent runtime reference.
 */
import type { AgentConfig, ResolvedIntegration, ResolvedSkill, RuntimeAck } from "@agency/shared";

export interface InvokeArgs {
  agentId: string;
  config: AgentConfig;
  /** The config version being run; stamped on the session's metric summary. */
  version: number;
  /** The agent's attached skills, resolved to content (empty if none). */
  skills?: ResolvedSkill[];
  /**
   * The agent's attached integrations, resolved to metadata + operation manifest
   * (no secret, no baseUrl) - so the runtime can tell the model what it CAN call.
   */
  integrations?: ResolvedIntegration[];
  sessionId: string;
  prompt: string;
  /** True when a Slack mention started this run - the runtime wires its Slack tools from it. */
  fromSlack?: boolean;
  /** Per-session telemetry + integrations-proxy capability token, minted by the control-plane. */
  ingestToken: string;
}

export interface AgentInvoker {
  invoke(args: InvokeArgs): Promise<RuntimeAck>;
}
