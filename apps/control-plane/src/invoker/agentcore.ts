/**
 * AgentCore invoker: SigV4 InvokeAgentRuntime against a shared runtime. There's a
 * small pool keyed by network mode (public / isolated); the target ARN is chosen
 * from the agent's `config.networkMode` (runtimeArnFor). The runtimeSessionId pins
 * the request to one microVM (same id → same session) and is derived from
 * (agentId, clientSessionId) so one agent's id can never reach another's microVM
 * (see session-id.ts); agentId + config ride the
 * payload. The runtime returns immediately with a triggered/injected ack; we
 * decode and return it. We drain the response body to release the socket. The
 * short retry below now only covers transient throttling/conflict - the shared
 * runtimes are always provisioned, so there's no per-agent create→READY wait.
 */
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type { RuntimeAck, RuntimePayload } from "@agency/shared";
import type { AgentInvoker, InvokeArgs } from "./invoker.js";
import { REGION, runtimeArnFor } from "../config.js";
import { runtimeSessionIdFor } from "../session-id.js";

export class AgentCoreInvoker implements AgentInvoker {
  // Bound each send() so one slow/hung request can't push the retry loop past
  // the API Gateway 30s timeout - the retry budget only bounds sleeps, not the
  // in-flight call. requestTimeout keeps a single attempt to a few seconds.
  private readonly client = new BedrockAgentCoreClient({
    region: REGION,
    requestHandler: { requestTimeout: 5_000, connectionTimeout: 3_000 },
  });

  async invoke({ agentId, config, version, skills, integrations, sessionId, prompt, ingestToken }: InvokeArgs): Promise<RuntimeAck> {
    // sessionId in the payload is the CLIENT's - what telemetry is keyed by. The
    // runtimeSessionId below is the derived, agent-bound one used only for routing.
    const payload: RuntimePayload = { agentId, config, version, skills, integrations, sessionId, prompt, ingestToken };
    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArnFor(config.networkMode),
      // Bound to the agent, NOT the client's id verbatim - see runtimeSessionIdFor:
      // one shared runtime backs every agent, so a raw client id let a caller land in
      // another agent's warm microVM.
      runtimeSessionId: runtimeSessionIdFor(agentId, sessionId),
      qualifier: "DEFAULT",
      contentType: "application/json",
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    });

    // A freshly created runtime takes ~1-2 min to reach READY. Retry on the
    // not-ready/conflict errors so the first invoke after create still works.
    const res = await withReadyRetry(() => this.client.send(command));

    const text = await bodyToString(res.response);
    try {
      return JSON.parse(text) as RuntimeAck;
    } catch {
      // Runtime accepted but returned a non-JSON/empty body - treat as triggered.
      return { status: "triggered", sessionId };
    }
  }
}

/**
 * Errors where the invoke provably did NOT reach the runtime, so re-sending it
 * can't run the prompt twice.
 *
 * Invoking is NOT idempotent: the same runtimeSessionId reaching a running session
 * is *injected* into the turn, so a retry of a request that actually landed makes
 * the agent see the prompt twice (or start a second turn). Only errors that mean
 * "rejected before any work started" belong here - see isRetryableError for the
 * ambiguous cases we deliberately refuse to retry.
 */
const RETRYABLE = ["ResourceNotReady", "ConflictException", "ThrottlingException"];

/**
 * Errors that are ambiguous about whether the invoke landed, so we must NOT retry
 * them even when the AWS SDK flags them `$retryable`. A request that timed out
 * client-side may well have been accepted by the runtime; retrying it would inject
 * a duplicate prompt into a turn that is already running. The caller gets the
 * error and can decide - it can poll the session to see whether the turn started.
 *
 * Exported because the invoke ROUTE needs the same judgement: it must not answer
 * "retry shortly" for an outcome nobody knows (see isAmbiguousInvoke in routes.ts).
 */
export function isAmbiguousOutcome(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return AMBIGUOUS.includes((err as { name?: string }).name ?? "");
}
const AMBIGUOUS = ["TimeoutError", "TimeoutException", "RequestTimeout", "AbortError"];

/** Total retry budget, kept under the API Gateway 30s timeout with headroom. */
export const RETRY_BUDGET_MS = 15_000;

/** True if an error means the invoke was rejected outright and is safe to re-send. */
export function isRetryableError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; message?: string; $retryable?: unknown };
  // Ambiguous outcomes lose to $retryable on purpose: "the SDK would retry this"
  // is about wire-level retry safety, not about whether OUR non-idempotent invoke
  // already ran.
  if (isAmbiguousOutcome(err)) return false;
  if (e.$retryable) return true;
  return RETRYABLE.includes(e.name ?? "") || /not ready|READY|creating/i.test(e.message ?? "");
}

/**
 * Next backoff delay: exponential (1s,2s,4s,8s cap) with jitter, but never longer
 * than the time remaining in the budget - so a retry never sleeps past the
 * deadline. Returns 0 when no budget remains (caller should stop retrying).
 *
 * The jitter matters under throttling: without it, every invoke throttled by the
 * same quota exhaustion retries in lockstep and re-throttles itself.
 */
export function nextRetryDelay(attempt: number, remainingMs: number): number {
  if (remainingMs <= 0) return 0;
  const capped = Math.min(8000, 1000 * 2 ** attempt);
  // Full jitter over [capped/2, capped), then clamped to the remaining budget.
  const jittered = capped / 2 + Math.random() * (capped / 2);
  return Math.min(jittered, remainingMs);
}

async function withReadyRetry<T>(fn: () => Promise<T>): Promise<T> {
  // On exhaustion the last error propagates; the client can retry the invoke.
  const deadline = Date.now() + RETRY_BUDGET_MS;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const remaining = deadline - Date.now();
      if (!isRetryableError(err) || remaining <= 0) throw err;
      await new Promise((r) => setTimeout(r, nextRetryDelay(attempt++, remaining)));
    }
  }
}

/** Collect the AgentCore streaming response body into a string. */
async function bodyToString(body: unknown): Promise<string> {
  if (!body) return "";
  const maybe = body as { transformToString?: () => Promise<string> };
  if (typeof maybe.transformToString === "function") return maybe.transformToString();
  return "";
}
