/**
 * Session-id helpers, and the cross-tenant guarantee that rests on them.
 *
 * ONE shared AgentCore runtime backs every agent in every org, and AgentCore routes
 * `(runtime ARN, runtimeSessionId)` to a single microVM. So the runtime-facing id must
 * never be a value one tenant can choose to collide with another's - which the client's
 * own sessionId is (the API invites clients to supply their own, and
 * `GET /agents/:id/runs` hands live ids to anyone who can see a shared agent).
 */
import { describe, it, expect } from "vitest";
import { newSessionId, isValidSessionId, runtimeSessionIdFor } from "./session-id.js";

describe("newSessionId / isValidSessionId", () => {
  it("generates an AgentCore-compliant id", () => {
    expect(isValidSessionId(newSessionId())).toBe(true);
  });

  it("rejects ids outside AgentCore's charset and length rules", () => {
    expect(isValidSessionId("too-short")).toBe(false);
    expect(isValidSessionId("a".repeat(101))).toBe(false);
    expect(isValidSessionId(`sess-${"a".repeat(30)}!`)).toBe(false);
    expect(isValidSessionId("")).toBe(false);
  });
});

describe("runtimeSessionIdFor (the cross-tenant microVM boundary)", () => {
  const SESSION = "sess-client-supplied-session-id-000000";

  it("is stable for the same agent + session, so turns reach the same microVM", () => {
    expect(runtimeSessionIdFor("agent-a", SESSION)).toBe(runtimeSessionIdFor("agent-a", SESSION));
  });

  /**
   * The load-bearing case. Two agents sharing a client session id MUST NOT resolve to
   * one microVM: the runtime keeps its Agent warm across turns, so landing in another
   * agent's microVM ran the caller's prompt against the victim's system prompt,
   * conversation, and `config.env` secrets - with the output recorded under the
   * caller's own agentId, where they could poll it.
   */
  it("differs per agent for the SAME client session id", () => {
    expect(runtimeSessionIdFor("agent-a", SESSION)).not.toBe(runtimeSessionIdFor("agent-b", SESSION));
  });

  it("differs per session for the same agent", () => {
    const other = "sess-a-completely-different-session-00";
    expect(runtimeSessionIdFor("agent-a", SESSION)).not.toBe(runtimeSessionIdFor("agent-a", other));
  });

  it("can't be confused by field-boundary ambiguity", () => {
    // A naive `agentId + sessionId` concatenation would collide these two.
    expect(runtimeSessionIdFor("ab", "cd".padEnd(33, "x"))).not.toBe(
      runtimeSessionIdFor("a", `bcd`.padEnd(34, "x")),
    );
  });

  it("always produces an id AgentCore accepts", () => {
    for (const [a, s] of [
      ["agent-a", SESSION],
      ["a".repeat(200), "s".repeat(100)], // long inputs must not overflow the 100-char cap
      ["", ""],
    ] as const) {
      const id = runtimeSessionIdFor(a, s);
      expect(isValidSessionId(id), `${a.slice(0, 8)}/${s.slice(0, 8)}`).toBe(true);
    }
  });
});
