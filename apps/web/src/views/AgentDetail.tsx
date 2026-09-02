import { useEffect, useRef, useState } from "react";
import type { Agent, Integration, ModelKey, ScheduleTrigger, TrajectoryEvent } from "@agency/shared";
import { scheduleOf, slackOf, MODEL_KEYS, isModelAllowedInNetworkMode } from "@agency/shared";
import { Check, Eye, EyeOff, KeyRound, Play, Send, Trash2 } from "lucide-react";
import { getAgent, updateAgent, invokeAgent, pollSession, deleteAgent, rotateAgentKey } from "../api.js";
import { useCan, useOrg } from "../OrgContext.js";
import { BackLink, CopyRow, Divider, ErrorNote, ModelPicker, NetworkModePicker, Skeleton, StatusPill, SystemPromptField, ToggleRow } from "../components.js";
import { CodeSamples } from "../CodeSamples.js";
import { Trace } from "../Trace.js";
import { Monitor } from "./Monitor.js";
import { Versions } from "./Versions.js";
import { TriggersEditor } from "../Triggers.js";
import { SkillPicker, IntegrationPicker, EnvEditor, ManagerPicker } from "../AgentExtras.js";

type Tab = "monitor" | "run" | "configure" | "versions" | "integrate";
const TABS: { id: Tab; label: string }[] = [
  { id: "monitor", label: "Monitor" },
  { id: "run", label: "Run" },
  { id: "configure", label: "Configure" },
  { id: "versions", label: "Versions" },
  { id: "integrate", label: "Integrate" },
];

export function AgentDetail({ id }: { id: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [err, setErr] = useState("");
  const { write, canManage } = useCan();
  const { nonce } = useOrg();
  // Monitoring is front and center: the detail page opens on the dashboard, not
  // the run/test panel.
  const [tab, setTab] = useState<Tab>("monitor");

  // Load once, then refresh the agent (metrics/status) every 10s so the readout
  // strip doesn't go stale while the page is open. ConfigEditor holds its own
  // mount-initialized local state, so an in-place refresh never clobbers unsaved
  // edits. A successful load clears any prior error (so a transient first-load
  // failure that later recovers doesn't stick); errors only surface while we
  // still have no agent to show.
  useEffect(() => {
    let stop = false;
    const load = () =>
      getAgent(id)
        .then((a) => {
          if (stop) return;
          setAgent(a);
          setErr("");
        })
        .catch((e) => !stop && setErr(String(e)));
    load();
    const t = setInterval(load, 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // Re-fetch when the active org changes (nonce bumps on switch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, nonce]);

  if (err && !agent)
    return (
      <div className="space-y-4 rise">
        <BackLink />
        <ErrorNote message={err} />
      </div>
    );
  if (!agent) return <DetailSkeleton />;

  // Hide the Run tab from viewers (write-capable roles only run agents + see the
  // key). If the current tab isn't visible (e.g. a viewer on "run"), show Monitor.
  const visibleTabs = TABS.filter((t) => t.id !== "run" || write);
  const activeTab = visibleTabs.some((t) => t.id === tab) ? tab : "monitor";

  return (
    <div className="space-y-5 rise">
      <BackLink />

      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">Agent</p>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="truncate font-display text-[2rem] font-bold leading-none tracking-[-0.03em] text-ink">
              {agent.config.name}
            </h1>
            <span className="shrink-0 font-mono text-xs text-faint">v{agent.version}</span>
          </div>
          {agent.description && <p className="mt-2 text-sm text-muted">{agent.description}</p>}
          <p className="mt-1 break-all font-mono text-[11px] text-faint">{agent.invokeUrl}</p>
        </div>
        {canManage(agent) && <DeleteButton agent={agent} />}
      </header>

      {/* Tabs: monitoring first (front and center). Splitting the page keeps each
          screen short (mobile-first); horizontally scrollable on narrow screens.
          The Run tab (dispatch + API key) is for run-capable roles only; a viewer
          who lands on it falls back to Monitor. */}
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div role="tablist" aria-label="Agent sections" className="flex gap-1 border-b border-line">
          {visibleTabs.map((t) => {
            const active = t.id === activeTab;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={`focus-ring -mb-px shrink-0 border-b-2 px-3.5 py-2 text-sm font-medium transition-colors ${
                  active ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {activeTab === "monitor" && <Monitor agentId={agent.id} />}
      {/* Keyed on the API key so a rotation re-mounts the panel with the new one. */}
      {activeTab === "run" && <Run key={agent.apiKey ?? "nokey"} agent={agent} />}
      {activeTab === "configure" && <ConfigEditor agent={agent} onSaved={setAgent} canWrite={canManage(agent)} />}
      {activeTab === "versions" && <Versions agent={agent} onRestored={setAgent} canWrite={canManage(agent)} />}
      {activeTab === "integrate" && (
        <section className="card p-5 sm:p-6">
          <header className="mb-4">
            <h2 className="text-base font-semibold tracking-tight text-ink">Integrate</h2>
            <p className="mt-1 text-xs text-muted">Trigger this agent from your code - the same API the console uses.</p>
          </header>
          {/* The real key, so the samples are copy-paste runnable without editing. Present only
              for a writer - a viewer gets a placeholder, because the server omits the field. */}
          <CodeSamples invokeUrl={agent.invokeUrl} apiKey={agent.apiKey} />
          {canManage(agent) && <RotateKey agentId={agent.id} />}
        </section>
      )}
    </div>
  );
}

/**
 * Mint a fresh agent key. Confirm-gated because it INVALIDATES the current key - every caller
 * using it breaks until they're updated. Rotation is for a key you believe is COMPROMISED, not for
 * one you mislaid: the current key is stored and prefilled above for anyone who can write the
 * agent. Shown to writers only, matching the server's gate.
 */
function RotateKey({ agentId }: { agentId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function rotate() {
    setBusy(true);
    setErr(null);
    try {
      setFresh(await rotateAgentKey(agentId));
      setConfirming(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 border-t border-line pt-5">
      {fresh ? (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            The previous key no longer works — update anything that used it.
          </p>
          <CopyRow icon={<KeyRound className="h-3.5 w-3.5" />} label="New API key" value={fresh} mono />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">Rotate the API key</div>
            <p className="mt-0.5 text-xs text-muted">
              Lost the key? Mint a new one. The current key stops working immediately.
            </p>
          </div>
          {confirming ? (
            <div className="flex shrink-0 items-center gap-2">
              <button className="btn-ghost !min-h-0 !px-2.5 !py-2" onClick={rotate} disabled={busy}>
                {busy ? "Rotating…" : "Rotate"}
              </button>
              <button
                className="btn-ghost !min-h-0 !px-2.5 !py-2"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button className="btn-ghost !min-h-0 shrink-0 !px-2.5 !py-2" onClick={() => setConfirming(true)}>
              <KeyRound className="h-4 w-4" />
              Rotate key
            </button>
          )}
        </div>
      )}
      {err && <ErrorNote message={err} className="mt-3" />}
    </div>
  );
}

/** Delete an agent, behind an inline confirm (no accidental one-click deletes). */
function DeleteButton({ agent }: { agent: Agent }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      await deleteAgent(agent.id);
      window.location.hash = "#/"; // back to the roster; it re-fetches without this agent
    } catch (e) {
      setBusy(false);
      alert(`Couldn't delete: ${String(e)}`);
    }
  }

  if (!confirming) {
    return (
      <button
        className="btn-ghost !min-h-0 shrink-0 !px-2.5 !py-2 text-muted hover:text-danger-ink"
        onClick={() => setConfirming(true)}
        title="Delete agent"
      >
        <Trash2 className="h-4 w-4" />
        <span className="hidden sm:inline">Delete</span>
      </button>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="hidden text-xs text-muted sm:inline">Delete this agent?</span>
      <button
        className="btn-ghost !min-h-0 !px-2.5 !py-2 border-danger/40 text-danger-ink hover:bg-danger/5"
        onClick={remove}
        disabled={busy}
      >
        {busy ? "Deleting…" : "Delete"}
      </button>
      <button className="btn-ghost !min-h-0 !px-2.5 !py-2" onClick={() => setConfirming(false)} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}

function ConfigEditor({ agent, onSaved, canWrite }: { agent: Agent; onSaved: (a: Agent) => void; canWrite: boolean }) {
  const { canEditManagers } = useCan();
  // Only the creator/admin may edit the managers list (a granted manager can edit
  // the agent but not re-delegate) - mirrors the server's patchManagers gate.
  const showManagers = canEditManagers({ createdBy: agent.createdBy });
  const [description, setDescription] = useState(agent.description ?? "");
  // `shared` is metadata (not versioned): flip it and persist immediately, no save.
  const [shared, setShared] = useState(agent.shared);
  const [sharing, setSharing] = useState(false);
  // Managers is metadata too: persist on change (no version bump).
  const [managers, setManagers] = useState<string[]>(agent.managers ?? []);
  const [systemPrompt, setSystemPrompt] = useState(agent.config.systemPrompt);
  const [model, setModel] = useState<ModelKey>(agent.config.model);
  const [baseTools, setBaseTools] = useState(agent.config.baseTools);
  const [webSearch, setWebSearch] = useState(agent.config.webSearch);
  const [networkMode, setNetworkMode] = useState<"public" | "isolated">(agent.config.networkMode ?? "public");
  const isolated = networkMode === "isolated";
  const [skillIds, setSkillIds] = useState<string[]>(agent.config.skillIds ?? []);
  const [integrationIds, setIntegrationIds] = useState<string[]>(agent.config.integrationIds ?? []);
  // The user's integrations, loaded by IntegrationPicker → map attached ids to names so
  // the system-prompt preview shows the integrations block the runtime adds at invoke.
  const [allIntegrations, setAllIntegrations] = useState<Integration[]>([]);
  const integrationNames = allIntegrations.filter((i) => integrationIds.includes(i.id)).map((i) => i.name);
  const [env, setEnv] = useState<Record<string, string>>(agent.config.env ?? {});
  const [schedule, setSchedule] = useState<ScheduleTrigger | null>(scheduleOf(agent.config) ?? null);
  // The Slack trigger is a toggle here; the setup panel inside the card owns everything else
  // (appId/teamId/channels are written by the dedicated Slack endpoints, not this form). So we
  // carry the EXISTING trigger through on save rather than rebuilding it, or a save from this
  // form would wipe the connected workspace.
  const existingSlack = slackOf(agent.config);
  const [slackEnabled, setSlackEnabled] = useState(Boolean(existingSlack));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  const triggers = [
    { type: "api" as const },
    ...(schedule ? [schedule] : []),
    ...(slackEnabled ? [existingSlack ?? { type: "slack" as const, channels: [] }] : []),
  ];
  const scheduleIncomplete = schedule !== null && (!schedule.prompt.trim() || !schedule.expression.trim());
  // A config change bumps the agent's version; a description change does not.
  const configDirty =
    systemPrompt !== agent.config.systemPrompt ||
    model !== agent.config.model ||
    baseTools !== agent.config.baseTools ||
    (isolated ? false : webSearch) !== agent.config.webSearch ||
    networkMode !== (agent.config.networkMode ?? "public") ||
    JSON.stringify([...skillIds].sort()) !== JSON.stringify([...(agent.config.skillIds ?? [])].sort()) ||
    JSON.stringify([...integrationIds].sort()) !== JSON.stringify([...(agent.config.integrationIds ?? [])].sort()) ||
    JSON.stringify(env) !== JSON.stringify(agent.config.env ?? {}) ||
    JSON.stringify(triggers) !== JSON.stringify(agent.config.triggers);
  const dirty = configDirty || description !== (agent.description ?? "");

  async function save() {
    setBusy(true);
    setErr("");
    setSaved(false);
    try {
      // Send description alongside config; the server bumps the version only for
      // the config change, never for description (see docs/control-plane.md).
      const updated = await updateAgent(agent.id, {
        systemPrompt,
        model,
        baseTools,
        webSearch: isolated ? false : webSearch,
        networkAccess: !isolated,
        networkMode,
        skillIds,
        integrationIds,
        env,
        triggers,
        description,
      });
      onSaved(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Toggle org-sharing on the agent record (metadata, no version bump).
  async function toggleShared(next: boolean) {
    setShared(next); // optimistic
    setSharing(true);
    setErr("");
    try {
      onSaved(await updateAgent(agent.id, { shared: next }));
    } catch (e) {
      setShared(!next); // revert on failure
      setErr(String(e));
    } finally {
      setSharing(false);
    }
  }

  // Persist the managers list (metadata, no version bump). Optimistic with revert.
  async function saveManagers(next: string[]) {
    const prev = managers;
    setManagers(next); // optimistic
    setErr("");
    try {
      onSaved(await updateAgent(agent.id, { managers: next }));
    } catch (e) {
      setManagers(prev); // revert on failure
      setErr(String(e));
    }
  }

  return (
    <section className="card p-5 sm:p-6">
      <header className="mb-5">
        <h2 className="text-base font-semibold tracking-tight text-ink">Configuration</h2>
        <p className="mt-1 text-xs text-muted">
          Config changes apply on the agent's next run (no redeploy) and create a new version.
          The description is just a label - editing it doesn't create a version.
        </p>
      </header>

      {err && <ErrorNote message={err} className="mb-5" />}
      {!canWrite && (
        <p className="mb-5 text-xs leading-relaxed text-muted">
          You can view this agent's configuration but not change it - only its creator, an org
          admin, or a named manager can.
        </p>
      )}

      {/* Disabled wholesale for a non-writer, like the integration editor. Gating only
          the Save button left every input live, so a viewer could edit the prompt, find
          no way to save, and lose the work on a tab switch. */}
      <fieldset disabled={!canWrite} className="space-y-6 disabled:opacity-70">
        <div>
          <div className="label mb-2">Description</div>
          <input
            className="field"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A short description shown on the roster"
            maxLength={280}
          />
        </div>

        <SystemPromptField
          value={systemPrompt}
          onChange={setSystemPrompt}
          caps={{
            baseTools,
            webSearch: isolated ? false : webSearch,
            networkAccess: !isolated,
            networkMode,
            envKeys: Object.keys(env),
            integrationNames,
          }}
        />

        <div>
          <div className="label mb-2">Model</div>
          <ModelPicker value={model} onChange={setModel} networkMode={networkMode} />
        </div>

        <Divider label="Capabilities" />

        <ToggleRow
          checked={baseTools}
          onChange={setBaseTools}
          title="Base coding tools"
          desc="Read, write, and edit files, and run bash, in a sandboxed workspace."
        />
        <ToggleRow
          checked={isolated ? false : webSearch}
          onChange={setWebSearch}
          disabled={isolated}
          title="Web search"
          desc={isolated ? "Unavailable in Isolated mode - there's no internet to reach." : "Let the agent search and fetch the web."}
        />

        <Divider label="Network" />
        <NetworkModePicker
          value={networkMode}
          onChange={(mode) => {
            setNetworkMode(mode);
            // Switching to Isolated can strand an OpenAI selection the save would
            // reject; fall back to the first model that mode allows (an Anthropic one).
            if (!isModelAllowedInNetworkMode(model, mode)) {
              setModel(MODEL_KEYS.find((k) => isModelAllowedInNetworkMode(k, mode))!);
            }
          }}
        />

        <Divider label="Skills" />
        <SkillPicker value={skillIds} onChange={setSkillIds} />

        <Divider label="Integrations" />
        <IntegrationPicker value={integrationIds} onChange={setIntegrationIds} onLoaded={setAllIntegrations} />

        <Divider label="Environment variables" />
        <EnvEditor value={env} onChange={setEnv} />

        <Divider label="Triggers" />
        <TriggersEditor
          invokeUrl={agent.invokeUrl}
          schedule={schedule}
          onScheduleChange={setSchedule}
          slackEnabled={slackEnabled}
          savedSlack={Boolean(existingSlack)}
          onSlackToggle={setSlackEnabled}
          agentId={agent.id}
          canWrite={canWrite}
        />

        {/* Org sharing is metadata (no version bump) - only writers can change it. */}
        {canWrite && (
          <>
            <Divider label="Sharing" />
            <ToggleRow
              checked={shared}
              onChange={toggleShared}
              disabled={sharing}
              title="Shared with organization"
              desc="When on, every member of this organization can see and use this agent. When off, only you can."
            />
            {shared && showManagers && (
              <div>
                <div className="label mb-2">Managers</div>
                <p className="mb-2 text-xs text-muted">
                  Members who can edit or delete this agent, in addition to you and org admins.
                </p>
                <ManagerPicker value={managers} onChange={saveManagers} createdBy={agent.createdBy} />
              </div>
            )}
          </>
        )}
      </fieldset>

      {canWrite && (
      <div className="mt-6 flex items-center gap-3">
        <button className="btn" disabled={busy || !dirty || scheduleIncomplete} onClick={save}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        <span aria-live="polite" className="inline-flex items-center gap-1.5 text-sm text-live-ink">
          {saved && (
            <>
              <Check className="h-4 w-4" /> Saved
            </>
          )}
        </span>
      </div>
      )}
    </section>
  );
}

/**
 * Run panel: dispatch the agent and watch its trace stream in via delta polling.
 * Sending a follow-up while it's running demonstrates mid-turn injection.
 */
function Run({ agent }: { agent: Agent }) {
  // Prefilled from the agent record: the key is stored in plaintext and returned to anyone who
  // can WRITE the agent, so running your own agent needs no paste at all. Still editable, so a
  // rotated key or someone else's can be tried without persisting anything.
  // Initialized at mount, so `key={agent.apiKey}` on the panel below re-mounts this after a
  // rotation - otherwise the poll would update the record while this input kept the dead key.
  const [apiKey, setApiKey] = useState(agent.apiKey ?? "");
  const [showKey, setShowKey] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<"working" | "idle" | null>(null);
  const [events, setEvents] = useState<TrajectoryEvent[]>([]);
  const [lastAck, setLastAck] = useState("");
  // True while the invoke request is in flight. A fresh runtime can take ~1-2 min
  // to reach READY, and the control-plane retries the invoke server-side that
  // whole time, so this await can be long - the button must show it's working.
  const [dispatching, setDispatching] = useState(false);
  const [err, setErr] = useState("");
  // Bumped on every send. The poll loop stops when the agent goes idle, so a
  // follow-up on the same session must restart it - re-running the effect (via
  // this nonce in its deps) does that, resuming from the saved cursor so only
  // the new turn's delta streams in.
  const [pollNonce, setPollNonce] = useState(0);
  const cursorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId || !apiKey) return;
    let stop = false;
    let empty = 0;
    let sawActivity = false;
    // Silence is NOT inactivity: one long tool call (a slow bash, a big fetch) emits
    // no events for minutes, and the old ~2-minute cap declared "no activity" on a
    // perfectly healthy run. The server now guarantees a working session terminates -
    // it writes a terminal event after 30 min of true silence - so this is only a
    // backstop sitting just outside that window, for the case the server can't close
    // (an unknown/mistyped sessionId, which reads `working` forever).
    const MAX_EMPTY = 35 * 60;
    // A just-dispatched turn hasn't written its first event yet, and the server
    // still reports `idle` (its newest event is the PREVIOUS turn's terminal one,
    // whose cursor is ≤ our `after`). So on (re)start we keep polling through a
    // grace window even while idle, until this turn's first event lands - else a
    // follow-up on an idle session stops after one poll and never shows the reply.
    const START_GRACE = 30; // seconds to wait for the new turn to begin producing
    let timer: ReturnType<typeof setTimeout> | undefined;
    let errors = 0;
    const MAX_ERRORS = 5; // tolerate transient blips before giving up
    const tick = async () => {
      try {
        const res = await pollSession(agent.id, apiKey, sessionId, cursorRef.current ?? undefined);
        if (stop) return;
        errors = 0;
        if (res.cursor) cursorRef.current = res.cursor;
        if (res.events.length) {
          setEvents((prev) => [...prev, ...res.events]);
          empty = 0;
          sawActivity = true;
        } else empty += 1;
        setStatus(res.status);
        const awaitingStart = !sawActivity && empty < START_GRACE;
        if ((res.status === "working" || awaitingStart) && empty < MAX_EMPTY) {
          timer = setTimeout(tick, 1000);
        } else if (empty >= MAX_EMPTY) {
          setErr("Stopped following this run - it went quiet for too long. Reload to pick it up again.");
        }
      } catch (e) {
        if (stop) return;
        // A transient blip (503/network) shouldn't permanently kill the trace -
        // keep polling through a few failures, then surface the error.
        if (++errors >= MAX_ERRORS) setErr(String(e));
        else timer = setTimeout(tick, 2000);
      }
    };
    tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer); // don't leave a stray poll firing post-unmount
    };
  }, [sessionId, apiKey, agent.id, pollNonce]);

  async function run() {
    setErr("");
    setDispatching(true);
    const isFirst = !sessionId;
    try {
      const res = await invokeAgent(agent.id, apiKey, prompt, sessionId ?? undefined);
      setLastAck(res.status);
      // Rejected (mailbox full) means the message wasn't accepted - keep it in the
      // box so the user can retry rather than silently losing what they typed.
      if (res.status === "rejected") return;
      if (isFirst) {
        setEvents([]);
        cursorRef.current = null;
        setSessionId(res.sessionId);
      }
      setPollNonce((n) => n + 1); // (re)start polling - new turn or injected message
      setPrompt("");
    } catch (e) {
      setErr(String(e));
    } finally {
      setDispatching(false);
    }
  }

  function reset() {
    setSessionId(null);
    setEvents([]);
    setStatus(null);
    setLastAck("");
    cursorRef.current = null;
  }

  const working = status === "working";

  return (
    <section className="card p-5 sm:p-6">
      <header className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-ink">
            <Play className="h-4 w-4 text-accent-ink" />
            Run
          </h2>
          <p className="mt-1 text-xs text-muted">
            Dispatch the agent and watch the trace. Send again while it's running to inject mid-turn.
          </p>
        </div>
        {status && <StatusPill status={status} />}
      </header>

      {err && <ErrorNote message={err} className="mb-5" />}

      <div className="space-y-4">
        <div>
          <div className="label mb-2">API key</div>
          <div className="relative">
            <input
              className="field pr-10 font-mono"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="ag_… (your key appears here; you need write access to see it)"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="focus-ring absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted transition-colors hover:text-ink"
              title={showKey ? "Hide key" : "Show key"}
              aria-label={showKey ? "Hide API key" : "Show API key"}
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {apiKey && (
            <p className="mt-1.5 text-[11px] text-muted">
              Remembered in this browser so you don't re-paste it.{" "}
              <button
                type="button"
                className="underline transition-colors hover:text-ink"
                onClick={() => setApiKey("")}
              >
                Forget it
              </button>
            </p>
          )}
        </div>
        <div>
          <div className="label mb-2">Message</div>
          <textarea
            className="field min-h-[80px] resize-y leading-relaxed"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={working ? "Send another to inject into the running turn…" : "Ask the agent to do something…"}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn" disabled={!apiKey || !prompt || dispatching} onClick={run}>
            <Send className="h-4 w-4" />
            {dispatching ? "Dispatching…" : sessionId ? (working ? "Inject" : "Send") : "Dispatch"}
          </button>
          {sessionId && (
            <button className="btn-ghost" onClick={reset} disabled={dispatching}>
              New session
            </button>
          )}
          <span aria-live="polite" className="font-mono text-[11px] text-muted">
            {dispatching && <span className="text-muted">starting the agent…</span>}
            {!dispatching && lastAck === "injected" && (
              <>
                <span className="text-accent-ink">→ injected</span> into the running turn
              </>
            )}
            {!dispatching && lastAck === "triggered" && (
              <>
                <span className="text-accent-ink">→ dispatched</span> a new session
              </>
            )}
            {!dispatching && lastAck === "rejected" && <span className="text-danger-ink">→ mailbox full, retry</span>}
          </span>
        </div>
      </div>

      {(sessionId || dispatching) && (
        <Trace events={events} sessionId={sessionId ?? ""} working={working} dispatching={dispatching} />
      )}
    </section>
  );
}

/** Loading placeholder for the detail page - header + readout strip + panels. */
function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-4 w-20" />
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-3 w-72" />
      </div>
      <Skeleton className="h-16 rounded-xl" />
      <Skeleton className="h-56 rounded-xl" />
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
