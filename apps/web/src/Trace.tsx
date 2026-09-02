/**
 * The trajectory viewer: what an agent did, step by step.
 *
 * Shared by the Run tab (a live session, streaming) and the Monitor run list (a past
 * run, static) - one component so a finished run reads exactly like a live one.
 *
 * The shape of the problem: a real run is long. Every reasoning block, tool call and
 * tool result printed in full made the panel unscrollable, and a tool's RESULT sat as
 * its own row with nothing tying it to the call it answered. So:
 *
 * - Every step is ONE line, expandable. Click to see the full body.
 * - A tool result is folded INTO its originating call (matched on `toolUseId`), so a
 *   call and its response are one expandable step - the pairing is structural, not
 *   something the reader has to infer from adjacency.
 * - Only the two things a human actually came for are open by default: the prompt they
 *   sent, and the final answer.
 * - Bodies are parsed: JSON pretty-printed when it parses, prose rendered as markdown.
 */
import { useState } from "react";
import type { TrajectoryEvent } from "@agency/shared";
import { ChevronRight } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Divider, eventTint, prettyTool } from "./components.js";

/**
 * A tool call with the result that answered it, or any other event on its own.
 *
 * Pairing happens here rather than in the render so "which result belongs to which
 * call" is decided once, by `toolUseId`, instead of being re-derived from list order.
 */
interface Step {
  event: TrajectoryEvent;
  /** The `tool_result` answering this `tool_input`, when one arrived. */
  result?: TrajectoryEvent;
}

/**
 * Fold each `tool_result` into the `tool_input` it answers.
 *
 * Matched on `toolUseId`, which the runtime stamps on both. A result whose call we
 * never saw (a truncated trajectory, or an archived run missing its head) stays a
 * standalone step - dropping it would silently hide work the agent did.
 */
export function toSteps(events: TrajectoryEvent[]): Step[] {
  const steps: Step[] = [];
  const callIndex = new Map<string, Step>();
  for (const event of events) {
    if (event.type === "tool_result" && event.toolUseId) {
      const call = callIndex.get(event.toolUseId);
      // Only the FIRST result binds. A second one for the same id (a retry, or a
      // duplicated ingest) would otherwise silently replace the answer already shown
      // AND disappear itself - so it stays a visible step of its own.
      if (call && !call.result) {
        call.result = event;
        continue;
      }
    }
    const step: Step = { event };
    if (event.type === "tool_input" && event.toolUseId) callIndex.set(event.toolUseId, step);
    steps.push(step);
  }
  return steps;
}

export function Trace({
  events,
  sessionId,
  working,
  dispatching,
}: {
  events: TrajectoryEvent[];
  sessionId: string;
  working: boolean;
  dispatching?: boolean;
}) {
  const t0 = events[0] ? Date.parse(events[0].ts) : 0;
  const steps = toSteps(events);
  return (
    <div className="mt-7">
      <Divider label={sessionId ? `trace · ${sessionId.slice(0, 18)}` : "trace"} />

      {events.length === 0 && (
        <p className="mt-4 flex items-center gap-2 font-mono text-xs text-muted">
          {working && <span className="h-1.5 w-1.5 rounded-full bg-accent live-dot" />}
          {dispatching
            ? "Starting the agent. A new agent can take a minute or two to spin up the first time…"
            : working
              ? "Waiting for the agent to start…"
              : "No steps recorded for this run."}
        </p>
      )}

      <ol className="mt-4 divide-y divide-line/70">
        {steps.map((step, i) => (
          <StepRow key={step.event.cursor} step={step} index={i} t0={t0} />
        ))}
        {working && events.length > 0 && (
          <li className="flex items-center gap-3 py-2 font-mono text-xs text-live-ink">
            <span className="w-[46px] shrink-0 text-right tabular-nums">·</span>
            <span className="h-2 w-2 shrink-0 rounded-full bg-live live-dot" />
            <span>running…</span>
          </li>
        )}
      </ol>
    </div>
  );
}

/**
 * One step: a summary line, expandable to the full body.
 *
 * `prompt` and `session_end` open by default - the message a human sent and the answer
 * they came back for. Everything else (reasoning, tool calls, lifecycle markers) starts
 * collapsed, which is what makes a hundred-step run scannable.
 */
function StepRow({ step, index, t0 }: { step: Step; index: number; t0: number }) {
  const { event, result } = step;
  const [open, setOpen] = useState(() => DEFAULT_OPEN.has(event.type));
  const tint = eventTint(event.type);
  const body = bodyOf(event);
  const resultBody = result ? bodyOf(result) : "";
  // A lifecycle marker (session_start) has no body worth opening.
  const expandable = Boolean(body || resultBody);

  return (
    <li className="fade">
      <div className="flex items-baseline gap-3 py-2">
        <span className="w-[46px] shrink-0 text-right font-mono text-[10px] tabular-nums text-faint">
          {elapsed(event.ts, t0)}
        </span>
        {/* The whole line is the hit target when there's something to open. Not a
            <button> wrapping the row: the row is a summary, and nesting the tool name
            + status inside a button flattens them for a screen reader. */}
        <button
          type="button"
          onClick={() => expandable && setOpen((v) => !v)}
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
          className={`focus-ring -my-1 flex min-w-0 flex-1 items-baseline gap-2 rounded-md py-1 text-left transition-colors ${
            expandable ? "hover:bg-fill/60" : "cursor-default"
          }`}
        >
          <ChevronRight
            className={`h-3 w-3 shrink-0 self-center text-faint transition-transform duration-150 ${
              open ? "rotate-90" : ""
            } ${expandable ? "" : "opacity-0"}`}
            aria-hidden
          />
          <span
            className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: tint }}
          >
            {label(event)}
          </span>
          {event.toolName && (
            <span className="shrink-0 font-mono text-[11px] text-ink">{prettyTool(event.toolName)}</span>
          )}
          {/* The collapsed line still has to say something useful, or scanning is
              pointless - so show the first line of the body. */}
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{summarize(event, result)}</span>
          <span className="shrink-0 font-mono text-[10px] text-faint">·{String(index + 1).padStart(2, "0")}</span>
        </button>
      </div>

      {open && expandable && (
        <div className="space-y-2 pb-3 pl-[74px] pr-1">
          {body && <Body label={event.type === "tool_input" ? "input" : undefined} text={body} markdown={isProse(event)} />}
          {/* The result is nested under its call, so "what answered what" is visible
              rather than inferred from two adjacent rows. */}
          {resultBody && <Body label="result" text={resultBody} markdown={false} />}
        </div>
      )}
    </li>
  );
}

/**
 * A body block. JSON is pretty-printed; prose is rendered as markdown (the model writes
 * markdown, so raw asterisks and backticks are noise). `Markdown` escapes HTML by
 * default, so agent output can't inject markup into the console.
 *
 * GFM is on: agents routinely answer with tables, which plain CommonMark would render as
 * a wall of literal pipes.
 */
function Body({ label, text, markdown }: { label?: string; text: string; markdown: boolean }) {
  const pretty = prettyJson(text);
  return (
    <div>
      {label && (
        <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{label}</p>
      )}
      {pretty !== null ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-line bg-raised px-3 py-2 font-mono text-[11px] leading-relaxed text-ink">
          {pretty}
        </pre>
      ) : markdown ? (
        <div className="prose-trace rounded-md border border-line bg-raised px-3 py-2 text-xs leading-relaxed text-ink">
          <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
        </div>
      ) : (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-line bg-raised px-3 py-2 font-mono text-[11px] leading-relaxed text-ink">
          {text}
        </pre>
      )}
    </div>
  );
}

/** Open on mount: the message the user sent, and the answer they came back for. */
const DEFAULT_OPEN = new Set<TrajectoryEvent["type"]>(["prompt", "session_end", "error"]);

/** Event kinds whose body is model prose, so worth rendering as markdown. */
function isProse(e: TrajectoryEvent): boolean {
  return e.type === "text" || e.type === "session_end" || e.type === "prompt" || e.type === "injected";
}

/** Pretty-print `text` if it's JSON, else null (so the caller can pick a renderer). */
function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null; // looked like JSON, isn't - show it verbatim
  }
}

/** The one-line gist for a collapsed row. */
function summarize(event: TrajectoryEvent, result?: TrajectoryEvent): string {
  if (event.type === "session_start") return "session started";
  const body = bodyOf(event);
  // A tool call's first line is its command/args; if it has none, say what came back.
  const text = body || (result ? bodyOf(result) : "");
  const firstLine = text.replace(/\s+/g, " ").trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

/** Human label per event kind (the raw union is machine-y). */
function label(e: TrajectoryEvent): string {
  switch (e.type) {
    case "session_start":
      return "start";
    case "prompt":
      return "prompt";
    case "text":
      return "reason";
    case "tool_input":
      return "call";
    case "tool_result":
      return "result";
    case "injected":
      return "injected";
    case "session_end":
      return "answer";
    case "error":
      return "error";
  }
}

/** The displayable body of an event, by kind (tool args pretty-printed). */
function bodyOf(e: TrajectoryEvent): string {
  // session_start's `content` is the agent name, a lifecycle detail - not a message.
  if (e.type === "session_start") return "";
  if (e.type === "tool_input") return formatInput(e.input);
  return e.content ?? e.result ?? e.error ?? "";
}

/** Format tool input: surface a bash command plainly; otherwise pretty JSON. */
function formatInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.command === "string") return o.command;
    try {
      return JSON.stringify(o, null, 2);
    } catch {
      return String(input);
    }
  }
  return String(input);
}

/** mm:ss.s elapsed since the session's first event. */
export function elapsed(ts: string, t0: number): string {
  const ms = Date.parse(ts) - t0;
  // Tenths first, then divmod: splitting before rounding let 119.97s render "01:60.0"
  // (the seconds rounded to 60.0 without carrying the minute). A missing/garbled ts
  // gives NaN, which reads as 0 rather than "NaN:0NaN".
  const tenths = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 100)) : 0;
  const mm = Math.floor(tenths / 600);
  const ss = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
  return `${String(mm).padStart(2, "0")}:${ss}`;
}
