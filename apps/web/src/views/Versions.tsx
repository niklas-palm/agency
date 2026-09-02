/**
 * The version history for an agent: every config snapshot (newest first), each
 * expandable to its config + a restore action and a per-version metrics view.
 * Restoring appends the old config as a NEW version (linear history) and updates
 * the parent agent.
 */
import { useEffect, useState } from "react";
import type { Agent, AgentVersion } from "@agency/shared";
import { MODEL_INFO } from "@agency/shared";
import { ChevronRight, RotateCcw } from "lucide-react";
import { listVersions, restoreVersion } from "../api.js";
import { ErrorNote, Skeleton } from "../components.js";
import { TINT, tintAlpha } from "../theme.js";
import { Monitor } from "./Monitor.js";

export function Versions({
  agent,
  onRestored,
  canWrite,
}: {
  agent: Agent;
  onRestored: (a: Agent) => void;
  canWrite: boolean;
}) {
  const [versions, setVersions] = useState<AgentVersion[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  const load = () => listVersions(agent.id).then(setVersions).catch((e) => setErr(String(e)));
  // Reload when the agent's version changes (e.g. after a restore or an edit).
  useEffect(() => {
    load();
  }, [agent.id, agent.version]);

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-base font-semibold tracking-tight text-ink">Version history</h2>
        <p className="mt-1 text-xs text-muted">
          Every config change creates a version. The latest is live; restore any earlier one to
          make it the new latest.
        </p>
      </header>

      {err && <ErrorNote message={err} />}
      {!versions && !err && <Skeleton className="h-40 rounded-xl" />}

      {versions && (
        <div className="card divide-y divide-line overflow-hidden">
          {versions.map((v) => (
            <VersionRow
              key={v.version}
              agent={agent}
              version={v}
              live={v.version === agent.version}
              expanded={open === v.version}
              onToggle={() => setOpen(open === v.version ? null : v.version)}
              onRestored={(a) => {
                onRestored(a);
                setOpen(null);
              }}
              onError={setErr}
              canWrite={canWrite}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function VersionRow({
  agent,
  version,
  live,
  expanded,
  onToggle,
  onRestored,
  onError,
  canWrite,
}: {
  agent: Agent;
  version: AgentVersion;
  live: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRestored: (a: Agent) => void;
  onError: (e: string) => void;
  canWrite: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const c = version.config;

  async function restore() {
    setBusy(true);
    onError("");
    try {
      onRestored(await restoreVersion(agent.id, version.version));
    } catch (e) {
      onError(String(e));
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        onClick={onToggle}
        className="focus-ring flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised"
        aria-expanded={expanded}
      >
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-faint transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-ink">v{version.version}</span>
            {live && (
              <span
                className="rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium"
                style={{ backgroundColor: tintAlpha("live", 0.08), color: TINT.live }}
              >
                live
              </span>
            )}
            {version.note && <span className="font-mono text-[11px] text-faint">{version.note}</span>}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted">{c.systemPrompt || "No system prompt"}</div>
        </div>
        <span className="hidden shrink-0 font-mono text-[11px] text-faint sm:block">
          {MODEL_INFO[c.model]?.label ?? c.model}
        </span>
      </button>

      {expanded && (
        <div className="space-y-5 border-t border-line bg-raised/40 px-4 py-4">
          <ConfigView config={c} />
          <div className="flex items-center gap-3">
            {!live && canWrite && (
              <button className="btn-ghost !min-h-0 !px-3 !py-2" onClick={restore} disabled={busy}>
                <RotateCcw className="h-3.5 w-3.5" />
                {busy ? "Restoring…" : "Restore this version"}
              </button>
            )}
          </div>
          <div>
            <div className="label mb-3">Metrics for v{version.version}</div>
            <Monitor agentId={agent.id} version={version.version} />
          </div>
        </div>
      )}
    </div>
  );
}

/** A read-only snapshot of a version's config. */
function ConfigView({ config }: { config: AgentVersion["config"] }) {
  const caps = [
    config.baseTools && "Base tools",
    config.webSearch && "Web search",
    config.networkMode === "isolated" ? "Isolated (no internet)" : "Public network",
  ].filter(Boolean) as string[];
  return (
    <div className="space-y-3 text-sm">
      <Field label="Model" value={MODEL_INFO[config.model]?.label ?? config.model} />
      <Field label="Capabilities" value={caps.length ? caps.join(" · ") : "None"} />
      <div>
        <div className="label mb-1">System prompt</div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-ink">
          {config.systemPrompt || "(empty)"}
        </pre>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="label w-24 shrink-0">{label}</span>
      <span className="text-ink">{value}</span>
    </div>
  );
}
