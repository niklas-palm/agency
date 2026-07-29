import { describe, it, expect } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { SessionSummary } from "@agency/shared";
import { aggregate, bucketKeys, percentile, runIdLowerBound } from "./repo/sessions.js";

function session(over: Partial<SessionSummary>): SessionSummary {
  return {
    agentId: "a",
    sessionId: "s",
    version: 1,
    startedAt: "2026-07-20T10:00:00.000Z",
    endedAt: "2026-07-20T10:00:05.000Z",
    durationMs: 5000,
    invocations: 1,
    turns: 1,
    toolUses: 0,
    toolBreakdown: {},
    injections: 0,
    outcome: "ok",
    ...over,
  };
}

describe("percentile (nearest-rank)", () => {
  it("returns 0 for an empty list", () => {
    expect(percentile([], 50)).toBe(0);
  });
  it("computes p50/p95/p99 over a sorted list", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100 sorted
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile(xs, 99)).toBe(99);
    expect(percentile(xs, 100)).toBe(100);
  });
});

// The metrics query bounds the sort key with this instead of reading an agent's
// whole lifetime history on every 15s dashboard poll. It is only sound if it sorts
// strictly BELOW every runId generated at or after its timestamp - a bound that's
// even slightly too high silently drops sessions from the dashboard.
describe("runIdLowerBound", () => {
  it("sorts below real uuidv7s generated at that moment or later", () => {
    const bound = runIdLowerBound(Date.now());
    for (let i = 0; i < 50; i++) {
      expect(uuidv7() >= bound).toBe(true);
    }
  });

  it("sorts above uuidv7s generated before it", () => {
    const earlier = Array.from({ length: 20 }, () => uuidv7());
    const bound = runIdLowerBound(Date.now() + 1000);
    for (const id of earlier) expect(id < bound).toBe(true);
  });

  it("is a well-formed, fixed-width uuid so string ordering matches time ordering", () => {
    expect(runIdLowerBound(Date.parse("2026-07-20T10:00:00Z"))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-0{12}$/,
    );
    // Fixed width is what makes lexicographic == chronological: an earlier instant
    // must never produce a LONGER string that sorts above a later one.
    const a = runIdLowerBound(Date.parse("2001-09-09T01:46:40Z")); // 1e12 ms
    const b = runIdLowerBound(Date.parse("2026-07-20T10:00:00Z"));
    expect(a.length).toBe(b.length);
    expect(a < b).toBe(true);
  });

  it("clamps a negative instant rather than emitting a malformed bound", () => {
    expect(runIdLowerBound(-5)).toBe(runIdLowerBound(0));
  });
});

describe("bucketKeys", () => {
  it("emits hourly keys across a window, inclusive and boundary-snapped", () => {
    const keys = bucketKeys("2026-07-20T10:30:00Z", "2026-07-20T12:15:00Z", "hour");
    expect(keys).toEqual(["2026-07-20T10", "2026-07-20T11", "2026-07-20T12"]);
  });
  it("emits daily keys across a window", () => {
    const keys = bucketKeys("2026-07-18T06:00:00Z", "2026-07-20T06:00:00Z", "day");
    expect(keys).toEqual(["2026-07-18", "2026-07-19", "2026-07-20"]);
  });
});

describe("aggregate", () => {
  const from = "2026-07-20T09:00:00Z";
  const to = "2026-07-20T12:00:00Z";

  it("fills empty buckets so the series is continuous", () => {
    const out = aggregate([session({ endedAt: "2026-07-20T10:30:00Z" })], from, to, "hour", null);
    expect(out.series.map((b) => b.bucket)).toEqual([
      "2026-07-20T09",
      "2026-07-20T10",
      "2026-07-20T11",
      "2026-07-20T12",
    ]);
    expect(out.series.find((b) => b.bucket === "2026-07-20T10")!.sessions).toBe(1);
    expect(out.series.find((b) => b.bucket === "2026-07-20T09")!.sessions).toBe(0);
  });

  it("filters to the window and by version", () => {
    const rows = [
      session({ endedAt: "2026-07-20T10:00:00Z", version: 1 }),
      session({ endedAt: "2026-07-20T11:00:00Z", version: 2 }),
      session({ endedAt: "2026-07-19T10:00:00Z", version: 1 }), // before window
    ];
    expect(aggregate(rows, from, to, "hour", null).sessions).toBe(2); // both in-window
    expect(aggregate(rows, from, to, "hour", 1).sessions).toBe(1); // v1 in-window only
    expect(aggregate(rows, from, to, "hour", 2).sessions).toBe(1);
  });

  it("totals errors, tool uses + breakdown, and duration percentiles", () => {
    const rows = [
      session({ endedAt: "2026-07-20T10:00:00Z", durationMs: 1000, toolUses: 2, toolBreakdown: { run_bash: 2 }, outcome: "ok" }),
      session({ endedAt: "2026-07-20T10:30:00Z", durationMs: 3000, toolUses: 1, toolBreakdown: { web_search: 1 }, outcome: "error" }),
      session({ endedAt: "2026-07-20T11:00:00Z", durationMs: 5000, toolUses: 3, toolBreakdown: { run_bash: 3 }, outcome: "ok" }),
    ];
    const out = aggregate(rows, from, to, "hour", null);
    expect(out.sessions).toBe(3);
    expect(out.errors).toBe(1);
    expect(out.toolUses).toBe(6);
    expect(out.toolBreakdown).toEqual({ run_bash: 5, web_search: 1 });
    expect(out.avgDurationMs).toBe(3000); // (1000+3000+5000)/3
    expect(out.p50DurationMs).toBe(3000); // nearest-rank of [1000,3000,5000]
    expect(out.p99DurationMs).toBe(5000);
  });

  it("duration percentiles are PER INVOCATION, not per session", () => {
    // One session with THREE invocation spans (100ms, 200ms, 900ms) and a big
    // whole-lifetime durationMs (includes idle gaps - must NOT be used).
    const rows = [
      session({
        endedAt: "2026-07-20T10:00:00Z",
        durationMs: 999_999, // lifetime incl. idle - ignored for percentiles
        invocationDurationsMs: [100, 200, 900],
      }),
    ];
    const out = aggregate(rows, from, to, "hour", null);
    expect(out.sessions).toBe(1);
    // Averaged over the 3 invocations, not the 1 session, and not the 999999 gap.
    expect(out.avgDurationMs).toBe(400); // (100+200+900)/3
    expect(out.p50DurationMs).toBe(200); // nearest-rank of [100,200,900]
    expect(out.p99DurationMs).toBe(900);
  });

  it("legacy rows (no invocationDurationsMs) fall back to whole-session durationMs", () => {
    const legacy = session({ endedAt: "2026-07-20T10:00:00Z", durationMs: 4200 });
    delete (legacy as { invocationDurationsMs?: number[] }).invocationDurationsMs;
    const out = aggregate([legacy], from, to, "hour", null);
    expect(out.avgDurationMs).toBe(4200);
    expect(out.p50DurationMs).toBe(4200);
  });

  it("returns zeros (no NaN) for an empty window", () => {
    const out = aggregate([], from, to, "hour", null);
    expect(out.sessions).toBe(0);
    expect(out.invocations).toBe(0);
    expect(out.avgDurationMs).toBe(0);
    expect(out.p50DurationMs).toBe(0);
    expect(out.series.every((b) => b.sessions === 0 && b.invocations === 0)).toBe(true);
  });

  it("totals invocations across sessions (window + per bucket)", () => {
    const rows = [
      session({ endedAt: "2026-07-20T10:00:00Z", invocations: 3 }),
      session({ endedAt: "2026-07-20T10:30:00Z", invocations: 1 }),
      session({ endedAt: "2026-07-20T11:00:00Z", invocations: 2 }),
    ];
    const out = aggregate(rows, from, to, "hour", null);
    expect(out.sessions).toBe(3);
    expect(out.invocations).toBe(6); // 3+1+2
    const h10 = out.series.find((b) => b.bucket === "2026-07-20T10")!;
    expect(h10.sessions).toBe(2);
    expect(h10.invocations).toBe(4); // 3+1 in the 10:00 hour
  });

  it("defaults legacy rows (no invocations field) to 1", () => {
    const legacy = session({ endedAt: "2026-07-20T10:00:00Z" });
    delete (legacy as { invocations?: number }).invocations;
    expect(aggregate([legacy], from, to, "hour", null).invocations).toBe(1);
  });

  it("totals tokens and prices cost per session's own model", () => {
    const rows = [
      // haiku: input $1.10/MTok, output $5.50/MTok → 1_000_000*1.1 + 200_000*5.5 = $2.20
      session({
        endedAt: "2026-07-20T10:00:00Z",
        model: "haiku-4.5",
        tokens: { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
      // opus: input $5.50/MTok → 1_000_000*5.5 = $5.50
      session({
        endedAt: "2026-07-20T10:30:00Z",
        model: "opus-4.8",
        tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    ];
    const out = aggregate(rows, from, to, "hour", null);
    expect(out.tokens).toEqual({ inputTokens: 2_000_000, outputTokens: 200_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(out.totalTokens).toBe(2_200_000);
    expect(out.costUsd).toBeCloseTo(7.7, 6); // $2.20 (haiku) + $5.50 (opus)
    const h10 = out.series.find((b) => b.bucket === "2026-07-20T10")!;
    expect(h10.tokens).toBe(2_200_000);
    expect(h10.costUsd).toBeCloseTo(7.7, 6);
    // Per-session cost: mean + percentiles over the two sessions ($2.20, $5.50).
    expect(out.avgCostUsd).toBeCloseTo(3.85, 6); // (2.2+5.5)/2
    expect(out.p50CostUsd).toBeCloseTo(2.2, 6); // nearest-rank of [2.2,5.5]
    expect(out.p95CostUsd).toBeCloseTo(5.5, 6);
    expect(out.p99CostUsd).toBeCloseTo(5.5, 6);
  });

  it("doesn't double-count an OpenAI row's cache reads (they sit inside inputTokens)", () => {
    // Bedrock reports the four drivers disjoint; OpenAI counts cache hits INSIDE
    // input_tokens (verified on the wire - see docs/metrics.md). Both rows below claim
    // the same shape, so summing them the same way charges the OpenAI cache hits twice:
    // once at the input rate and again at the cache-read rate.
    const tokens = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 900_000, cacheWriteTokens: 0 };
    const openai = aggregate(
      [session({ endedAt: "2026-07-20T10:00:00Z", model: "gpt-5.6-luna", tokens })],
      from, to, "hour", null,
    );
    const bedrock = aggregate(
      [session({ endedAt: "2026-07-20T10:00:00Z", model: "haiku-4.5", tokens })],
      from, to, "hour", null,
    );

    // OpenAI: 100_000 tokens were actually new input, 900_000 were a cache hit.
    expect(openai.tokens.inputTokens).toBe(100_000);
    expect(openai.totalTokens).toBe(1_000_000);
    // luna: $1/MTok input, $0.10/MTok cached → 0.1*1 + 0.9*0.1 = $0.19
    expect(openai.costUsd).toBeCloseTo(0.19, 6);

    // Bedrock: nothing subtracted - a real Anthropic row has cacheRead far ABOVE
    // inputTokens, so the same subtraction would zero out its input.
    expect(bedrock.tokens.inputTokens).toBe(1_000_000);
    expect(bedrock.totalTokens).toBe(1_900_000);
    // haiku: $1.10/MTok input, $0.11/MTok cached → 1*1.1 + 0.9*0.11 = $1.199
    expect(bedrock.costUsd).toBeCloseTo(1.199, 6);
  });

  it("treats legacy rows (no tokens/model) as zero tokens and zero cost", () => {
    const legacy = session({ endedAt: "2026-07-20T10:00:00Z" });
    const out = aggregate([legacy], from, to, "hour", null);
    expect(out.totalTokens).toBe(0);
    expect(out.costUsd).toBe(0);
    expect(out.avgCostUsd).toBe(0);
    expect(out.p50CostUsd).toBe(0);
  });

  it("builds a per-tool breakdown per bucket (for the per-tool series)", () => {
    const rows = [
      session({ endedAt: "2026-07-20T10:00:00Z", toolBreakdown: { run_bash: 2, skills: 1 } }),
      session({ endedAt: "2026-07-20T11:00:00Z", toolBreakdown: { run_bash: 1 } }),
    ];
    const out = aggregate(rows, from, to, "hour", null);
    expect(out.series.find((b) => b.bucket === "2026-07-20T10")!.toolBreakdown).toEqual({ run_bash: 2, skills: 1 });
    expect(out.series.find((b) => b.bucket === "2026-07-20T11")!.toolBreakdown).toEqual({ run_bash: 1 });
    expect(out.toolBreakdown).toEqual({ run_bash: 3, skills: 1 });
  });
});

describe("aggregate defends self-reported numerics", () => {
  const WINDOW = ["2026-07-20T00:00:00.000Z", "2026-07-20T23:59:59.999Z"] as const;
  const agg = (rows: SessionSummary[]) => aggregate(rows, WINDOW[0], WINDOW[1], "day", null);

  /**
   * Every numeric on a summary row is written by the RUNTIME, and the ingest route
   * validates only the token + runId. So ONE malformed row must not poison the window:
   * NaN propagates through every sum, percentile and bucket, and JSON renders it as
   * `null` - a dashboard of nulls for the whole agent.
   */
  it("a row missing toolUses doesn't NaN the window", () => {
    const bad = session({ toolUses: undefined as unknown as number });
    const m = agg([session({ toolUses: 2 }), bad]);
    expect(m.toolUses).toBe(2);
    expect(m.series.every((b) => Number.isFinite(b.toolUses))).toBe(true);
  });

  it("a row missing durationMs doesn't NaN the duration stats", () => {
    const bad = session({ durationMs: undefined as unknown as number });
    const m = agg([bad]);
    for (const v of [m.avgDurationMs, m.p50DurationMs, m.p95DurationMs, m.p99DurationMs]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("a non-numeric toolBreakdown value doesn't NaN the breakdown", () => {
    const bad = session({ toolBreakdown: { run_bash: "lots" as unknown as number } });
    const m = agg([session({ toolBreakdown: { run_bash: 3 } }), bad]);
    expect(m.toolBreakdown.run_bash).toBe(3);
  });

  it("a partial tokens bundle doesn't NaN tokens or cost", () => {
    const bad = session({
      model: "haiku-4.5",
      tokens: { inputTokens: 100 } as unknown as SessionSummary["tokens"],
    });
    const m = agg([bad]);
    expect(m.totalTokens).toBe(100);
    expect(Number.isFinite(m.costUsd)).toBe(true);
    expect(Number.isFinite(m.avgCostUsd)).toBe(true);
  });

  it("a non-numeric TOKEN field doesn't NaN or string-concat the totals", () => {
    // `+=` on a string concatenates, so this used to render tokens as "0abc" and cost
    // as null for the entire window.
    const bad = session({
      model: "haiku-4.5",
      tokens: { inputTokens: "abc", outputTokens: 5 } as unknown as SessionSummary["tokens"],
    });
    const m = agg([bad]);
    expect(m.tokens.inputTokens).toBe(0);
    expect(m.tokens.outputTokens).toBe(5);
    expect(m.totalTokens).toBe(5);
    expect(Number.isFinite(m.costUsd)).toBe(true);
    expect(Number.isFinite(m.p95CostUsd)).toBe(true);
  });

  it("a non-numeric invocations falls back to 1, not NaN", () => {
    const m = agg([session({ invocations: "two" as unknown as number })]);
    expect(m.invocations).toBe(1);
  });
});
