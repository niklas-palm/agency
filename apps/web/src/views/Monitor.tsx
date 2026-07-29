/**
 * The operational metrics dashboard for an agent: stat tiles + smooth time-series
 * area charts + a tool-usage breakdown, over a selectable window. Reused by the
 * agent detail Monitor tab (all versions) and the version page (one version).
 *
 * Charts use Recharts (smooth monotone areas). Per the frontend guidance the
 * initial grow animation is off (`isAnimationActive={false}`) - the dashboard
 * refreshes every 15s and animating each refresh would be noise, not signal.
 */
import { useEffect, useId, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AgentRun, AgentRunTrace, MetricsSummary } from "@agency/shared";
import { ChevronRight } from "lucide-react";
import { getMetrics, listRuns, getRunTrace } from "../api.js";
import { Divider, ErrorNote, prettyTool, Skeleton, Stat, TINT } from "../components.js";
import { Trace } from "../Trace.js";

// Selectable windows, in hours. Default 24h (hourly x-axis). Windows up to 7d are
// hourly, above that daily - the server picks granularity from the window.
const WINDOWS: { label: string; hours: number }[] = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 24 * 7 },
  { label: "30d", hours: 24 * 30 },
];

export function Monitor({ agentId, version }: { agentId: string; version?: number }) {
  const [hours, setHours] = useState<number>(24);
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [err, setErr] = useState("");

  // Load on window/version change, then refresh in place every 15s so an open
  // dashboard stays live. Only the first load shows the skeleton; transient
  // refresh failures are ignored (keep the last good data).
  useEffect(() => {
    let stop = false;
    setMetrics(null);
    const load = (initial: boolean) =>
      getMetrics(agentId, hours, version)
        .then((m) => !stop && setMetrics(m))
        .catch((e) => initial && !stop && setErr(String(e)));
    load(true);
    const t = setInterval(() => load(false), 15_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [agentId, hours, version]);

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-x-8 gap-y-5">
          <Stat value={metrics?.sessions ?? "-"} label="Sessions" />
          <Stat value={metrics?.invocations ?? "-"} label="Invocations" />
          <Stat value={metrics ? avgPerSession(metrics) : "-"} label="Msgs / session" />
          <Stat
            value={metrics?.errors ?? "-"}
            label="Errors"
            tint={metrics && metrics.errors > 0 ? TINT.danger : undefined}
          />
          <Stat value={metrics?.toolUses ?? "-"} label="Tool calls" />
          <Stat value={metrics ? fmtTokens(metrics.totalTokens) : "-"} label="Tokens" />
          <Stat value={metrics ? fmtCost(metrics.costUsd) : "-"} label="Total spend" />
          <Stat value={metrics ? fmtDuration(metrics.p50DurationMs) : "-"} label="p50 / run" />
          <Stat value={metrics ? fmtDuration(metrics.p95DurationMs) : "-"} label="p95 / run" />
        </div>
        <WindowToggle hours={hours} onChange={setHours} />
      </div>

      {/* Per-session cost: mean + percentiles, shown once there's any spend. */}
      {metrics && metrics.totalTokens > 0 && (
        <div className="flex flex-wrap gap-x-8 gap-y-5 rounded-xl border border-line bg-surface p-4">
          <div className="label self-center pr-1 text-faint">Cost / session</div>
          <Stat value={fmtCostPrecise(metrics.avgCostUsd)} label="Mean" />
          <Stat value={fmtCostPrecise(metrics.p50CostUsd)} label="p50" />
          <Stat value={fmtCostPrecise(metrics.p95CostUsd)} label="p95" />
          <Stat value={fmtCostPrecise(metrics.p99CostUsd)} label="p99" />
        </div>
      )}

      {err && <ErrorNote message={err} />}
      {!metrics && !err && <Skeleton className="h-48 rounded-xl" />}

      {metrics && (
        <div className="space-y-6">
          <Chart
            title="Sessions & invocations"
            metrics={metrics}
            series={[
              { field: "sessions", label: "sessions", tint: TINT.accent },
              { field: "invocations", label: "invocations", tint: TINT.accentInk },
            ]}
          />
          {metrics.errors > 0 && (
            <Chart title="Errors" metrics={metrics} series={[{ field: "errors", label: "errors", tint: TINT.danger }]} />
          )}
          {metrics.totalTokens > 0 && (
            <Chart title="Spend (USD)" metrics={metrics} money series={[{ field: "costUsd", label: "cost", tint: TINT.live }]} />
          )}
          <ToolChart metrics={metrics} />
          <ToolBreakdown breakdown={metrics.toolBreakdown} />
        </div>
      )}

      {/* Past runs live here rather than in their own tab: they read the same
          session-summary rows the charts aggregate, so the charts give the context
          for which run to open. Scoped to `version` when this Monitor is - under
          "Metrics for v3" the whole agent's history would misread as that version's. */}
      <RunList agentId={agentId} version={version} />
    </section>
  );
}

/**
 * The agent's recent runs, newest first - click one to read its trajectory.
 *
 * Scrollable and capped in height on purpose: this sits under the charts, and an
 * unbounded list would push the dashboard off the page. Loaded once (not on the
 * charts' 15s refresh): a finished run never changes, and re-fetching would fight the
 * open drilldown.
 */
function RunList({ agentId, version }: { agentId: string; version?: number }) {
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    setRuns(null);
    setOpen(null);
    listRuns(agentId)
      // Filtered client-side: the endpoint has no version param, and the run row
      // already carries the version it executed.
      .then((r) => !stop && setRuns(version === undefined ? r.runs : r.runs.filter((x) => x.version === version)))
      .catch((e) => !stop && setErr(String(e)));
    return () => {
      stop = true;
    };
  }, [agentId, version]);

  if (err) return <ErrorNote message={err} />;

  return (
    <div>
      <Divider label="runs" />
      {!runs && <Skeleton className="mt-4 h-24 rounded-xl" />}
      {runs?.length === 0 && (
        <p className="mt-4 font-mono text-xs text-muted">
          {version === undefined
            ? "No runs yet. Trigger the agent from the Run tab."
            : `No runs on v${version}.`}
        </p>
      )}
      {runs && runs.length > 0 && (
        <ul className="mt-3 max-h-[28rem] divide-y divide-line/70 overflow-y-auto">
          {runs.map((run) => (
            <RunRow
              key={run.runId}
              agentId={agentId}
              run={run}
              open={open === run.runId}
              onToggle={() => setOpen((cur) => (cur === run.runId ? null : run.runId))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One run: a summary line that expands into its full trajectory.
 *
 * The trace is fetched on first open, not with the list - a run's trajectory is far
 * bigger than its summary, and most rows are never opened.
 */
function RunRow({
  agentId,
  run,
  open,
  onToggle,
}: {
  agentId: string;
  run: AgentRun;
  open: boolean;
  onToggle: () => void;
}) {
  const [trace, setTrace] = useState<AgentRunTrace | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open || trace) return; // fetch once, keep it while the row stays mounted
    let stop = false;
    getRunTrace(agentId, run.runId)
      .then((t) => !stop && setTrace(t))
      .catch((e) => !stop && setErr(String(e)));
    return () => {
      stop = true;
    };
  }, [open, trace, agentId, run.runId]);

  const failed = run.outcome === "error";
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="focus-ring flex w-full items-center gap-3 rounded-md px-1 py-2.5 text-left transition-colors hover:bg-fill/60"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink">{fmtWhen(run.startedAt)}</span>
        <span
          className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.14em]"
          style={{ color: failed ? TINT.danger : TINT.live }}
        >
          {run.outcome}
        </span>
        {/* Numbers a reader scans to pick a run: how long, how much work, what it cost. */}
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">
          {fmtDuration(run.durationMs)} · {run.turns} turn{run.turns === 1 ? "" : "s"}
          {run.toolUses > 0 && ` · ${run.toolUses} tool${run.toolUses === 1 ? "" : "s"}`}
          {run.totalTokens > 0 && ` · ${run.totalTokens.toLocaleString()} tok`}
          {run.costUsd > 0 && ` · $${run.costUsd.toFixed(4)}`}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-faint">v{run.version}</span>
      </button>

      {open && (
        <div className="pb-2 pl-4">
          {err && <ErrorNote message={err} />}
          {!trace && !err && <Skeleton className="h-16 rounded-xl" />}
          {/* `truncated` is checked FIRST: a single oversized event can clip a trace to
              zero kept events, and "no longer available" would be the opposite of true. */}
          {trace && trace.events.length === 0 && !trace.truncated && (
            <p className="py-2 font-mono text-xs text-muted">
              This run's steps are no longer available. Trajectories are kept for 30 days and
              archived for a year - this run is either older than that, or predates the archive.
            </p>
          )}
          {trace && trace.events.length === 0 && trace.truncated && (
            <p className="py-2 font-mono text-xs text-muted">
              This run is too large to show - even its first step exceeds the size limit.
            </p>
          )}
          {trace && trace.events.length > 0 && (
            <>
              {/* The same viewer the Run tab uses, so a past run reads identically to a
                  live one - just with no "running" indicator. */}
              <Trace events={trace.events} sessionId={trace.sessionId} working={false} />
              {trace.truncated && (
                // Say so rather than letting a clipped trace read as a complete one.
                <p className="py-2 font-mono text-xs text-muted">
                  This run was too large to show in full - these are its first steps.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** A run's start, as a short local date + time. */
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Mean messages (invocations) per session over the window, 1 decimal. */
function avgPerSession(m: MetricsSummary): string {
  return m.sessions ? (m.invocations / m.sessions).toFixed(1) : "-";
}

/** Compact token count: 1.2M, 34.5k, 812. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Window-total dollar cost: <$0.01 shown as "<$0.01", else 2 decimals / rounded. */
function fmtCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}

/**
 * Per-session dollar cost - finer precision than fmtCost, since a single session
 * is often sub-cent (e.g. $0.0008). Shows enough decimals to distinguish
 * percentiles, and switches to whole cents/dollars as the value grows.
 */
function fmtCostPrecise(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}

function WindowToggle({ hours, onChange }: { hours: number; onChange: (h: number) => void }) {
  return (
    <div className="flex items-center gap-1" role="tablist" aria-label="Time window">
      {WINDOWS.map((w) => {
        const active = w.hours === hours;
        return (
          <button
            key={w.label}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(w.hours)}
            className={`focus-ring min-h-[40px] rounded-lg px-3 font-mono text-xs transition-colors ${
              active ? "bg-ink text-canvas" : "text-muted hover:bg-fill hover:text-ink"
            }`}
          >
            {w.label}
          </button>
        );
      })}
    </div>
  );
}

/** A named metric line in a chart (a top-level bucket field). */
type Line = { field: "sessions" | "invocations" | "errors" | "toolUses" | "tokens" | "costUsd"; label: string; tint: string };

/**
 * A smooth multi-series time chart over the metrics buckets. Empty buckets are
 * present (value 0), so lines are continuous across the window. Monotone areas
 * (no initial animation) with a subtle gradient fill; a legend when >1 series.
 */
function Chart({
  title,
  metrics,
  series,
  money = false,
}: {
  title: string;
  metrics: MetricsSummary;
  series: Line[];
  /** Values are dollars, not counts - allow decimals and format as currency. */
  money?: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const data = metrics.series.map((b) => {
    const row: Record<string, string | number> = { label: fmtBucket(b.bucket, metrics.granularity) };
    for (const s of series) row[s.field] = b[s.field];
    return row;
  });
  const total = series.reduce((sum, s) => sum + data.reduce((a, d) => a + (d[s.field] as number), 0), 0);
  return (
    <div className="card p-4 sm:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {series.length > 1 && <Legend series={series} />}
      </div>
      {total === 0 ? (
        <p className="py-6 text-center font-mono text-xs text-faint">No activity in this window</p>
      ) : (
        <div className="h-32">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
              <defs>
                {series.map((s) => (
                  <linearGradient key={s.field} id={`${uid}-${s.field}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.tint} stopOpacity={0.24} />
                    <stop offset="100%" stopColor={s.tint} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: TINT.faint, fontFamily: "IBM Plex Mono, monospace" }}
                axisLine={{ stroke: TINT.line }}
                tickLine={false}
                minTickGap={28}
                interval="preserveStartEnd"
              />
              <YAxis
                // Counts are integers; DOLLARS are not - session costs are sub-dollar, so
                // forcing integer ticks flattened every real spend series onto the axis.
                allowDecimals={money}
                width={money ? 44 : 28}
                tickFormatter={money ? (v: number) => fmtCostPrecise(v) : undefined}
                tick={{ fontSize: 10, fill: TINT.faint, fontFamily: "IBM Plex Mono, monospace" }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<ChartTooltip money={money} />} cursor={{ stroke: TINT.line }} />
              {/* Render in reverse so a later (typically larger, e.g. invocations)
                  series is drawn first/underneath and doesn't mask the smaller one
                  (sessions) on top. The legend keeps the declared order; the
                  tooltip rows follow this reversed render order (cosmetic). */}
              {[...series].reverse().map((s) => (
                <Area
                  key={s.field}
                  type="monotone"
                  name={s.label}
                  dataKey={s.field}
                  stroke={s.tint}
                  strokeWidth={2}
                  fill={`url(#${uid}-${s.field})`}
                  isAnimationActive={false}
                  dot={false}
                  activeDot={{ r: 3, fill: s.tint }}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/**
 * The per-tool time chart: one smooth line per tool used in the window, so you
 * can see which tools are used over time (skill activation shows as `skills`; an
 * integration call shows as the API it called - see `prettyTool`).
 */
function ToolChart({ metrics }: { metrics: MetricsSummary }) {
  const uid = useId().replace(/:/g, "");
  // Which tools to plot: everything used in the window, most-used first.
  const tools = Object.entries(metrics.toolBreakdown).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const palette = [TINT.accent, TINT.warn, TINT.live, TINT.accentInk, TINT.danger, TINT.muted];
  const data = metrics.series.map((b) => {
    const row: Record<string, string | number> = { label: fmtBucket(b.bucket, metrics.granularity) };
    for (const t of tools) row[t] = b.toolBreakdown[t] ?? 0;
    return row;
  });
  return (
    <div className="card p-4 sm:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">Tool calls over time</h3>
        {tools.length > 0 && (
          <Legend series={tools.map((t, i) => ({ field: t, label: prettyTool(t), tint: palette[i % palette.length]! }))} />
        )}
      </div>
      {tools.length === 0 ? (
        <p className="py-6 text-center font-mono text-xs text-faint">No tool calls in this window</p>
      ) : (
        <div className="h-32">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
              <defs>
                {tools.map((t, i) => (
                  <linearGradient key={t} id={`${uid}-${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={palette[i % palette.length]} stopOpacity={0.2} />
                    <stop offset="100%" stopColor={palette[i % palette.length]} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: TINT.faint, fontFamily: "IBM Plex Mono, monospace" }}
                axisLine={{ stroke: TINT.line }}
                tickLine={false}
                minTickGap={28}
                interval="preserveStartEnd"
              />
              <YAxis
                allowDecimals={false}
                width={28}
                tick={{ fontSize: 10, fill: TINT.faint, fontFamily: "IBM Plex Mono, monospace" }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: TINT.line }} />
              {tools.map((t, i) => (
                <Area
                  key={t}
                  type="monotone"
                  name={prettyTool(t)}
                  dataKey={t}
                  stroke={palette[i % palette.length]}
                  strokeWidth={2}
                  fill={`url(#${uid}-${i})`}
                  isAnimationActive={false}
                  dot={false}
                  activeDot={{ r: 3 }}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/** A compact color-keyed legend for multi-series charts. */
function Legend({ series }: { series: { field: string; label: string; tint: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {series.map((s) => (
        <span key={s.field} className="flex items-center gap-1.5 font-mono text-[10px] text-muted">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.tint }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Console-styled tooltip: bucket label + one row per series (name: value). */
function ChartTooltip({
  active,
  payload,
  label,
  money = false,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  money?: boolean;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] shadow-sm">
      <div className="mb-0.5 text-muted">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-muted">{p.name}:</span>
          {/* Raw for counts; currency for dollars - else a cost reads as 0.30000000000000004. */}
          <span className="font-semibold text-ink">{money ? fmtCostPrecise(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

function ToolBreakdown({ breakdown }: { breakdown: Record<string, number> }) {
  const rows = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map(([, n]) => n));
  return (
    <div className="card p-4 sm:p-5">
      <h3 className="mb-3 text-sm font-semibold text-ink">Tools used</h3>
      <div className="space-y-2.5">
        {rows.map(([tool, n]) => (
          <div key={tool} className="flex items-center gap-3">
            <span className="w-32 shrink-0 truncate font-mono text-xs text-ink">{prettyTool(tool)}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-fill">
              <div
                className="h-full rounded-full"
                style={{ width: `${(n / max) * 100}%`, backgroundColor: TINT.accent }}
              />
            </div>
            <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-muted">{n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Human duration: sub-minute in seconds, else minutes.
 *
 * Rounds to whole seconds BEFORE splitting into m/s. Doing it after (`Math.round(s % 60)`)
 * let a value like 119.7s render "1m 60s", since the seconds rounded up to 60 without
 * carrying into the minute. Negative/NaN can't reach the m/s branch, but are clamped so a
 * bad row shows "-" rather than "-1m 5s".
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const s = ms / 1000;
  if (s < 59.95) return `${s.toFixed(1)}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

/** A readable bucket label for a tooltip: `Jul 20 14:00` hourly, `Jul 20` daily. */
function fmtBucket(key: string, g: "hour" | "day"): string {
  const iso = g === "hour" ? `${key}:00:00Z` : `${key}T00:00:00Z`;
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  if (g === "day") return date;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${date} ${hh}:00`;
}
