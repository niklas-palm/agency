import { describe, it, expect } from "vitest";
import { newAccumulator, accumulateTurn, recordInvocationDuration, sealTokens } from "./session-metrics.js";

describe("session metrics accumulator", () => {
  it("starts empty with a stable runId and the opening invocation counted", () => {
    const acc = newAccumulator("agent-1", "sess-1", 3, "haiku-4.5");
    expect(acc.turns).toBe(0);
    expect(acc.toolUses).toBe(0);
    expect(acc.toolBreakdown).toEqual({});
    expect(acc.injections).toBe(0);
    expect(acc.invocations).toBe(1); // the opening trigger
    expect(acc.invocationDurationsMs).toEqual([]);
    expect(acc.version).toBe(3);
    expect(acc.runId).toMatch(/[0-9a-f-]{36}/);
  });

  it("records one duration per completed invocation span (not summed)", () => {
    const acc = newAccumulator("a", "s", 1, "haiku-4.5");
    recordInvocationDuration(acc, 1200);
    recordInvocationDuration(acc, 340);
    // Each completed working span is its own sample - the dashboard takes
    // percentiles over these, so they're kept individually, not summed.
    expect(acc.invocationDurationsMs).toEqual([1200, 340]);
  });

  it("folds turns and tool calls, tallying a per-tool breakdown", () => {
    const acc = newAccumulator("a", "s", 1, "haiku-4.5");
    accumulateTurn(acc, { toolCalls: [{ name: "run_bash" }, { name: "run_bash" }] });
    accumulateTurn(acc, { toolCalls: [{ name: "web_search" }] });
    accumulateTurn(acc, { toolCalls: [] });
    expect(acc.turns).toBe(3);
    expect(acc.toolUses).toBe(3);
    expect(acc.toolBreakdown).toEqual({ run_bash: 2, web_search: 1 });
  });

  it("keeps runId stable across turns (one row overwritten, not appended)", () => {
    const acc = newAccumulator("a", "s", 1, "haiku-4.5");
    const id = acc.runId;
    accumulateTurn(acc, { toolCalls: [] });
    accumulateTurn(acc, { toolCalls: [] });
    expect(acc.runId).toBe(id);
  });

  it("OVERWRITES token usage with the latest cumulative snapshot (never sums - the Meter is already cumulative)", () => {
    const acc = newAccumulator("a", "s", 1, "haiku-4.5");
    expect(acc.tokens).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // Turn 1 reports the running total after turn 1.
    accumulateTurn(acc, { toolCalls: [], usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    expect(acc.tokens.inputTokens).toBe(100);
    // Turn 2 reports the running total after turn 2 (300 in, not 200 added to 100).
    accumulateTurn(acc, { toolCalls: [], usage: { inputTokens: 300, outputTokens: 60, cacheReadTokens: 10, cacheWriteTokens: 5 } });
    expect(acc.tokens).toEqual({ inputTokens: 300, outputTokens: 60, cacheReadTokens: 10, cacheWriteTokens: 5 });
    // A turn with no usage (shouldn't happen, but be defensive) leaves the last snapshot.
    accumulateTurn(acc, { toolCalls: [] });
    expect(acc.tokens.inputTokens).toBe(300);
  });
});

describe("token accounting across an Agent rebuild", () => {
  const usage = (input: number) => ({
    inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  });

  /**
   * `tokens` mirrors the LIVE Agent's cumulative meter, so accumulateTurn overwrites
   * rather than sums. But an errored turn discards the warm Agent while the session (and
   * this accumulator) lives on, and the replacement's meter starts at zero - so without
   * sealing, its first snapshot overwrote everything already spent. The row is priced
   * read-side from `tokens`, so those tokens vanished from the bill.
   */
  it("keeps tokens spent before the error", () => {
    const acc = newAccumulator("a", "s", 1, "haiku-4.5");
    accumulateTurn(acc, { toolCalls: [], usage: usage(10_000) });
    sealTokens(acc); // the error path discards the Agent
    accumulateTurn(acc, { toolCalls: [], usage: usage(500) }); // fresh, zeroed meter
    expect(acc.retiredTokens.inputTokens).toBe(10_000);
    expect(acc.tokens.inputTokens).toBe(500);
  });

  it("survives repeated rebuilds", () => {
    const acc = newAccumulator("a", "s", 1, "haiku-4.5");
    for (const n of [100, 200, 300]) {
      accumulateTurn(acc, { toolCalls: [], usage: usage(n) });
      sealTokens(acc);
    }
    expect(acc.retiredTokens.inputTokens).toBe(600);
  });
});

describe("toolBreakdown tolerates a hallucinated tool name", () => {
  // The key is model-supplied and unvalidated (run.ts records block.name whether or not
  // the tool exists), so a prototype key must not corrupt the counts: "constructor"
  // used to string-concat into "function Object() { [native code] }1" and reach the
  // dashboard, while "__proto__" silently dropped its count.
  it("counts prototype-shaped names as ordinary tools", () => {
    const acc = newAccumulator("a", "s", 1, "haiku-4.5");
    accumulateTurn(acc, {
      toolCalls: [{ name: "constructor" }, { name: "__proto__" }, { name: "run_bash" }],
    });
    // Asserted key-by-key: an object literal can't carry `__proto__` as an own property,
    // so toEqual against one would silently compare something else.
    expect(Object.keys(acc.toolBreakdown).sort()).toEqual(["__proto__", "constructor", "run_bash"]);
    for (const k of ["constructor", "__proto__", "run_bash"]) {
      expect(acc.toolBreakdown[k], `${k} must count as 1`).toBe(1);
    }
    expect(acc.toolUses).toBe(3);
  });
});
