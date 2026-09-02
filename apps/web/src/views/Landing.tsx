/**
 * The landing page — shown to signed-out visitors (deployed only; no auto-redirect
 * to the hosted login). Its job: state plainly what the platform is, in an
 * engineer's register, and show the actual texture of using it rather than
 * describe it.
 *
 * The hero visual is a real session trajectory — the same typed, color-railed
 * event stream you watch in an agent's Run tab (prompt → reason → call →
 * result → an injected mid-turn message → answer). It's rendered from the app's own
 * `eventTint` palette, so the marketing surface and the product speak the same
 * visual language, and nothing here reads as stock art. Below it: the literal
 * HTTP contract, the three-beat lifecycle, one CTA.
 */
import { AgencyMark, eventTint } from "../components.js";
import type { TrajectoryEvent } from "@agency/shared";

export function Landing() {
  return (
    <div className="min-h-screen bg-canvas">
      {/* Slim top bar — just the mark + a sign-in affordance. */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <AgencyMark className="h-8 w-8" />
          <span className="font-display text-[19px] font-bold tracking-[-0.01em] text-ink">Agency</span>
        </div>
        <a href="#/login" className="btn-ghost !min-h-0 !px-3.5 !py-2 text-sm">
          Sign in
        </a>
      </header>

      {/* Hero — copy on the left, a real trajectory on the right. The headline is
          the three verbs the whole product is built around; the standfirst states
          the mechanism plainly, no pitch. */}
      <section className="mx-auto grid w-full max-w-6xl gap-12 px-5 pb-12 pt-14 sm:px-8 sm:pt-20 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-10">
        <div>
          <p className="eyebrow rise">Managed autonomous agents</p>
          <h1 className="mt-4 font-display text-[2.9rem] font-bold leading-[1.03] tracking-[-0.035em] text-ink rise sm:text-[3.75rem]">
            Configure an agent.
            <br className="hidden sm:block" /> Call it over HTTP.
            <br className="hidden sm:block" /> <span className="text-accent-ink">Watch it work.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted rise">
            An agent here is just a system prompt, a model, and the tools you hand it — stored as
            configuration, with no per-agent infrastructure to stand up. Invoke it and a session id
            comes back at once; it runs in its own isolated microVM. Poll the session to follow every
            step, or send a message while it's still running and it lands in the current turn.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3 rise">
            <a href="#/login" className="btn !min-h-[46px] !px-6 text-[15px]">
              Get started
            </a>
            <a href="#/docs" className="btn-ghost !min-h-[46px] !px-6 text-[15px]">
              Read the docs
            </a>
          </div>
        </div>

        <div className="rise">
          <TrajectoryGlimpse />
        </div>
      </section>

      {/* The contract — the literal request/response shape, in mono. Engineering
          proof over promise: this is exactly what your code sends and gets back. */}
      <section className="mx-auto w-full max-w-6xl px-5 py-10 sm:px-8">
        <div className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-2">
          <Wire
            label="Invoke"
            lines={[
              ["req", "POST /agents/:id/invoke"],
              ["req", '{ "prompt": "Triage new issues" }'],
              ["res", '200  { "sessionId": "sess_9f2c…",'],
              ["res", '       "status": "triggered" }'],
            ]}
          />
          <Wire
            label="Poll"
            lines={[
              ["req", "GET /agents/:id/sessions/sess_9f2c…"],
              ["res", '200  { "status": "working",'],
              ["res", '       "events": [ … ],'],
              ["res", '       "cursor": "018f…" }'],
            ]}
          />
        </div>
      </section>

      {/* How it works — three beats, editorial, no stock icons. */}
      <section className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-8">
        <p className="eyebrow">The lifecycle</p>
        <div className="mt-6 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
          <Beat
            n="01"
            title="Configure"
            body="A system prompt and a model. Attach skills, wire your own APIs in as tools, choose public or network-isolated egress, and decide how it's triggered. Editing config is a write — the next run picks it up."
          />
          <Beat
            n="02"
            title="Invoke"
            body="POST a prompt, get a session id back immediately. The turn runs async in a fresh microVM; because an agent is a record, there is nothing to deploy or warm up first."
          />
          <Beat
            n="03"
            title="Observe"
            body="Poll the trajectory with a cursor for just the new steps — each reason, tool call, and result. Inject mid-turn to steer, and read per-session tokens, cost, and duration."
          />
        </div>
      </section>

      {/* Closing CTA. */}
      <section className="mx-auto w-full max-w-6xl px-5 pb-24 sm:px-8">
        <div className="flex flex-col items-center gap-6 rounded-2xl border border-line bg-surface px-6 py-16 text-center shadow-card">
          <AgencyMark className="h-12 w-12" />
          <h2 className="max-w-xl font-display text-3xl font-bold leading-tight tracking-[-0.03em] text-ink sm:text-4xl">
            Create one and invoke it.
          </h2>
          <a href="#/login" className="btn !min-h-[46px] !px-6 text-[15px]">
            Get started
          </a>
        </div>
      </section>

      <footer className="mx-auto w-full max-w-6xl px-5 pb-12 sm:px-8">
        <div className="flex items-center justify-between border-t border-line pt-6">
          <span className="font-mono text-xs text-faint">Agency</span>
          <a href="#/docs" className="font-mono text-xs text-muted hover:text-ink">
            Docs
          </a>
        </div>
      </footer>
    </div>
  );
}

/** A how-it-works beat — a mono index, a sans title, plain body. No icons. */
function Beat({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="bg-canvas p-7">
      <span className="font-mono text-xs font-medium text-accent-ink">{n}</span>
      <h3 className="mt-3 font-display text-lg font-bold tracking-[-0.01em] text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
    </div>
  );
}

/** One half of the HTTP-contract panel: a labelled column of mono request/response
 *  lines. `req` lines read as ink (what you send), `res` as muted (what returns). */
function Wire({ label, lines }: { label: string; lines: [kind: "req" | "res", text: string][] }) {
  return (
    <div className="bg-canvas p-6">
      <span className="label text-accent-ink">{label}</span>
      <pre className="mt-3 overflow-x-auto font-mono text-[12.5px] leading-relaxed">
        {lines.map(([kind, text], i) => (
          <div key={i} className={kind === "req" ? "text-ink" : "text-muted"}>
            {text}
          </div>
        ))}
      </pre>
    </div>
  );
}

/**
 * The hero visual: a real session trajectory. The same typed, color-railed events
 * an agent's Run tab renders — reason (ink), call (marigold), result (clay),
 * an INJECTED message mid-run (warn), and the pine session_end — so the landing
 * shows the product's actual texture, drawn from the app's own `eventTint`, using
 * the app's own event labels. The injected line is the whole point of the
 * platform, so it's the beat that lands in the middle of the run. Decorative;
 * aria-hidden.
 */
function TrajectoryGlimpse() {
  const rows: { type: TrajectoryEvent["type"]; tag: string; text: string }[] = [
    { type: "prompt", tag: "prompt", text: "Triage new issues in acme/api and label them." },
    { type: "text", tag: "reason", text: "I'll list the open issues, then classify each one." },
    { type: "tool_input", tag: "call", text: "call_integration · github.listIssues { state: open }" },
    { type: "tool_result", tag: "result", text: "12 open issues" },
    { type: "injected", tag: "injected", text: "Skip anything already labeled wontfix." },
    { type: "text", tag: "reason", text: "Understood — filtering those out before I label." },
    { type: "tool_input", tag: "call", text: "call_integration · github.addLabels" },
    { type: "session_end", tag: "answer", text: "Labeled 9 issues, skipped 3 wontfix." },
  ];
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card" aria-hidden>
      {/* Session header — a live status dot + a mono session id, like the app. */}
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="inline-flex items-center gap-2 font-mono text-[11px] text-muted">
          <span className="h-1.5 w-1.5 rounded-full live-dot" style={{ backgroundColor: eventTint("session_end") }} />
          sess_9f2c4e
        </span>
        <span className="label">trajectory</span>
      </div>
      <div className="space-y-2.5 p-4">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-3 border-l-2 pl-3" style={{ borderColor: eventTint(r.type) }}>
            <span
              className="mt-0.5 w-14 shrink-0 font-mono text-[10px] font-medium uppercase tracking-wide"
              style={{ color: eventTint(r.type) }}
            >
              {r.tag}
            </span>
            <span className={`text-[13px] leading-snug ${r.type === "session_end" ? "text-ink" : "text-muted"}`}>
              {r.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
