/**
 * Triggers editor - how an agent gets invoked. Renders one card per trigger
 * type. The `api` trigger is always on (the baseline). `schedule` is optional,
 * added with a rate/cron builder. Future managed triggers (Slack, GitHub, …)
 * add a card here with the same shape: a toggle to enable, provider fields, and
 * a clear "what you must configure on your side" panel.
 */
import type { ScheduleTrigger } from "@agency/shared";
import { Clock, Webhook, Slack, Github } from "lucide-react";
import { Toggle } from "./components.js";
import { SlackSetup } from "./SlackSetup.js";

/** Preset recurrences, plus a custom-cron escape hatch. */
const PRESETS: { label: string; expression: string }[] = [
  { label: "Every hour", expression: "rate(1 hour)" },
  { label: "Every 6 hours", expression: "rate(6 hours)" },
  { label: "Daily 09:00", expression: "cron(0 9 * * ? *)" },
  { label: "Weekdays 08:00", expression: "cron(0 8 ? * MON-FRI *)" },
  { label: "Weekly Mon 09:00", expression: "cron(0 9 ? * MON *)" },
];

export function TriggersEditor({
  invokeUrl,
  schedule,
  onScheduleChange,
  slackEnabled = false,
  onSlackToggle,
  agentId,
  canWrite = true,
}: {
  invokeUrl?: string;
  schedule: ScheduleTrigger | null;
  onScheduleChange: (s: ScheduleTrigger | null) => void;
  /** Whether the agent has a Slack trigger. */
  slackEnabled?: boolean;
  onSlackToggle?: (on: boolean) => void;
  /**
   * The agent's id. Absent while CREATING - Slack setup needs a saved agent, because the
   * manifest embeds the agent's own webhook URL.
   */
  agentId?: string;
  canWrite?: boolean;
}) {
  return (
    <div className="space-y-2.5">
      <ApiCard invokeUrl={invokeUrl} />
      <ScheduleCard schedule={schedule} onChange={onScheduleChange} />
      <SlackCard
        enabled={slackEnabled}
        onToggle={onSlackToggle}
        agentId={agentId}
        canWrite={canWrite}
      />
      <ComingSoonCard icon={<Github className="h-4 w-4" />} name="GitHub" desc="Trigger on issues, PRs, or pushes." />
    </div>
  );
}

/**
 * Slack. Enabling it doesn't finish anything - it creates the trigger so we can generate a
 * manifest that names this agent's webhook. The setup panel then walks the rest.
 */
function SlackCard({
  enabled,
  onToggle,
  agentId,
  canWrite,
}: {
  enabled: boolean;
  onToggle?: (on: boolean) => void;
  agentId?: string;
  canWrite: boolean;
}) {
  return (
    <TriggerCard
      icon={<Slack className="h-4 w-4" />}
      name="Slack"
      desc="Answer when someone @-mentions the agent in a channel."
      control={
        onToggle ? (
          <Toggle checked={enabled} onChange={onToggle} disabled={!canWrite} label="Slack trigger" />
        ) : (
          <span className="chip text-muted">Save first</span>
        )
      }
    >
      {enabled &&
        (agentId ? (
          <SlackSetup agentId={agentId} canWrite={canWrite} />
        ) : (
          <p className="text-xs text-muted">
            Save the agent to get its setup steps - the Slack app manifest has to name this
            agent's own webhook URL.
          </p>
        ))}
    </TriggerCard>
  );
}

/** Shell for a trigger card: a titled, bordered block with a lead icon. */
function TriggerCard({
  icon,
  name,
  desc,
  control,
  children,
  muted = false,
}: {
  icon: React.ReactNode;
  name: string;
  desc: string;
  control?: React.ReactNode;
  children?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className={`rounded-lg border border-line p-4 ${muted ? "bg-canvas opacity-70" : "bg-surface"}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-fill text-muted">
            {icon}
          </span>
          <div>
            <div className="text-sm font-medium text-ink">{name}</div>
            <div className="mt-0.5 text-xs text-muted">{desc}</div>
          </div>
        </div>
        {control}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

function ApiCard({ invokeUrl }: { invokeUrl?: string }) {
  return (
    <TriggerCard
      icon={<Webhook className="h-4 w-4" />}
      name="API"
      desc="Trigger with the agent's API key. Always on."
      control={<span className="chip text-muted">On</span>}
    >
      {invokeUrl && (
        <div>
          <div className="label mb-1.5">Invoke URL</div>
          <code className="block overflow-x-auto rounded-md border border-line bg-raised px-3 py-2 font-mono text-[11px] text-ink">
            POST {invokeUrl}
          </code>
        </div>
      )}
    </TriggerCard>
  );
}

function ScheduleCard({
  schedule,
  onChange,
}: {
  schedule: ScheduleTrigger | null;
  onChange: (s: ScheduleTrigger | null) => void;
}) {
  const on = schedule !== null;
  const s: ScheduleTrigger = schedule ?? { type: "schedule", expression: PRESETS[0]!.expression, prompt: "" };
  const isCustom = !PRESETS.some((p) => p.expression === s.expression);

  return (
    <TriggerCard
      icon={<Clock className="h-4 w-4" />}
      name="Schedule"
      desc="Run the agent on a recurring cron or rate, unattended."
      control={<Toggle checked={on} label="Schedule" onChange={(v) => onChange(v ? s : null)} />}
    >
      {on && (
        <div className="space-y-4 border-t border-line pt-4">
          <div>
            <div className="label mb-1.5">Recurrence</div>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <PresetButton
                  key={p.expression}
                  label={p.label}
                  active={s.expression === p.expression}
                  onClick={() => onChange({ ...s, expression: p.expression })}
                />
              ))}
              <PresetButton
                label="Custom"
                active={isCustom}
                onClick={() => onChange({ ...s, expression: isCustom ? s.expression : "cron(0 12 * * ? *)" })}
              />
            </div>
            {isCustom && (
              <input
                className="field mt-2 font-mono"
                value={s.expression}
                onChange={(e) => onChange({ ...s, expression: e.target.value })}
                placeholder="cron(0 12 * * ? *) or rate(30 minutes)"
              />
            )}
            <p className="mt-1.5 font-mono text-[11px] text-muted">
              EventBridge Scheduler syntax. Evaluated in {s.timezone || "UTC"}.
            </p>
          </div>
          <div>
            <div className="label mb-1.5">Prompt sent each run</div>
            <textarea
              className="field min-h-[64px] resize-y leading-relaxed"
              value={s.prompt}
              onChange={(e) => onChange({ ...s, prompt: e.target.value })}
              placeholder="e.g. Check for new issues and summarize them."
            />
          </div>
        </div>
      )}
    </TriggerCard>
  );
}

function PresetButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`focus-ring inline-flex min-h-[36px] items-center rounded-lg border px-3 font-mono text-xs transition-colors ${
        active ? "border-amber bg-amber text-white" : "border-line text-ink hover:border-amber/40"
      }`}
    >
      {label}
    </button>
  );
}

/** A managed trigger that isn't wired yet - shown so the roadmap is visible. */
function ComingSoonCard({ icon, name, desc }: { icon: React.ReactNode; name: string; desc: string }) {
  return <TriggerCard icon={icon} name={name} desc={desc} muted control={<span className="chip text-muted">Soon</span>} />;
}
