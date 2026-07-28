/**
 * The Docs page: a short, beautiful guide to how Agency works and how to drive
 * it from code. Two halves:
 *
 *  1. "How it works" - plain-language concept cards (isolated microVM per agent,
 *     async invoke → session → poll, mid-turn injection, triggers). Enough to
 *     build a correct mental model; not exhaustive reference.
 *  2. "Recipes" - task-oriented code, TypeScript or Python, with ONE global
 *     language toggle so flipping it switches every recipe at once.
 *
 * The "Skill" download and callout hand a coding agent our canonical, server-
 * built guide (GET /skill.md) - the single reference an assistant needs to create
 * and manage agents. This page is the human-facing companion.
 */
import { useState } from "react";
import { Download, Boxes, Zap, Radio, GitMerge, Clock, Cpu, Bot, KeyRound, Plug } from "lucide-react";
import { CodeBlock, LangToggle, type Lang } from "../CodeSamples.js";

// The two languages the recipes cover (curl lives on the per-agent Integrate tab).
type DocsLang = Exclude<Lang, "curl">;
const LANGS: DocsLang[] = ["typescript", "python"];

// Placeholders the reader swaps for their own values. The invoke URL and key are
// shown on each agent's Integrate tab; these keep the docs agent-agnostic.
//
// The placeholders are ANGLE-BRACKETED on purpose: a bare `AGENT_ID` reads as a valid
// URL segment and got pasted verbatim by a real user, and since an unknown agent id and
// a wrong key return the SAME 401 (deliberately - so ids can't be enumerated), they had
// no way to tell which of the two they'd got wrong. `<...>` can't be mistaken for real.
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "https://your-api.example.com";
const AGENT_ID = "<AGENT_ID>";
const INVOKE = `${BASE}/agents/${AGENT_ID}/invoke`;
const SESSIONS = `${BASE}/agents/${AGENT_ID}/sessions`;
const SKILL_URL = `${BASE}/skill.md`;
const KEY = "<AGENT_API_KEY>";

export function Docs() {
  const [lang, setLang] = useState<DocsLang>("typescript");

  return (
    <div className="space-y-12 rise">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">The manual</p>
          <h1 className="mt-1.5 font-display text-[2.5rem] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Docs</h1>
          <p className="mt-2.5 max-w-xl text-sm leading-relaxed text-muted">
            Everything you need to build an agent and call it from your own code. Short by design -
            the concepts, then copy-paste recipes.
          </p>
        </div>
        <a className="btn-ghost shrink-0" href={SKILL_URL} download="SKILL.md" title="Download the coding-agent skill">
          <Download className="h-4 w-4" />
          <span className="hidden sm:inline">Skill</span>
        </a>
      </header>

      {/* The one reference to hand a coding agent: the self-contained skill (a
          Markdown guide) + the OpenAPI spec it points to. */}
      <a
        href={SKILL_URL}
        target="_blank"
        rel="noreferrer"
        className="focus-ring group flex items-center gap-3.5 rounded-xl border border-line bg-surface p-4 transition-colors hover:bg-raised"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-fill text-amber-deep">
          <Bot className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">Building with a coding agent?</div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            Hand it our skill - a single self-contained guide (with auth, scopes, and recipes)
            that points to the OpenAPI spec. Everything it needs to create and manage agents.
          </p>
        </div>
        <code className="hidden shrink-0 font-mono text-[11px] text-muted sm:block">/skill.md ↗</code>
      </a>

      <section className="space-y-5">
        <SectionHead
          title="How it works"
          sub="An agent is a model plus a system prompt, tools, and triggers - running in its own isolated machine."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {CONCEPTS.map((c) => (
            <ConceptCard key={c.title} {...c} />
          ))}
        </div>
      </section>

      <section className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <SectionHead title="Recipes" sub="The API your code calls. Pick a language - every recipe switches with it." />
          <LangToggle langs={LANGS} value={lang} onChange={setLang} />
        </div>
        <div className="space-y-6">
          {RECIPES.map((r) => (
            <RecipeCard key={r.title} recipe={r} lang={lang} />
          ))}
        </div>
      </section>

      <p className="border-t border-line pt-6 font-mono text-[11px] leading-relaxed text-faint">
        Coming soon: a lightweight <span className="text-muted">agency</span> CLI to trigger and tail
        agents straight from your terminal.
      </p>
    </div>
  );
}

function SectionHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{sub}</p>
    </div>
  );
}

function ConceptCard({ icon: Icon, title, body }: Concept) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-fill text-amber-deep">
          <Icon className="h-4 w-4" />
        </span>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
      </div>
      <p className="mt-2.5 text-sm leading-relaxed text-muted">{body}</p>
    </div>
  );
}

function RecipeCard({ recipe, lang }: { recipe: Recipe; lang: DocsLang }) {
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-line px-5 py-3.5">
        <h3 className="text-sm font-semibold text-ink">{recipe.title}</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{recipe.blurb}</p>
      </div>
      <div className="p-4">
        <CodeBlock code={recipe.code[lang]} lang={lang} />
      </div>
    </div>
  );
}

/* ---- Content (single source of truth for page + Markdown) ---------------- */

interface Concept {
  icon: typeof Boxes;
  title: string;
  body: string;
}

const CONCEPTS: Concept[] = [
  {
    icon: Boxes,
    title: "One isolated machine per agent run",
    body: "Every session runs in its own Firecracker microVM on AWS Bedrock AgentCore - a fresh, sandboxed machine with no access to other agents or sessions. It spins up on demand and tears down when idle.",
  },
  {
    icon: Zap,
    title: "Asynchronous by default",
    body: "Triggering an agent returns immediately with a session id - it keeps working in the background. You poll that session for status and results instead of holding a long request open.",
  },
  {
    icon: Radio,
    title: "A trajectory you can follow live",
    body: "As the agent reasons and calls tools, each step is logged to the session's trajectory. Poll with the cursor from your last response to stream only what's new - a live view of the agent's work.",
  },
  {
    icon: GitMerge,
    title: "Inject messages mid-turn",
    body: "Send another message to a session that's still working and it's woven into the running agent's context - no need to wait for it to finish. Great for steering or adding context on the fly.",
  },
  {
    icon: Cpu,
    title: "Models, tools & capabilities",
    body: "Pick a model (Claude or GPT), write a system prompt, and toggle capabilities: base coding tools, web search, and network access. Changes take effect on the next run - no redeploy.",
  },
  {
    icon: Clock,
    title: "Triggers",
    body: "Every agent has an API trigger (call it with its key). Add a schedule to run it on a cron or interval, unattended. Slack and GitHub triggers are on the way.",
  },
  {
    icon: Plug,
    title: "Skills & integrations",
    body: "Attach reusable Skills (Markdown know-how) and Integrations (downstream APIs) to any agent. For an integration, the credential stays on the platform - the agent calls a proxy that injects it, so the secret never reaches the model. Auth can be a static token or OAuth2 client-credentials (m2m), and operations can be auto-discovered from an OpenAPI URL.",
  },
  {
    icon: KeyRound,
    title: "Two ways to authenticate",
    body: "To trigger and poll ONE agent, use that agent's API key (on its Integrate tab). To let a coding assistant create and manage agents for you, mint a scoped Personal Access Token in Settings - it authenticates the management API on your behalf.",
  },
];

interface Recipe {
  title: string;
  blurb: string;
  /** Keyed by the languages this page offers - curl lives on the Integrate tab. */
  code: Record<DocsLang, string>;
}

const RECIPES: Recipe[] = [
  {
    title: "Trigger an agent",
    blurb: "Fire and forget - returns a session id right away.",
    code: {
      typescript: `const res = await fetch("${INVOKE}", {
  method: "POST",
  headers: { Authorization: "Bearer ${KEY}", "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Summarize today's top AI news." }),
}).then((r) => r.json());

console.log(res.sessionId); // e.g. "5f8c…" - use this to poll for the result`,
      python: `import requests

res = requests.post(
    "${INVOKE}",
    headers={"Authorization": "Bearer ${KEY}"},
    json={"prompt": "Summarize today's top AI news."},
).json()

print(res["sessionId"])  # e.g. "5f8c…" - use this to poll for the result`,
    },
  },
  {
    title: "Wait for the result",
    blurb: "Poll the session until the agent goes idle, then read its answer.",
    code: {
      typescript: `const headers = { Authorization: "Bearer ${KEY}" };

// Trigger, then poll once a second until the agent finishes.
const { sessionId } = await fetch("${INVOKE}", {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Summarize today's top AI news." }),
}).then((r) => r.json());

let session;
do {
  await new Promise((r) => setTimeout(r, 1000));
  session = await fetch(\`${SESSIONS}/\${sessionId}\`, { headers }).then((r) => r.json());
} while (session.status === "working");

// The final answer is the last event - its text, or an error if the run failed.
const last = session.events.at(-1);
console.log(last.content ?? last.error);`,
      python: `import time, requests

headers = {"Authorization": "Bearer ${KEY}"}

# Trigger, then poll once a second until the agent finishes.
session_id = requests.post(
    "${INVOKE}",
    headers=headers,
    json={"prompt": "Summarize today's top AI news."},
).json()["sessionId"]

while True:
    time.sleep(1)
    session = requests.get(f"${SESSIONS}/{session_id}", headers=headers).json()
    if session["status"] != "working":
        break

# The final answer is the last event - its text, or an error if the run failed.
last = session["events"][-1]
print(last.get("content") or last.get("error"))`,
    },
  },
  {
    title: "Follow the trajectory live",
    blurb: "Stream only new steps by passing the cursor from your last poll.",
    code: {
      typescript: `const headers = { Authorization: "Bearer ${KEY}" };
let cursor; // pass the newest cursor back each poll to get only the delta

while (true) {
  const url = new URL(\`${SESSIONS}/\${sessionId}\`);
  if (cursor) url.searchParams.set("after", cursor);
  const { status, events, cursor: next } = await fetch(url, { headers }).then((r) => r.json());

  for (const e of events) console.log(e.type, e.toolName ?? e.content ?? "");
  if (next) cursor = next;
  if (status !== "working") break;
  await new Promise((r) => setTimeout(r, 1000));
}`,
      python: `import time, requests

headers = {"Authorization": "Bearer ${KEY}"}
cursor = None  # pass the newest cursor back each poll to get only the delta

while True:
    params = {"after": cursor} if cursor else {}
    res = requests.get(f"${SESSIONS}/{session_id}", headers=headers, params=params).json()

    for e in res["events"]:
        print(e["type"], e.get("toolName") or e.get("content") or "")
    if res["cursor"]:
        cursor = res["cursor"]
    if res["status"] != "working":
        break
    time.sleep(1)`,
    },
  },
  {
    title: "Steer a running agent (inject mid-turn)",
    blurb: "Send another message to the same session while it's still working.",
    code: {
      typescript: `// Same endpoint, same sessionId - while status is "working" the message is
// injected into the running turn. The response status tells you which happened.
const res = await fetch("${INVOKE}", {
  method: "POST",
  headers: { Authorization: "Bearer ${KEY}", "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId, prompt: "Also include the sources you used." }),
}).then((r) => r.json());

console.log(res.status); // "injected" (mid-turn) | "triggered" (fresh) | "rejected" (busy, retry)`,
      python: `# Same endpoint, same session_id - while status is "working" the message is
# injected into the running turn. The response status tells you which happened.
res = requests.post(
    "${INVOKE}",
    headers={"Authorization": "Bearer ${KEY}"},
    json={"sessionId": session_id, "prompt": "Also include the sources you used."},
).json()

print(res["status"])  # "injected" (mid-turn) | "triggered" (fresh) | "rejected" (busy, retry)`,
    },
  },
];
