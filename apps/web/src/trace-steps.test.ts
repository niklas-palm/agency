/**
 * Pairing a tool result with the call it answered.
 *
 * This is the load-bearing bit of the trace viewer: a result printed as its own row had
 * nothing tying it to its call, so a reader had to infer "what answered what" from list
 * order - which is wrong the moment calls interleave. Pairing is on `toolUseId`, and
 * these cases pin the tricky parts (interleaving, a result with no call, no id at all).
 *
 * Pure logic, so it lives in a `.ts` file - the repo collects no `.tsx` tests and has no
 * jsdom, and rendering isn't what can silently go wrong here.
 */
import { describe, it, expect } from "vitest";
import type { TrajectoryEvent } from "@agency/shared";
import { toSteps } from "./Trace.js";

let seq = 0;
const ev = (over: Partial<TrajectoryEvent> & Pick<TrajectoryEvent, "type">): TrajectoryEvent => ({
  cursor: `c${++seq}`,
  ts: "2026-07-27T10:00:00Z",
  ...over,
});

describe("toSteps", () => {
  it("folds a tool result into the call it answers", () => {
    const steps = toSteps([
      ev({ type: "tool_input", toolName: "run_bash", toolUseId: "t1", input: { command: "ls" } }),
      ev({ type: "tool_result", toolUseId: "t1", result: "a.txt" }),
    ]);
    // One step, not two: the call carries its own answer.
    expect(steps).toHaveLength(1);
    expect(steps[0]!.event.type).toBe("tool_input");
    expect(steps[0]!.result?.result).toBe("a.txt");
  });

  it("pairs by toolUseId, NOT by adjacency", () => {
    // Two calls dispatched before either returns, results arriving out of order - the
    // case where "the result after the call" reasoning gives the wrong answer.
    const steps = toSteps([
      ev({ type: "tool_input", toolName: "a", toolUseId: "t1", input: { command: "first" } }),
      ev({ type: "tool_input", toolName: "b", toolUseId: "t2", input: { command: "second" } }),
      ev({ type: "tool_result", toolUseId: "t2", result: "second-result" }),
      ev({ type: "tool_result", toolUseId: "t1", result: "first-result" }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.event.toolName).toBe("a");
    expect(steps[0]!.result?.result).toBe("first-result");
    expect(steps[1]!.event.toolName).toBe("b");
    expect(steps[1]!.result?.result).toBe("second-result");
  });

  it("keeps an orphan result as its own step rather than dropping it", () => {
    // A truncated trajectory, or an archived run missing its head. Hiding the result
    // would silently erase work the agent actually did.
    const steps = toSteps([ev({ type: "tool_result", toolUseId: "gone", result: "orphaned" })]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.event.type).toBe("tool_result");
  });

  it("doesn't pair when the runtime stamped no toolUseId", () => {
    const steps = toSteps([
      ev({ type: "tool_input", toolName: "a", input: { command: "x" } }),
      ev({ type: "tool_result", result: "y" }),
    ]);
    expect(steps).toHaveLength(2); // no id to match on - don't guess
  });

  it("only the FIRST result binds to a call", () => {
    const steps = toSteps([
      ev({ type: "tool_input", toolName: "a", toolUseId: "t1", input: { command: "x" } }),
      ev({ type: "tool_result", toolUseId: "t1", result: "real" }),
      ev({ type: "tool_result", toolUseId: "t1", result: "duplicate" }),
    ]);
    // The duplicate stays visible instead of overwriting the answer that was shown.
    expect(steps[0]!.result?.result).toBe("real");
    expect(steps).toHaveLength(2);
  });

  it("leaves every non-tool event in order, untouched", () => {
    const steps = toSteps([
      ev({ type: "session_start", content: "agent" }),
      ev({ type: "prompt", content: "hi" }),
      ev({ type: "text", content: "thinking" }),
      ev({ type: "tool_input", toolName: "a", toolUseId: "t1", input: { command: "x" } }),
      ev({ type: "tool_result", toolUseId: "t1", result: "done" }),
      ev({ type: "session_end", content: "answer" }),
    ]);
    expect(steps.map((s) => s.event.type)).toEqual([
      "session_start",
      "prompt",
      "text",
      "tool_input",
      "session_end",
    ]);
  });

  it("handles an empty trajectory", () => {
    expect(toSteps([])).toEqual([]);
  });
});
