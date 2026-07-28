/**
 * AgentCore runtimeSessionId helpers. AgentCore requires session ids to match
 * [a-zA-Z0-9_-] and be 33-100 characters. We generate a readable prefix plus a
 * UUID for uniqueness, and validate client-supplied ids so a bad one fails fast
 * in our API rather than deep inside an AgentCore call.
 */
import { v4 as uuidv4 } from "uuid";
import { createHash } from "node:crypto";

const VALID = /^[a-zA-Z0-9_-]{33,100}$/;

/** Generate a fresh, compliant session id. */
export function newSessionId(): string {
  // "sess-" (5) + uuid without dashes (32) = 37 chars, within 33-100.
  return `sess-${uuidv4().replace(/-/g, "")}`;
}

/** True if a client-supplied session id is AgentCore-compliant. */
export function isValidSessionId(id: string): boolean {
  return VALID.test(id);
}

/**
 * The runtime session id to invoke with, for a (agent, client session) pair.
 *
 * NOT the client's id verbatim. AgentCore routes `(runtime ARN, runtimeSessionId)` to
 * one microVM, and ONE shared runtime backs every agent in every org - so passing the
 * client's id through meant a caller who knew another agent's session id landed in that
 * agent's warm microVM. The runtime keeps its Agent warm across turns and only rebuilds
 * it when the session changes, so the intruder's prompt ran against the VICTIM's agent:
 * their system prompt, their conversation, and their `config.env` secrets - with the
 * output recorded under the intruder's own agentId, where they could poll it.
 *
 * Session ids were not secret enough to rest on, either: `GET /agents/:id/runs` returns
 * them to anyone who can *see* a shared agent, and the API deliberately invites clients
 * to supply their own (so they're often guessable).
 *
 * Binding the agent into the id closes it structurally: two agents can never name the
 * same microVM, whatever the client sends. The client's id still identifies the
 * conversation for polling - only the runtime-facing id changes.
 */
export function runtimeSessionIdFor(agentId: string, sessionId: string): string {
  // Truncated to keep the total inside AgentCore's 100-char ceiling; 32 hex chars
  // (128 bits) is far more than enough to avoid collisions.
  const bound = createHash("sha256").update(`${agentId}\n${sessionId}`).digest("hex").slice(0, 32);
  return `sess-${bound}`;
}
