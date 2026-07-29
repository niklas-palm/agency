/**
 * Runs one agent turn and persists its trajectory. Walks the Strands stream and
 * records each assistant text block, tool call (with inputs), and tool result to
 * the trajectory table so clients can poll progress. Returns the final answer.
 */
import type { Agent } from "@strands-agents/sdk";
import type { TrajectoryEventType, TokenUsage, ResolvedIntegration } from "@agency/shared";
import { record, type EventFields } from "./trajectory.js";
import { integrationCallLabel } from "./integration-tools.js";
import {
  MAX_TURNS_PER_INVOCATION,
  MAX_TOKENS_PER_INVOCATION,
  INVOCATION_DEADLINE_MS,
} from "./config.js";

const MAX_RESULT_CHARS = 4000;

/** A parsed trajectory event: its type plus the fields to persist. */
export interface ParsedEvent {
  type: TrajectoryEventType;
  fields: EventFields;
}

/** Flatten a tool result's content blocks into a short string for the trajectory. */
export function serializeToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * Pure translation of one Strands stream event into zero or more trajectory
 * events. Separated from persistence so it can be unit-tested without DynamoDB.
 * A model message may yield multiple events (text + several tool calls).
 */
export function parseStreamEvent(ev: unknown): ParsedEvent[] {
  const e = ev as {
    type?: string;
    message?: { content?: Array<Record<string, unknown>> };
    result?: { toolUseId?: string; content?: unknown };
  };
  const out: ParsedEvent[] = [];

  if (e.type === "modelMessageEvent") {
    for (const block of e.message?.content ?? []) {
      if (!block) continue;
      if (block.type === "textBlock" && block.text) {
        out.push({ type: "text", fields: { content: String(block.text) } });
      } else if (block.type === "toolUseBlock" && block.toolUseId && block.name) {
        out.push({
          type: "tool_input",
          fields: {
            toolName: String(block.name),
            toolUseId: String(block.toolUseId),
            input: block.input ?? {},
          },
        });
      }
    }
  } else if (e.type === "toolResultEvent" && e.result) {
    out.push({
      type: "tool_result",
      fields: {
        toolUseId: e.result.toolUseId,
        result: serializeToolResult(e.result.content ?? []).slice(0, MAX_RESULT_CHARS),
      },
    });
  }

  return out;
}

/** The outcome of one turn: the final answer plus the tool calls it made (for metrics). */
export interface TurnResult {
  finalText: string;
  /** One entry per tool call, named as the trajectory records it (see `integrationCallLabel`). */
  toolCalls: Array<{ name: string }>;
  /**
   * The Agent's CUMULATIVE token usage after this turn. Strands' Meter is
   * created once per Agent and never reset, so `agent.metrics.accumulatedUsage`
   * is the running total across every turn on this warm agent (= the session
   * lifetime). We return it as-is (a snapshot, not a per-turn delta) so the
   * accumulator can store the latest total without delta math or double-counting.
   */
  usage: TokenUsage;
  /**
   * Why the agent loop stopped, from the stream's terminal `agentResultEvent`.
   * `undefined` if the stream ended without one. See `budgetTripMessage`.
   */
  stopReason?: string;
}

/**
 * If this stop reason means a per-turn budget cut the turn short, the message to
 * record; otherwise undefined. The SDK RETURNS these rather than throwing, so
 * without this check a runaway turn would be recorded as a successful one with a
 * blank answer - and the error rate, the one signal for tuning the caps, would
 * never move. See config.ts for the knobs.
 */
export function budgetTripMessage(stopReason: string | undefined): string | undefined {
  switch (stopReason) {
    case "limitTurns":
      return `Stopped: the turn hit its ${MAX_TURNS_PER_INVOCATION}-turn budget (MAX_TURNS_PER_INVOCATION).`;
    case "limitTotalTokens":
      return `Stopped: the turn hit its ${MAX_TOKENS_PER_INVOCATION}-token budget (MAX_TOKENS_PER_INVOCATION).`;
    case "cancelled":
      // The deadline is the ONLY thing that aborts a turn here (there is no
      // user-cancel path), so this is a trip - unless the deadline is disabled.
      return INVOCATION_DEADLINE_MS > 0
        ? `Stopped: the turn hit its ${INVOCATION_DEADLINE_MS}ms deadline (INVOCATION_DEADLINE_MS).`
        : undefined;
    default:
      return undefined;
  }
}

/** Read the Agent's cumulative token usage, defaulting each field to 0. */
function readUsage(agent: Agent): TokenUsage {
  const u = (agent as unknown as { metrics?: { accumulatedUsage?: Record<string, number> } }).metrics
    ?.accumulatedUsage;
  return {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheReadTokens: u?.cacheReadInputTokens ?? 0,
    cacheWriteTokens: u?.cacheWriteInputTokens ?? 0,
  };
}

export async function runAgentTurn(
  agent: Agent,
  sessionId: string,
  agentId: string,
  prompt: string,
  /** The run these events belong to - see EventFields.runId. */
  runId?: string,
  /**
   * This agent's resolved integrations, used only to name an integration call after the
   * API it called (`integrationCallLabel`). Empty for an agent with none.
   */
  integrations: ResolvedIntegration[] = [],
): Promise<TurnResult> {
  let finalText = "";
  let stopReason: string | undefined;
  const toolCalls: Array<{ name: string }> = [];

  // The per-turn budget (see config.ts for what it's for and how to tune it). A `0`
  // knob becomes `undefined`, which the SDK treats as "no cap on that dimension".
  const options = {
    limits: {
      turns: MAX_TURNS_PER_INVOCATION || undefined,
      totalTokens: MAX_TOKENS_PER_INVOCATION || undefined,
    },
    cancelSignal: INVOCATION_DEADLINE_MS ? AbortSignal.timeout(INVOCATION_DEADLINE_MS) : undefined,
  };

  for await (const ev of agent.stream(prompt, options)) {
    // The terminal event carries WHY the loop stopped. `for await` discards the
    // generator's return value, so this event is the only place we see it.
    const done = ev as { type?: string; result?: { stopReason?: string } };
    if (done.type === "agentResultEvent" && done.result?.stopReason) {
      stopReason = done.result.stopReason;
    }
    for (const parsed of parseStreamEvent(ev)) {
      // One naming decision for both surfaces: the trajectory event and the metric
      // count get the SAME label, so a step in the trace and a series on the Monitor
      // tab can't spell the same call two ways.
      const fields =
        parsed.type === "tool_input" && parsed.fields.toolName
          ? { ...parsed.fields, toolName: integrationCallLabel(parsed.fields.toolName, parsed.fields.input, integrations) }
          : parsed.fields;
      await record(sessionId, agentId, parsed.type, { runId, ...fields });
      if (parsed.type === "text" && fields.content) {
        finalText = fields.content; // last assistant text is the answer
      } else if (parsed.type === "tool_input" && fields.toolName) {
        toolCalls.push({ name: fields.toolName });
      }
    }
  }

  return { finalText, toolCalls, usage: readUsage(agent), stopReason };
}
