/**
 * Local invoker: POSTs directly to the shared agent-runtime container's
 * /invocations endpoint, emulating AgentCore's contract. The session id goes in
 * the AgentCore session header so the runtime's `context.sessionId` matches prod.
 */
import type { RuntimeAck, RuntimePayload } from "@agency/shared";
import type { AgentInvoker, InvokeArgs } from "./invoker.js";
import { LOCAL_RUNTIME_URL } from "../config.js";

import { runtimeSessionIdFor } from "../session-id.js";

const SESSION_HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id";

export class HttpAgentInvoker implements AgentInvoker {
  async invoke({ agentId, config, version, skills, integrations, sessionId, prompt, ingestToken }: InvokeArgs): Promise<RuntimeAck> {
    const payload: RuntimePayload = { agentId, config, version, skills, integrations, sessionId, prompt, ingestToken };
    const res = await fetch(`${LOCAL_RUNTIME_URL}/invocations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The derived, agent-bound id - mirroring what the AgentCore invoker sends, so
        // the local runtime sees the same context.sessionId shape as prod.
        [SESSION_HEADER]: runtimeSessionIdFor(agentId, sessionId),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`local runtime invoke failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as RuntimeAck;
  }
}
