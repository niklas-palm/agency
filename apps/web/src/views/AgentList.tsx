import { useEffect, useState } from "react";
import type { Agent } from "@agency/shared";
import { Plus } from "lucide-react";
import { listAgents } from "../api.js";
import { useCan, useOrg } from "../OrgContext.js";
import { AgentListSkeleton, ErrorNote, ModelTag, relativeTime } from "../components.js";
import { TINT } from "../theme.js";

export function AgentList() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [err, setErr] = useState("");
  const { write } = useCan();
  const { nonce } = useOrg();

  // Load once, then refresh every 10s so run counts / status don't go stale
  // while the roster is open. Only the first load shows the skeleton; later
  // refreshes update in place, and a transient failure is ignored (keep the
  // last good roster rather than flashing an error).
  useEffect(() => {
    let stop = false;
    const load = (initial: boolean) =>
      listAgents()
        .then((a) => !stop && setAgents(a))
        .catch((e) => initial && !stop && setErr(String(e)));
    load(true);
    const t = setInterval(() => load(false), 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // Re-fetch when the active org changes (nonce bumps on switch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  return (
    <div className="rise">
      {/* Masthead — editorial hierarchy: an eyebrow, a large serif headline, a
          quiet mono standfirst. The whitespace is the design. */}
      <header className="flex items-end justify-between gap-6 border-b border-line pb-6">
        <div>
          <p className="eyebrow">The roster</p>
          <h1 className="mt-1.5 font-display text-[2.5rem] font-bold leading-[1.05] tracking-[-0.03em] text-ink">
            Your agents
          </h1>
          <p className="mt-2.5 font-mono text-xs text-muted">{summary(agents)}</p>
        </div>
        {write && (
          <a href="#/new" className="btn shrink-0">
            <Plus className="h-4 w-4" strokeWidth={2.25} />
            New agent
          </a>
        )}
      </header>

      <div className="mt-8">
        {err && <ErrorNote message={err} />}
        {!agents && !err && <AgentListSkeleton />}
        {agents && agents.length === 0 && <EmptyState canCreate={write} />}

        {agents && agents.length > 0 && (
          <div className="divide-y divide-line border-y border-line">
            {agents.map((a, i) => (
              <AgentRow key={a.id} agent={a} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One agent as a ledger entry — a ruled row, not a boxed card. Left: a status
 * mark + the name in the display serif + description. Right: vitals in mono and
 * the model. The whole row is the link; hover warms the paper.
 */
function AgentRow({ agent, index }: { agent: Agent; index: number }) {
  const m = agent.metrics;
  // "Live" = ran within the last ~5 min; otherwise a dormant-but-run ember, or a
  // hollow ring if it has never run.
  const lastMs = m.lastInvokedAt ? Date.now() - new Date(m.lastInvokedAt).getTime() : Infinity;
  const live = lastMs < 5 * 60_000;
  const everRun = Boolean(m.lastInvokedAt);

  return (
    <a
      href={`#/agent/${agent.id}`}
      className="group grid grid-cols-[auto_1fr_auto] items-center gap-5 px-3 py-5 transition-colors hover:bg-raised rise"
      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
    >
      <StatusMark live={live} everRun={everRun} />

      <div className="min-w-0">
        <div className="flex items-baseline gap-2.5">
          <span className="truncate font-display text-[18px] font-bold tracking-[-0.02em] text-ink">
            {agent.config.name}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-faint">v{agent.version}</span>
        </div>
        <p className="mt-0.5 truncate text-[13px] leading-relaxed text-muted">
          {agent.description || agent.config.systemPrompt || "No description"}
        </p>
      </div>

      <div className="flex items-center gap-6">
        <div className="hidden text-right sm:block">
          <div className="font-mono text-sm font-semibold tabular-nums text-ink">{m.invocations}</div>
          <div className="label mt-0.5">runs</div>
        </div>
        <div className="hidden text-right min-[420px]:block">
          <div
            className="font-mono text-sm font-semibold tabular-nums"
            style={{ color: live ? TINT.live : TINT.ink }}
          >
            {everRun ? relativeTime(m.lastInvokedAt!) : "—"}
          </div>
          <div className="label mt-0.5">last run</div>
        </div>
        <span className="hidden md:inline">
          <ModelTag model={agent.config.model} />
        </span>
      </div>
    </a>
  );
}

/**
 * Status mark — a hand-drawn ring with a fill that means something: a solid pine
 * dot when live (brighter) or when it has run (dimmed), a hollow ring when it
 * never has. A quiet, static signal — no pulse; the roster shouldn't twitch.
 */
function StatusMark({ live, everRun }: { live: boolean; everRun: boolean }) {
  return (
    <span
      className="grid h-6 w-6 place-items-center rounded-full"
      title={live ? "Live" : everRun ? "Idle" : "Never run"}
      aria-hidden
    >
      <span
        className="h-2.5 w-2.5 rounded-full"
        style={{
          backgroundColor: everRun ? TINT.live : "transparent",
          boxShadow: everRun ? "none" : `inset 0 0 0 1.5px ${TINT.faint}`,
          opacity: everRun && !live ? 0.5 : 1,
        }}
      />
    </span>
  );
}

function summary(agents: Agent[] | null): string {
  if (!agents) return "loading…";
  if (agents.length === 0) return "none yet";
  const live = agents.filter(
    (a) => a.metrics.lastInvokedAt && Date.now() - new Date(a.metrics.lastInvokedAt).getTime() < 5 * 60_000,
  ).length;
  const unit = agents.length === 1 ? "agent" : "agents";
  return live > 0 ? `${agents.length} ${unit} · ${live} live now` : `${agents.length} ${unit}`;
}

function EmptyState({ canCreate }: { canCreate: boolean }) {
  return (
    <div className="flex flex-col items-center gap-5 py-24 text-center">
      <div>
        <h2 className="font-display text-2xl font-bold tracking-[-0.02em] text-ink">Nothing on the roster yet</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted">
          {canCreate
            ? "Create your first agent — give it a purpose, pick a model, choose how it's triggered, and put it to work."
            : "No agents are shared with you in this organization yet."}
        </p>
      </div>
      {canCreate && (
        <a href="#/new" className="btn">
          <Plus className="h-4 w-4" strokeWidth={2.25} />
          New agent
        </a>
      )}
    </div>
  );
}
