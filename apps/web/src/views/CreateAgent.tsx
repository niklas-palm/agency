import { useState } from "react";
import type { AgentConfig, CreateAgentResponse, Integration, ModelKey, ScheduleTrigger } from "@agency/shared";
import { MODEL_KEYS, isModelAllowedInNetworkMode } from "@agency/shared";
import { Check, Copy, KeyRound, Link2 } from "lucide-react";
import { createAgent } from "../api.js";
import { AgencyMark, BackLink, CopyRow, Divider, ErrorNote, ModelPicker, NetworkModePicker, SystemPromptField, ToggleRow } from "../components.js";
import { CodeSamples } from "../CodeSamples.js";
import { TriggersEditor } from "../Triggers.js";
import { SkillPicker, IntegrationPicker, EnvEditor, ManagerPicker } from "../AgentExtras.js";
import { useOrg } from "../OrgContext.js";

export function CreateAgent() {
  const { me } = useOrg();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [model, setModel] = useState<ModelKey>(MODEL_KEYS[0]!);
  const [baseTools, setBaseTools] = useState(true);
  const [webSearch, setWebSearch] = useState(false);
  const [networkMode, setNetworkMode] = useState<"public" | "isolated">("public");
  const isolated = networkMode === "isolated";
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [integrationIds, setIntegrationIds] = useState<string[]>([]);
  // The user's integrations, loaded by IntegrationPicker - used to map attached ids →
  // names so the system-prompt preview shows the integrations block the runtime adds.
  const [allIntegrations, setAllIntegrations] = useState<Integration[]>([]);
  const integrationNames = allIntegrations.filter((i) => integrationIds.includes(i.id)).map((i) => i.name);
  const [env, setEnv] = useState<Record<string, string>>({});
  const [schedule, setSchedule] = useState<ScheduleTrigger | null>(null);
  const [slackEnabled, setSlackEnabled] = useState(false);
  // Discoverability: default shared with the org (toggleable). Agents default on.
  const [shared, setShared] = useState(true);
  // Extra org members who may manage this agent (beyond creator + admins).
  const [managers, setManagers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<CreateAgentResponse | null>(null);

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const config: AgentConfig = {
        name,
        systemPrompt,
        model,
        baseTools,
        // Isolated mode has no public egress, so web tools can't work: send a
        // coherent config (the control-plane also enforces this).
        webSearch: isolated ? false : webSearch,
        networkAccess: !isolated,
        networkMode,
        triggers: [
          { type: "api" },
          ...(schedule ? [schedule] : []),
          ...(slackEnabled ? [{ type: "slack" as const, channels: [] }] : []),
        ],
        ...(skillIds.length ? { skillIds } : {}),
        ...(integrationIds.length ? { integrationIds } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      };
      // description + shared + managers are metadata (not part of the versioned config).
      setResult(await createAgent({ ...config, description: description.trim() || undefined, shared, managers }));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  // A schedule that's toggled on but missing its prompt or expression isn't submittable.
  const scheduleIncomplete = schedule !== null && (!schedule.prompt.trim() || !schedule.expression.trim());

  if (result) return <Created result={result} />;

  return (
    <div className="space-y-6 rise">
      <BackLink />
      <header>
        <p className="eyebrow">A new hire</p>
        <h1 className="mt-1.5 font-display text-[2.25rem] font-bold leading-[1.05] tracking-[-0.03em] text-ink">
          Bring an agent to life
        </h1>
        <p className="mt-2.5 text-sm text-muted">Give it a purpose and a shape. Everything here is editable later.</p>
      </header>

      {err && <ErrorNote message={err} />}

      <div className="card space-y-7 p-5 sm:p-6">
        <Field label="Name">
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="research-assistant"
          />
        </Field>

        <Field label="Description" hint="A short label shown on the roster. Not part of the config.">
          <input
            className="field"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Summarizes daily AI news"
            maxLength={280}
          />
        </Field>

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

        <Field label="Model">
          <ModelPicker value={model} onChange={setModel} networkMode={networkMode} />
        </Field>

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
          schedule={schedule}
          onScheduleChange={setSchedule}
          slackEnabled={slackEnabled}
          onSlackToggle={setSlackEnabled}
        />

        <Divider label="Visibility" />
        <ToggleRow
          checked={shared}
          onChange={setShared}
          title="Shared with your organization"
          desc="On: everyone in the org can see and run this agent. Off: only you can (private)."
        />
        {/* Managers: extra members who may edit/delete this agent (you + admins always can). */}
        {shared && (
          <div>
            <div className="label mb-2">Managers</div>
            <p className="mb-2 text-xs text-muted">
              Members who can edit or delete this agent, in addition to you and org admins.
            </p>
            <ManagerPicker value={managers} onChange={setManagers} createdBy={me?.userId} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button className="btn" disabled={busy || !name || !systemPrompt || scheduleIncomplete} onClick={submit}>
          {busy ? "Creating…" : "Create agent"}
        </button>
        <a href="#/" className="btn-ghost">
          Cancel
        </a>
      </div>
    </div>
  );
}

function Created({ result }: { result: CreateAgentResponse }) {
  return (
    <div className="space-y-6 rise">
      <div className="card p-6 sm:p-8">
        <AgencyMark className="h-11 w-11" />
        <p className="eyebrow mt-5">Now on the roster</p>
        <h1 className="mt-1.5 font-display text-[2rem] font-bold leading-[1.05] tracking-[-0.03em] text-ink">
          {result.agent.config.name} is live
        </h1>
        <p className="mt-2.5 text-sm text-muted">
          Save the API key now — it's shown only once and can't be retrieved again.
        </p>

        <div className="mt-6 space-y-4">
          <CopyRow icon={<KeyRound className="h-3.5 w-3.5" />} label="API key" value={result.apiKey} mono />
          <CopyRow icon={<Link2 className="h-3.5 w-3.5" />} label="Invoke URL" value={result.agent.invokeUrl} />
        </div>

        <div className="mt-7 flex items-center gap-3">
          <a href={`#/agent/${result.agent.id}`} className="btn">
            Open agent
          </a>
          <a href="#/" className="btn-ghost">
            All agents
          </a>
        </div>
      </div>

      <div className="card p-6 sm:p-8">
        <div className="label mb-1.5">Integrate</div>
        <h2 className="text-lg font-semibold tracking-tight text-ink">Call it from your code</h2>
        <p className="mb-5 mt-1 text-sm text-muted">
          Trigger the agent from any system - it returns a session id you poll for its trace.
        </p>
        <CodeSamples invokeUrl={result.agent.invokeUrl} apiKey={result.apiKey} />
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label mb-2">{label}</div>
      {children}
      {hint && <p className="mt-1.5 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

