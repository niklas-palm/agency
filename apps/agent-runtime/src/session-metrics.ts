/**
 * Per-session metric summary writer (runtime side).
 *
 * A microVM serves exactly one session for its whole lifetime (up to 8h, across
 * many back-and-forth triggers). We accumulate stats in memory and OVERWRITE a
 * single summary row each time the session goes idle (and on error) - so N
 * triggers on a live session stay one row, refreshed with the latest totals. The
 * row is keyed by (agentId, runId): `runId` is a per-lifetime nonce, so if a
 * client reuses the same sessionId after this microVM has exited, the fresh
 * microVM writes a NEW row rather than clobbering this lifetime's metrics.
 *
 * Best-effort, exactly like trajectory writes: a failure here must never abort a
 * turn (metrics are observability, not the agent's work).
 */
import { v7 as uuidv7 } from "uuid";
import type { SessionSummary, TokenUsage, ModelKey } from "@agency/shared";
import { zeroTokens } from "@agency/shared";
import { postIngest } from "./ingest.js";

/** Mutable accumulator for the current session's metrics (one per microVM). */
export interface SessionAccumulator {
  agentId: string;
  sessionId: string;
  version: number;
  /** The model this session ran on (for per-model cost pricing on the read side). */
  model: ModelKey;
  /** Stable per-lifetime id → the summary row's sort key; enables overwrite. */
  runId: string;
  startedAt: string;
  /** Opening trigger (1) + each accepted injection. */
  invocations: number;
  turns: number;
  toolUses: number;
  toolBreakdown: Record<string, number>;
  injections: number;
  /**
   * Duration (ms) of each invocation = one continuous working span: from when the
   * agent starts running until it goes idle (`session_end`). A message injected
   * mid-work folds into the current span (still one invocation); a re-trigger
   * after idle starts a new span. This - NOT the whole-lifetime `startedAt→endedAt`
   * gap, which includes idle time between invocations - is what "how long did a
   * run take" means. Duration percentiles aggregate over these.
   */
  invocationDurationsMs: number[];
  /**
   * Latest CUMULATIVE token usage for the session (from the Agent's Meter, which
   * is never reset across turns). Stored as the latest snapshot, NOT summed - the
   * Meter already accumulates, so summing per-turn would double-count.
   */
  tokens: TokenUsage;
  /**
   * Token totals from Agents this session has ALREADY retired.
   *
   * `tokens` mirrors the live Agent's cumulative meter, so it's overwritten rather than
   * summed. But an errored turn nulls the warm Agent (server.ts) while this accumulator
   * survives - the next invoke builds a new Agent with a ZEROED meter, so overwriting
   * would replace a large total with a small one and silently under-report cost.
   * `sealTokens` folds the dying Agent's total in here first.
   */
  retiredTokens: TokenUsage;
}

/** Start accumulating for a fresh session lifetime. Its opening trigger counts as invocation #1. */
export function newAccumulator(agentId: string, sessionId: string, version: number, model: ModelKey): SessionAccumulator {
  return {
    agentId,
    sessionId,
    version,
    model,
    runId: uuidv7(), // time-ordered → summaries sort by session start
    startedAt: new Date().toISOString(),
    invocations: 1,
    turns: 0,
    toolUses: 0,
    // Null-prototype: the KEY is a model-supplied tool name, and a hallucinated
    // "constructor" would otherwise read Object.prototype.constructor and string-concat
    // into the count, while "__proto__" would silently drop it. (`costFor` in
    // packages/shared applies the same defense with Object.hasOwn.)
    toolBreakdown: Object.create(null) as Record<string, number>,
    injections: 0,
    invocationDurationsMs: [],
    tokens: zeroTokens(),
    retiredTokens: zeroTokens(),
  };
}

/** Record one invocation's active duration (a completed working span), in ms. */
export function recordInvocationDuration(acc: SessionAccumulator, ms: number): void {
  acc.invocationDurationsMs.push(ms);
}

/** Fold one turn's counts into the accumulator. */
export function accumulateTurn(
  acc: SessionAccumulator,
  turn: { toolCalls: Array<{ name: string }>; usage?: TokenUsage },
): void {
  acc.turns += 1;
  for (const call of turn.toolCalls) {
    acc.toolUses += 1;
    acc.toolBreakdown[call.name] = (acc.toolBreakdown[call.name] ?? 0) + 1;
  }
  // usage is the CUMULATIVE session total (the Meter isn't reset per turn), so
  // OVERWRITE with the latest snapshot rather than adding - adding would
  // double-count. Captured here (from the turn) so writeSummary never has to
  // touch the warm Agent, which is nulled before the error-path summary write.
  if (turn.usage) acc.tokens = turn.usage;
}

/**
 * Fold the current Agent's token total into the retired baseline.
 *
 * Call this whenever the warm Agent is discarded (the error path) while the session -
 * and so this accumulator - lives on. The replacement Agent starts with a fresh meter,
 * so without sealing, its first snapshot would OVERWRITE the tokens already spent.
 */
export function sealTokens(acc: SessionAccumulator): void {
  acc.retiredTokens = addTokens(acc.retiredTokens, acc.tokens);
  acc.tokens = zeroTokens();
}

function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/**
 * Write (or overwrite) the session's summary. Called at each idle point and on
 * error; the stable (agentId, runId) key means repeated POSTs replace the one row
 * rather than appending. POSTs to the control-plane ingest API (best-effort - the
 * runtime writes no DynamoDB directly).
 */
export async function writeSummary(acc: SessionAccumulator, outcome: "ok" | "error"): Promise<void> {
  const endedAt = new Date();
  const summary: SessionSummary & { runId: string } = {
    agentId: acc.agentId,
    sessionId: acc.sessionId,
    version: acc.version,
    model: acc.model,
    startedAt: acc.startedAt,
    endedAt: endedAt.toISOString(),
    // Whole-lifetime span (kept for reference); NOT used for duration percentiles -
    // it includes idle time between invocations. Per-invocation durations below.
    durationMs: endedAt.getTime() - Date.parse(acc.startedAt),
    invocations: acc.invocations,
    invocationDurationsMs: acc.invocationDurationsMs,
    turns: acc.turns,
    toolUses: acc.toolUses,
    toolBreakdown: acc.toolBreakdown,
    injections: acc.injections,
    outcome,
    // Live meter + everything retired by an Agent this session already discarded.
    tokens: addTokens(acc.retiredTokens, acc.tokens),
    // The sort key is runId; carried explicitly on the item.
    runId: acc.runId,
  };
  await postIngest("/internal/session-summary", summary);
}
