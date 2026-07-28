import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the trajectory sink so we can assert runAgentTurn records each parsed event
// without a real ingest round-trip.
const record = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./trajectory.js", () => ({ record: (...args: unknown[]) => record(...args) }));

import { parseStreamEvent, serializeToolResult, runAgentTurn, budgetTripMessage } from "./run.js";

describe("parseStreamEvent", () => {
  it("extracts assistant text from a modelMessageEvent", () => {
    const events = parseStreamEvent({
      type: "modelMessageEvent",
      message: { content: [{ type: "textBlock", text: "hello" }] },
    });
    expect(events).toEqual([{ type: "text", fields: { content: "hello" } }]);
  });

  it("extracts a tool call with name, id, and input", () => {
    const events = parseStreamEvent({
      type: "modelMessageEvent",
      message: {
        content: [{ type: "toolUseBlock", name: "run_bash", toolUseId: "t1", input: { command: "ls" } }],
      },
    });
    expect(events).toEqual([
      { type: "tool_input", fields: { toolName: "run_bash", toolUseId: "t1", input: { command: "ls" } } },
    ]);
  });

  it("handles a message with both text and multiple tool calls in order", () => {
    const events = parseStreamEvent({
      type: "modelMessageEvent",
      message: {
        content: [
          { type: "textBlock", text: "let me check" },
          { type: "toolUseBlock", name: "read_file", toolUseId: "t1", input: { path: "a" } },
          { type: "toolUseBlock", name: "read_file", toolUseId: "t2", input: { path: "b" } },
        ],
      },
    });
    expect(events.map((e) => e.type)).toEqual(["text", "tool_input", "tool_input"]);
    expect(events[1]!.fields.toolUseId).toBe("t1");
    expect(events[2]!.fields.toolUseId).toBe("t2");
  });

  it("extracts a tool result and correlates by toolUseId", () => {
    const events = parseStreamEvent({
      type: "toolResultEvent",
      result: { toolUseId: "t1", content: [{ json: { ok: true } }] },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool_result");
    expect(events[0]!.fields.toolUseId).toBe("t1");
    expect(events[0]!.fields.result).toContain("ok");
  });

  it("defaults tool input to {} when absent", () => {
    const [ev] = parseStreamEvent({
      type: "modelMessageEvent",
      message: { content: [{ type: "toolUseBlock", name: "x", toolUseId: "t1" }] },
    });
    expect(ev!.fields.input).toEqual({});
  });

  it("ignores empty text blocks and unknown block types", () => {
    const events = parseStreamEvent({
      type: "modelMessageEvent",
      message: { content: [{ type: "textBlock", text: "" }, { type: "reasoningBlock", text: "hmm" }] },
    });
    expect(events).toEqual([]);
  });

  it("ignores unrelated stream events (deltas, lifecycle)", () => {
    expect(parseStreamEvent({ type: "modelStreamUpdateEvent" })).toEqual([]);
    expect(parseStreamEvent({ type: "agentResultEvent" })).toEqual([]);
    expect(parseStreamEvent({})).toEqual([]);
  });

  it("truncates very long tool results to 4000 chars", () => {
    const big = "x".repeat(10_000);
    const [ev] = parseStreamEvent({ type: "toolResultEvent", result: { toolUseId: "t", content: big } });
    expect(ev!.fields.result!.length).toBe(4000);
  });
});

describe("serializeToolResult", () => {
  it("passes strings through", () => {
    expect(serializeToolResult("done")).toBe("done");
  });
  it("JSON-stringifies objects/arrays", () => {
    expect(serializeToolResult([{ json: { a: 1 } }])).toBe('[{"json":{"a":1}}]');
  });
  it("falls back to String() on non-serializable input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof serializeToolResult(circular)).toBe("string");
  });
});

describe("runAgentTurn (the turn loop)", () => {
  beforeEach(() => record.mockClear());

  /** The options runAgentTurn passed to `stream()` on the most recent call. */
  let streamOptions: { limits?: { turns?: number; totalTokens?: number }; cancelSignal?: AbortSignal } | undefined;

  /** A fake Strands Agent: streams the given events + exposes a cumulative usage meter. */
  function fakeAgent(events: unknown[], usage?: Record<string, number>) {
    return {
      metrics: { accumulatedUsage: usage },
      // eslint-disable-next-line @typescript-eslint/require-await
      async *stream(_prompt: unknown, options?: typeof streamOptions) {
        streamOptions = options;
        for (const ev of events) yield ev;
      },
    } as never;
  }

  it("drives the stream: records each parsed event, returns the last text + tool calls + usage", async () => {
    const agent = fakeAgent(
      [
        { type: "modelMessageEvent", message: { content: [{ type: "textBlock", text: "thinking" }] } },
        { type: "modelMessageEvent", message: { content: [{ type: "toolUseBlock", name: "run_bash", toolUseId: "t1", input: { command: "ls" } }] } },
        { type: "modelMessageEvent", message: { content: [{ type: "textBlock", text: "the answer" }] } },
      ],
      { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 3, cacheWriteInputTokens: 4 },
    );

    const result = await runAgentTurn(agent, "sess-1", "agent-1", "go");

    // finalText is the LAST assistant text (not the first); tool calls accrue in order.
    expect(result.finalText).toBe("the answer");
    expect(result.toolCalls).toEqual([{ name: "run_bash" }]);
    // usage is read from the agent's cumulative meter, mapped to our TokenUsage shape.
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4 });
    // Every parsed event was persisted to the trajectory (3 here: text, tool_input, text).
    expect(record).toHaveBeenCalledTimes(3);
    expect(record).toHaveBeenNthCalledWith(1, "sess-1", "agent-1", "text", { content: "thinking" });
    expect(record).toHaveBeenNthCalledWith(2, "sess-1", "agent-1", "tool_input", { toolName: "run_bash", toolUseId: "t1", input: { command: "ls" } });
  });

  it("returns zeroed usage when the agent reports no accumulated usage", async () => {
    const agent = fakeAgent([{ type: "modelMessageEvent", message: { content: [{ type: "textBlock", text: "hi" }] } }]);
    const result = await runAgentTurn(agent, "s", "a", "p");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  describe("the per-turn budget", () => {
    /**
     * Nothing else bounds a turn: there is no rate limit and no concurrency cap, and a
     * microVM lives up to 8h - so a tool-looping model could hold a billable session
     * for hours. These caps are the only thing that stops it, which is why they're
     * asserted rather than assumed.
     */
    it("passes turn, token and wall-clock caps to the agent loop", async () => {
      const agent = fakeAgent([
        { type: "modelMessageEvent", message: { content: [{ type: "textBlock", text: "hi" }] } },
      ]);
      await runAgentTurn(agent, "s", "a", "p");
      expect(streamOptions?.limits?.turns).toBeGreaterThan(0);
      expect(streamOptions?.limits?.totalTokens).toBeGreaterThan(0);
      // A deadline too, so a turn that stalls without burning turns/tokens still ends.
      expect(streamOptions?.cancelSignal).toBeInstanceOf(AbortSignal);
    });

    /**
     * The SDK RETURNS a `limit*`/`cancelled` stop reason instead of throwing, and
     * `for await` discards a generator's return value - so the trip is visible only
     * on the terminal `agentResultEvent`. Miss it and a runaway turn is recorded as
     * a SUCCESS with a blank answer, and the error rate (the signal for tuning these
     * caps) never moves.
     */
    it("surfaces the stop reason from the terminal event", async () => {
      const agent = fakeAgent([
        { type: "modelMessageEvent", message: { content: [{ type: "textBlock", text: "hi" }] } },
        { type: "agentResultEvent", result: { stopReason: "limitTurns" } },
      ]);
      const result = await runAgentTurn(agent, "s", "a", "p");
      expect(result.stopReason).toBe("limitTurns");
    });

    it("classifies every budget stop reason as a trip, and a normal finish as not one", () => {
      for (const trip of ["limitTurns", "limitTotalTokens", "cancelled"]) {
        expect(budgetTripMessage(trip), trip).toBeTruthy();
      }
      for (const ok of ["endTurn", "stopSequence", "maxTokens", undefined]) {
        expect(budgetTripMessage(ok), String(ok)).toBeUndefined();
      }
    });
  });
});
