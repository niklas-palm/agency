import { describe, it, expect, vi } from "vitest";

// Capture what the invoker actually sends to AgentCore.
interface SentCommand {
  input: { runtimeSessionId: string; agentRuntimeArn?: string };
}
const send = vi.fn(async (_cmd: SentCommand) => ({ response: undefined }));
/** The runtimeSessionId on the nth captured send(). */
const sentSessionId = (n: number): string => send.mock.calls[n]![0].input.runtimeSessionId;
vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient: class {
    send = send;
  },
  InvokeAgentRuntimeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

import { isRetryableError, nextRetryDelay, RETRY_BUDGET_MS, AgentCoreInvoker } from "./agentcore.js";
import { runtimeSessionIdFor } from "../session-id.js";

describe("isRetryableError", () => {
  it("retries errors that mean the invoke never reached the runtime", () => {
    for (const name of ["ResourceNotReady", "ConflictException", "ThrottlingException"]) {
      expect(isRetryableError({ name })).toBe(true);
    }
  });

  it("retries messages that mention readiness", () => {
    expect(isRetryableError({ message: "runtime is not ready" })).toBe(true);
    expect(isRetryableError({ message: "still creating" })).toBe(true);
  });

  it("retries any error the SDK flags $retryable", () => {
    expect(isRetryableError({ name: "Whatever", $retryable: {} })).toBe(true);
    expect(isRetryableError({ $retryable: { throttling: true } })).toBe(true);
  });

  // Invoking is NOT idempotent: the same sessionId reaching a running session is
  // INJECTED into the turn. So an error that leaves it unknown whether the request
  // landed must not be retried - doing so makes the agent see the prompt twice.
  it("refuses to retry a timeout, whose outcome is unknown", () => {
    for (const name of ["TimeoutError", "TimeoutException", "RequestTimeout", "AbortError"]) {
      expect(isRetryableError({ name }), name).toBe(false);
    }
  });

  it("keeps refusing an ambiguous error even when the SDK flags it $retryable", () => {
    // The SDK's flag is about wire-level retry safety, not about whether our
    // non-idempotent invoke already ran - so ours wins.
    expect(isRetryableError({ name: "TimeoutError", $retryable: { throttling: false } })).toBe(false);
  });

  it("refuses to retry ValidationException (a bad request, not a transient state)", () => {
    expect(isRetryableError({ name: "ValidationException" })).toBe(false);
  });

  it("does not retry unrelated errors", () => {
    expect(isRetryableError({ name: "AccessDeniedException" })).toBe(false);
    expect(isRetryableError({ name: "ResourceNotFoundException" })).toBe(false);
    expect(isRetryableError(new Error("boom"))).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe("nextRetryDelay", () => {
  it("backs off exponentially within a jittered band, capped at 8s", () => {
    const big = RETRY_BUDGET_MS;
    // Full jitter: each delay lands in [cap/2, cap). Sample so a wild value can't
    // slip through on one lucky draw.
    for (const [attempt, cap] of [
      [0, 1000],
      [1, 2000],
      [2, 4000],
      [3, 8000],
      [10, 8000], // capped
    ] as [number, number][]) {
      for (let i = 0; i < 20; i++) {
        const d = nextRetryDelay(attempt, big);
        expect(d, `attempt ${attempt}`).toBeGreaterThanOrEqual(cap / 2);
        expect(d, `attempt ${attempt}`).toBeLessThan(cap);
      }
    }
  });

  it("jitters, so invokes throttled together don't retry in lockstep", () => {
    const draws = new Set(Array.from({ length: 30 }, () => nextRetryDelay(3, RETRY_BUDGET_MS)));
    expect(draws.size).toBeGreaterThan(1);
  });

  it("never sleeps past the remaining budget (the deadline fix)", () => {
    expect(nextRetryDelay(3, 500)).toBe(500); // would be ~4-8s, clamped to remaining
    expect(nextRetryDelay(0, 300)).toBe(300); // would be ~0.5-1s, clamped
  });

  it("returns 0 when no budget remains so the caller stops", () => {
    expect(nextRetryDelay(0, 0)).toBe(0);
    expect(nextRetryDelay(5, -100)).toBe(0);
  });

  it("keeps the total budget under the 30s API Gateway timeout", () => {
    expect(RETRY_BUDGET_MS).toBeLessThan(30_000);
  });
});

/**
 * ONE shared runtime backs every agent in every org, and AgentCore routes
 * `(runtime ARN, runtimeSessionId)` to a single microVM - so sending the CLIENT's
 * session id verbatim let a caller who knew another agent's session id land in that
 * agent's warm microVM and run their prompt against its history and `config.env`.
 * Session ids aren't secret enough to rest on: `GET /agents/:id/runs` returns them to
 * anyone who can see a shared agent.
 */
describe("AgentCoreInvoker: the runtime session id is bound to the agent", () => {
  const args = {
    agentId: "agent-a",
    config: { name: "n", systemPrompt: "p", model: "haiku-4.5" },
    version: 1,
    skills: [],
    integrations: [],
    sessionId: "sess-client-supplied-session-id-000000",
    prompt: "hi",
    ingestToken: "t",
  } as never;

  it("never sends the client's raw session id", async () => {
    send.mockClear();
    await new AgentCoreInvoker().invoke(args).catch(() => {}); // ack parse fails; we only want the request
    expect(sentSessionId(0)).not.toBe("sess-client-supplied-session-id-000000");
    expect(sentSessionId(0)).toBe(runtimeSessionIdFor("agent-a", "sess-client-supplied-session-id-000000"));
  });

  /**
   * The payload must still carry the CLIENT's session id. The runtime reports telemetry
   * under it, and the ingest capability token is scoped to it - so when the runtime used
   * AgentCore's derived `context.sessionId` instead, every ingest POST 401'd and no
   * trajectory or metrics row was written. The local E2E did NOT catch that (locally the
   * header and payload agreed), so it has to be pinned here.
   */
  it("still passes the client's session id in the PAYLOAD, for telemetry", async () => {
    send.mockClear();
    await new AgentCoreInvoker().invoke(args).catch(() => {});
    const cmd = send.mock.calls[0]![0] as unknown as { input: { payload: Uint8Array } };
    const body = JSON.parse(new TextDecoder().decode(cmd.input.payload)) as { sessionId: string };
    expect(body.sessionId).toBe("sess-client-supplied-session-id-000000");
  });

  it("sends a DIFFERENT runtime session id for another agent on the same client session", async () => {
    send.mockClear();
    await new AgentCoreInvoker().invoke(args).catch(() => {});
    await new AgentCoreInvoker().invoke({ ...(args as object), agentId: "agent-b" } as never).catch(() => {});
    expect(sentSessionId(0)).not.toBe(sentSessionId(1));
  });
});
