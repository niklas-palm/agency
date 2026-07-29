/**
 * Shared UI primitives for the Agency "Studio" interface: the compass mark, status
 * pills, stat readouts, model tag/picker, toggles, skeletons, and the run-trace
 * event colors. Warm editorial palette; color always means something.
 */
import { useState, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronDown, Copy, Globe, Lock, ShieldCheck } from "lucide-react";
import type { ModelFamily, ModelKey, PromptContext, TrajectoryEvent } from "@agency/shared";
import { MODEL_INFO, MODEL_KEYS, composeSystemPrompt, isModelAllowedInNetworkMode } from "@agency/shared";

/**
 * Palette as JS values, for dynamic per-datum coloring (trace rails, status
 * dots, vendor marks) Tailwind can't express as static classes. Mirrors
 * tailwind.config.js.
 */
export const TINT = {
  canvas: "#FAF8F4",
  surface: "#FFFDFA",
  raised: "#F5F1E8",
  ink: "#1A1714",
  muted: "#6E655A",
  faint: "#A79E90",
  line: "#E6DFD2",
  fill: "#F1EBDF",
  // The signature marigold + its AA-safe deep tone.
  accent: "#E8A33D",
  accentInk: "#B4741A",
  // Alive — pine green.
  live: "#21584A",
  warn: "#B4741A",
  danger: "#B23A2E",
} as const;

/**
 * Per-vendor mark color. `dot` is the small marker; `fill` is the darker tone
 * used behind light text on a selected chip (clears WCAG AA). Kept in the warm
 * family: Anthropic reads as the marigold-adjacent clay, OpenAI as pine.
 */
const FAMILY_COLOR: Record<ModelFamily, { dot: string; fill: string }> = {
  Anthropic: { dot: "#C06A2C", fill: "#9A511C" },
  OpenAI: { dot: "#21584A", fill: "#163F34" },
};

/**
 * The Agency mark — a hand-drawn COMPASS STAR on warm ink. Agency means the
 * capacity to act and set direction; the compass rose is the almanac/field-guide
 * device that anchors the editorial brand. A four-point star (marigold) with a
 * pine counter-point, struck like a maker's mark rather than a stock glyph. Reads
 * at any size; nothing about it says "generated".
 */
export function AgencyMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-[10px] ${className}`}
      style={{ backgroundColor: TINT.ink }}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="h-[62%] w-[62%]" fill="none">
        {/* primary compass point — vertical, marigold */}
        <path d="M12 3 L13.7 12 L12 21 L10.3 12 Z" fill={TINT.accent} />
        {/* secondary points — horizontal, pine (the needle's counter-axis) */}
        <path d="M3 12 L12 10.5 L21 12 L12 13.5 Z" fill={TINT.live} opacity="0.9" />
        {/* hub */}
        <circle cx="12" cy="12" r="1.7" fill={TINT.canvas} />
      </svg>
    </span>
  );
}

/** Danger note (validation / load failure). */
export function ErrorNote({ message, className = "" }: { message: string; className?: string }) {
  return (
    <div
      className={`rounded-lg border px-3.5 py-2.5 text-sm ${className}`}
      style={{ borderColor: `${TINT.danger}33`, backgroundColor: `${TINT.danger}0d`, color: "#9A2F26" }}
    >
      {message}
    </div>
  );
}

/** Uppercase section label with a trailing hairline. */
export function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="label shrink-0">{label}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/**
 * A compact stat: mono value + caps label. Used in the horizontal readout strip.
 * No boxes - density done with rhythm, not chrome.
 */
export function Stat({ value, label, tint }: { value: ReactNode; label: string; tint?: string }) {
  return (
    <div>
      <div
        className="font-mono text-lg font-semibold tabular-nums leading-none"
        style={tint ? { color: tint } : undefined}
      >
        {value}
      </div>
      <div className="label mt-1.5">{label}</div>
    </div>
  );
}

/** Compact "time since" for an ISO timestamp (e.g. "3m ago", "2h ago", "5d ago"). */
export function relativeTime(iso: string): string {
  const secs = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Session status pill (running / idle). Pulsing green dot when live. */
export function StatusPill({ status }: { status: "working" | "idle" }) {
  const live = status === "working";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[11px] font-medium"
      style={{ backgroundColor: live ? `${TINT.live}14` : TINT.fill, color: live ? TINT.live : TINT.muted }}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${live ? "live-dot" : ""}`}
        style={{ backgroundColor: live ? TINT.live : TINT.faint }}
      />
      {live ? "Running" : "Idle"}
    </span>
  );
}

/**
 * Org-visibility badge for a resource (skill / integration / agent). "Shared"
 * (globe, pine) means every org member can see + use it; "Private" (lock, faint)
 * means creator-only. Mirrors the `shared` flag set by the editor's toggle.
 */
export function SharedBadge({ shared }: { shared: boolean }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium"
      style={
        shared
          ? { backgroundColor: `${TINT.live}14`, color: TINT.live }
          : { backgroundColor: TINT.fill, color: TINT.muted }
      }
      title={shared ? "Shared with the organization" : "Private to you"}
    >
      {shared ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
      {shared ? "Shared" : "Private"}
    </span>
  );
}

/**
 * Small model tag — a vendor-colored dot + the human label, in the clean sans.
 * Deliberately NOT a mono/boxed chip: the model name is a proper noun, not machine
 * data, so it should read as warm editorial text with a quiet vendor marker.
 */
export function ModelTag({ model }: { model: string }) {
  const info = MODEL_INFO[model as ModelKey];
  if (!info) return <span className="text-[13px] text-muted">{model}</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-medium text-ink">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: FAMILY_COLOR[info.family].dot }} />
      {info.label}
    </span>
  );
}

/**
 * Model picker: a flat rack of chips carrying each vendor's mark color. Selected
 * fills with the vendor tone (AA-safe); the rest stay quiet.
 *
 * `networkMode` gates availability the same way the API does: in Isolated mode
 * OpenAI (Mantle) models are unreachable (no cross-region PrivateLink), so their
 * chips are disabled with an explanatory tooltip - the UI can't offer a choice
 * the save would reject with a 400. Uses the shared `isModelAllowedInNetworkMode`
 * predicate so picker and API never disagree.
 */
export function ModelPicker({
  value,
  onChange,
  networkMode,
}: {
  value: ModelKey;
  onChange: (m: ModelKey) => void;
  networkMode?: "public" | "isolated";
}) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Model">
      {MODEL_KEYS.map((k) => {
        const info = MODEL_INFO[k];
        const { dot, fill } = FAMILY_COLOR[info.family];
        const active = value === k;
        const allowed = isModelAllowedInNetworkMode(k, networkMode);
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={!allowed}
            title={allowed ? undefined : "Unavailable in Isolated mode - reached cross-region, which the isolated network can't do."}
            onClick={() => onChange(k)}
            className="focus-ring inline-flex min-h-[40px] items-center gap-2 rounded-lg border px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            style={active ? { backgroundColor: fill, borderColor: fill, color: "#fff" } : { borderColor: TINT.line, color: TINT.ink }}
          >
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: active ? "#fff" : dot }} />
            {info.label}
          </button>
        );
      })}
    </div>
  );
}

/** Accessible on/off switch - marigold when on (role=switch). 40px hit target. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="focus-ring grid h-10 w-11 shrink-0 place-items-center rounded-lg disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        aria-hidden
        className={`relative h-6 w-11 rounded-full transition-colors ${checked ? "bg-amber" : "bg-fill ring-1 ring-inset ring-line"}`}
      >
        {/* track 44 (w-11), knob 20 (h-5 w-5), 2px inset each side → travel 20px,
            so the knob seats symmetrically at both ends (no flush-right wonk). */}
        <span
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-5" : "translate-x-0"}`}
        />
      </span>
    </button>
  );
}

/** A labelled row wrapping a Toggle - a capability/setting with title + description. */
export function ToggleRow({
  checked,
  onChange,
  title,
  desc,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  desc: string;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 ${disabled ? "opacity-60" : ""}`}>
      <div>
        <div className="text-sm font-medium text-ink">{title}</div>
        <div className="mt-0.5 text-xs text-muted">{desc}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

/**
 * Network-posture selector: two radio cards, Public vs Isolated. The choice sets
 * `networkMode` and drives what the agent can reach - Public has outbound
 * internet (web tools work); Isolated has NO public egress and reaches Bedrock
 * privately for model inference only. Mirrors ModelPicker's chip semantics but
 * as fuller cards, since the trade-off deserves a sentence each.
 */
export function NetworkModePicker({
  value,
  onChange,
}: {
  value: "public" | "isolated";
  onChange: (m: "public" | "isolated") => void;
}) {
  const options = [
    {
      key: "public" as const,
      icon: <Globe className="h-4 w-4" />,
      title: "Public",
      desc: "Outbound internet access. Web search and fetch are available.",
    },
    {
      key: "isolated" as const,
      icon: <ShieldCheck className="h-4 w-4" />,
      title: "Isolated",
      desc: "No public internet. Reaches Bedrock privately for model inference only.",
    },
  ];
  return (
    <div className="grid gap-2.5 sm:grid-cols-2" role="radiogroup" aria-label="Network mode">
      {options.map((o) => {
        const active = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.key)}
            className="focus-ring flex items-start gap-3 rounded-lg border p-3.5 text-left transition-colors"
            style={
              active
                ? { borderColor: TINT.accent, backgroundColor: `${TINT.accent}0d` }
                : { borderColor: TINT.line }
            }
          >
            <span
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
              style={
                active
                  ? { backgroundColor: TINT.accent, color: "#fff" }
                  : { backgroundColor: TINT.fill, color: TINT.muted }
              }
            >
              {o.icon}
            </span>
            <div>
              <div className="text-sm font-medium text-ink">{o.title}</div>
              <div className="mt-0.5 text-xs text-muted">{o.desc}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * System-prompt editor + a collapsible preview of the FULL prompt the agent
 * actually runs with: the platform's base/harness blocks (which vary with the
 * capability toggles) followed by the creator's own text. Renders from the same
 * shared `composeSystemPrompt` the runtime uses, so what's shown is exactly
 * what the model receives. `caps` reflects the live toggle state so the preview
 * updates as the creator flips base tools / web search / network mode / env vars.
 */
export function SystemPromptField({
  value,
  onChange,
  caps,
}: {
  value: string;
  onChange: (v: string) => void;
  caps: Omit<PromptContext, "hasSearch">;
}) {
  const [open, setOpen] = useState(false);
  // The deployed platform has the web-search gateway wired, so assume hasSearch
  // tracks the web-search capability (matches prod; local has fetch only). Compose
  // the exact prompt the model receives: platform blocks + the creator's text
  // appended verbatim (composeSystemPrompt is what the runtime calls too).
  const full = composeSystemPrompt({ ...caps, hasSearch: caps.webSearch }, value);
  return (
    <div>
      <div className="label mb-2">System prompt</div>
      <textarea
        className="field min-h-[130px] resize-y leading-relaxed"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Describe the agent's purpose, capabilities, and rules…"
      />
      <p className="mt-1.5 text-[11px] text-muted">
        Prepended to the platform's base prompt. Preview the exact full prompt the agent runs with below.
      </p>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="focus-ring mt-2 inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-amber-deep transition-colors hover:text-amber"
      >
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        {open ? "Hide" : "Preview"} full system prompt
      </button>
      {open && (
        <div className="mt-2.5">
          <PromptBlock
            label="Full system prompt (platform base + your prompt, verbatim)"
            text={full}
          />
        </div>
      )}
    </div>
  );
}

/** One labelled, read-only block of the composed system prompt (monospace). */
function PromptBlock({ label, text, muted = false }: { label: string; text: string; muted?: boolean }) {
  return (
    <div>
      <div className="label mb-1 text-faint">{label}</div>
      <pre
        className={`overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-line px-3 py-2.5 font-mono text-[11px] leading-relaxed ${
          muted ? "bg-canvas text-muted" : "bg-surface text-ink"
        }`}
      >
        {text}
      </pre>
    </div>
  );
}

/** Back link to the agent roster. */
export function BackLink() {
  return (
    <a
      href="#/"
      className="focus-ring inline-flex items-center gap-1.5 rounded-md text-sm text-muted transition-colors hover:text-ink"
    >
      <ArrowLeft className="h-4 w-4" />
      Agents
    </a>
  );
}

/**
 * A labelled value with a copy button, for a credential the user needs to get out of the browser and
 * into their code - a personal access token (genuinely shown once) or an agent's API key at create
 * and rotate. Copying has to be effortless either way.
 */
export function CopyRow({
  icon,
  label,
  value,
  mono,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="label mb-1.5 flex items-center gap-1.5">
        {icon}
        {label}
      </div>
      <div className="flex items-center gap-2">
        <code
          className={`min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-raised px-3 py-2.5 text-xs text-ink ${
            mono ? "font-mono" : ""
          }`}
        >
          {value}
        </code>
        <button
          className="btn-ghost !min-h-0 !px-2.5 !py-2.5"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          title="Copy"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="h-4 w-4 text-pine-deep" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

/** A skeleton block for loading states. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

/** Loading placeholder for the agent roster - mirrors the real row layout. */
export function AgentListSkeleton() {
  return (
    <div className="card divide-y divide-line">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-4 p-4">
          <Skeleton className="h-2 w-2 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-44" />
            <Skeleton className="h-3 w-72" />
          </div>
          <Skeleton className="h-5 w-24" />
        </div>
      ))}
    </div>
  );
}

/**
 * Left-rail + label color per trace event type. Reason is ink (the agent
 * thinking), tool call/result share the accent (observable work), inject is warn
 * (external), start faint, answer green, error red.
 */
const EVENT_TINT: Record<TrajectoryEvent["type"], string> = {
  session_start: TINT.faint,
  prompt: TINT.accentInk,
  text: TINT.ink,
  tool_input: TINT.accent,
  tool_result: TINT.accentInk,
  injected: TINT.warn,
  session_end: TINT.live,
  error: TINT.danger,
};

export function eventTint(type: TrajectoryEvent["type"]): string {
  return EVENT_TINT[type];
}

/**
 * Readable tool name: drop an MCP server namespace and un-snake the rest
 * (`web-search___WebSearch` → `web search`, `run_bash` → `run bash`).
 *
 * Shared by the trace viewer and the tool-usage charts - they render one tab apart, so
 * two spellings of the same tool would read as two different tools.
 */
export function prettyTool(name: string): string {
  const base = name.includes("___") ? name.split("___")[0]! : name;
  return base.replace(/[-_]/g, " ");
}
