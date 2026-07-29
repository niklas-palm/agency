/**
 * Session-summary read + aggregation (the metrics engine, read side). The
 * runtime writes one durable summary row per session lifetime, keyed by
 * (agentId, runId); this module queries an agent's rows and rolls them up into
 * the dashboard shape. Ownership is enforced at the route (the agent record is
 * org-checked (canView) first), so rows carry no orgId.
 *
 * Aggregation is done in code over a bounded window rather than pre-computed:
 * session volumes are modest, and this keeps the write path a single Put with no
 * rollup coordination. If volume ever demands it, add bucket rollup rows. The
 * pure `aggregate()` is separated from the DynamoDB fetch so it's unit-tested
 * without a database.
 */
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type {
  MetricsSummary,
  MetricsBucket,
  MetricsGranularity,
  SessionSummary,
  SessionSummaryInput,
  TokenUsage,
} from "@agency/shared";
import { costFor, normalizeUsage, tokenTotal, zeroTokens } from "@agency/shared";
import { ddb } from "../ddb.js";
import { SESSIONS_TABLE } from "../config.js";

/**
 * Upsert a session summary posted by the runtime's ingest API. Keyed by
 * (agentId, runId): the runtime overwrites this one row at each idle point across
 * a session's many invocations, so a repeated POST replaces rather than appends.
 * No TTL - the sessions table is durable (metrics history is retained); the table
 * has no TTL attribute configured, so a `ttl` field would be a dead no-op.
 */
export async function writeSummary(s: SessionSummaryInput): Promise<void> {
  await ddb.send(new PutCommand({ TableName: SESSIONS_TABLE, Item: { ...s } }));
}

/**
 * Coerce a self-reported metric field to a real number.
 *
 * Every numeric on a summary row is written by the RUNTIME and the ingest route doesn't
 * validate its shape, so a missing or non-numeric field must contribute 0 rather than
 * NaN. One NaN propagates through the sums into every total, percentile and bucket -
 * turning the whole window's dashboard into `null` on the wire.
 */
function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** The model a session ran on (empty for legacy rows written before it was recorded). */
function modelOf(s: SessionSummary): string {
  return s.model ?? "";
}

/**
 * How far BEFORE the requested window we must still read. `runId` marks when a
 * session STARTED but the window filters on `endedAt`, so a long-running session
 * can start well before the window and end inside it. AgentCore keeps a session
 * alive up to 8h, so backing the key bound off by that much can't miss a row.
 */
const MAX_SESSION_MS = 8 * 60 * 60 * 1000;

/**
 * The smallest UUIDv7 that could have been generated at `ms`. A UUIDv7's leading
 * 48 bits are the unix-ms timestamp in fixed-width lowercase hex, so these sort
 * lexicographically by time and DynamoDB can range-scan them as strings.
 */
export function runIdLowerBound(ms: number): string {
  const hex = Math.max(0, ms).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

/**
 * Fetch the agent's session summaries that could fall in [from, to], following
 * pagination so a large history isn't truncated at a single 1 MB page. Rows are
 * keyed (agentId, runId), so this is a partition query BOUNDED on the sort key:
 * the dashboard polls every ~15s, and reading an agent's entire lifetime history
 * each time made cost grow without limit as the agent got older.
 *
 * The bound is deliberately loose (see MAX_SESSION_MS) - it narrows the read
 * without changing the result, and `aggregate` still applies the exact window.
 */
async function listSummaries(agentId: string, from: string): Promise<SessionSummary[]> {
  const since = runIdLowerBound(Date.parse(from) - MAX_SESSION_MS);
  const out: SessionSummary[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: SESSIONS_TABLE,
        KeyConditionExpression: "agentId = :a AND runId >= :since",
        ExpressionAttributeValues: { ":a": agentId, ":since": since },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const it of res.Items ?? []) out.push(it as SessionSummary);
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return out;
}

/**
 * The most recent runs for an agent, newest first.
 *
 * No time window and no aggregation - this is the run LIST, so it wants the latest N
 * whenever they happened. `runId` is a UUIDv7, so a descending query on the sort key is
 * already newest-first with no sorting in code, and `Limit` genuinely bounds the read
 * (unlike a filtered query, where Limit counts scanned rows).
 *
 * One row per runtime lifetime, and the rows are retained forever - so this is the
 * durable index of run history even though the trajectory table expires (see
 * repo/traces.ts).
 */
export async function listRuns(agentId: string, limit: number): Promise<SessionSummaryInput[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: SESSIONS_TABLE,
      KeyConditionExpression: "agentId = :a",
      ExpressionAttributeValues: { ":a": agentId },
      ScanIndexForward: false, // newest runId first
      Limit: limit,
    }),
  );
  return (res.Items as SessionSummaryInput[] | undefined) ?? [];
}

/**
 * One run's summary row, or null. Used to open a run: it resolves the run to the
 * session whose trajectory holds its events, and - because the row must exist in THIS
 * agent's partition - it also proves the caller named a real run of theirs before that
 * id is used to build an S3 key.
 */
export async function getRun(agentId: string, runId: string): Promise<SessionSummaryInput | null> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: SESSIONS_TABLE,
      KeyConditionExpression: "agentId = :a AND runId = :r",
      ExpressionAttributeValues: { ":a": agentId, ":r": runId },
      Limit: 1,
    }),
  );
  return ((res.Items as SessionSummaryInput[] | undefined) ?? [])[0] ?? null;
}

/** The bucket key for a timestamp: `YYYY-MM-DDTHH` hourly, `YYYY-MM-DD` daily. */
function bucketKey(iso: string, g: MetricsGranularity): string {
  return g === "hour" ? iso.slice(0, 13) : iso.slice(0, 10);
}

/** Every bucket key across [from, to] inclusive, so the axis is continuous. */
export function bucketKeys(from: string, to: string, g: MetricsGranularity): string[] {
  const stepMs = g === "hour" ? 3_600_000 : 86_400_000;
  // Snap the start down to its bucket boundary so partial edge buckets align.
  const startMs = Date.parse(bucketKey(from, g) + (g === "hour" ? ":00:00Z" : "T00:00:00Z"));
  const endMs = Date.parse(to);
  const keys: string[] = [];
  for (let t = startMs; t <= endMs; t += stepMs) {
    keys.push(bucketKey(new Date(t).toISOString(), g));
  }
  return keys;
}

/** The p-th percentile (0-100) of a numeric list, via nearest-rank. 0 if empty. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

/**
 * Pure aggregation: roll session summaries within [from, to] (optionally one
 * version) into the dashboard summary at the given granularity. Empty buckets are
 * filled so the chart axis is continuous. Exported for unit testing.
 */
export function aggregate(
  rows: SessionSummary[],
  from: string,
  to: string,
  granularity: MetricsGranularity,
  version: number | null,
): MetricsSummary {
  const inWindow = rows.filter(
    (s) => s.endedAt >= from && s.endedAt <= to && (version === null || s.version === version),
  );

  const buckets = new Map<string, MetricsBucket>();
  for (const key of bucketKeys(from, to, granularity)) {
    buckets.set(key, { bucket: key, sessions: 0, invocations: 0, errors: 0, toolUses: 0, toolBreakdown: {}, durationMsTotal: 0, tokens: 0, costUsd: 0 });
  }

  const toolBreakdown: Record<string, number> = {};
  const durations: number[] = [];
  const costs: number[] = []; // per-session cost, for percentiles
  const tokens: TokenUsage = zeroTokens();
  let sessions = 0;
  let invocations = 0;
  let errors = 0;
  let toolUses = 0;
  let durationMsTotal = 0;
  let costUsd = 0;

  for (const s of inWindow) {
    // Legacy rows written before invocations existed: treat as 1 (the opening trigger).
    const inv = num(s.invocations, 1);
    // Legacy rows written before token tracking: treat as all-zero. `normalizeUsage`
    // coerces field-by-field (a self-reported bundle can carry a non-numeric value, and
    // `+=` on a string CONCATENATES - one bad row turned the window's token totals into
    // "0abc") and makes the drivers disjoint, since an OpenAI row counts its cache reads
    // inside inputTokens and would otherwise be summed - and charged - twice.
    const t: TokenUsage = normalizeUsage(modelOf(s), s.tokens);
    const sessionTokens = tokenTotal(t);
    // Cost is priced per session at its own model's rate (read-side, so a price
    // correction re-prices history on the next dashboard load).
    const sessionCost = costFor(modelOf(s), t);
    sessions += 1;
    invocations += inv;
    toolUses += num(s.toolUses);
    // Duration percentiles are PER INVOCATION (a working span run→idle), not per
    // session (which includes idle gaps between invocations). Legacy rows written
    // before per-invocation timing lack the array - fall back to the whole-session
    // durationMs as a single sample so old data still charts something reasonable.
    const invDurations = (s.invocationDurationsMs?.length ? s.invocationDurationsMs : [s.durationMs]).map(
      (d) => num(d),
    );
    for (const d of invDurations) {
      durationMsTotal += d;
      durations.push(d);
    }
    tokens.inputTokens += t.inputTokens;
    tokens.outputTokens += t.outputTokens;
    tokens.cacheReadTokens += t.cacheReadTokens;
    tokens.cacheWriteTokens += t.cacheWriteTokens;
    costUsd += sessionCost;
    costs.push(sessionCost);
    if (s.outcome === "error") errors += 1;
    for (const [tool, n] of Object.entries(s.toolBreakdown ?? {})) {
      toolBreakdown[tool] = (toolBreakdown[tool] ?? 0) + num(n);
    }
    // A session whose bucket falls outside the pre-filled range (shouldn't happen
    // given the window filter, but be defensive) still counts in totals; only its
    // bucket line is skipped.
    const b = buckets.get(bucketKey(s.endedAt, granularity));
    if (b) {
      b.sessions += 1;
      b.invocations += inv;
      b.errors += s.outcome === "error" ? 1 : 0;
      b.toolUses += num(s.toolUses);
      for (const d of invDurations) b.durationMsTotal += d;
      b.tokens += sessionTokens;
      b.costUsd += sessionCost;
      for (const [tool, n] of Object.entries(s.toolBreakdown ?? {})) {
        b.toolBreakdown[tool] = (b.toolBreakdown[tool] ?? 0) + num(n);
      }
    }
  }

  durations.sort((a, b) => a - b);
  costs.sort((a, b) => a - b);
  return {
    from,
    to,
    granularity,
    version,
    sessions,
    invocations,
    errors,
    toolUses,
    // Mean per-invocation duration (durations[] holds one entry per invocation).
    avgDurationMs: durations.length ? Math.round(durationMsTotal / durations.length) : 0,
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    p99DurationMs: percentile(durations, 99),
    toolBreakdown,
    tokens,
    totalTokens: tokenTotal(tokens),
    costUsd,
    avgCostUsd: sessions ? costUsd / sessions : 0,
    p50CostUsd: percentile(costs, 50),
    p95CostUsd: percentile(costs, 95),
    p99CostUsd: percentile(costs, 99),
    series: [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
  };
}

/** Fetch + aggregate an agent's metrics over the window. */
export async function metricsFor(
  agentId: string,
  from: string,
  to: string,
  granularity: MetricsGranularity,
  version: number | null,
): Promise<MetricsSummary> {
  const rows = await listSummaries(agentId, from);
  return aggregate(rows, from, to, granularity, version);
}
