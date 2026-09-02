/**
 * Integration snippets: how to trigger an agent and poll its trace from another
 * system. The console Run panel is for humans; this is for wiring the agent into
 * code. Three tabs (curl / TypeScript / Python), each a complete trigger→poll
 * flow, with copy-to-clipboard.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { TINT } from "./theme.js";

/**
 * A stand-in used when we have no key to show - i.e. for a caller who can only VIEW the agent, since
 * the server omits `apiKey` for them. A writer sees the real key prefilled. Angle-bracketed so it
 * can't
 * be mistaken for a real credential and pasted as-is - a bare `ag_your_api_key` reads
 * like a key, and the invoke 401 can't tell you which of the id/key was wrong.
 */
const KEY_PLACEHOLDER = "<AGENT_API_KEY>";

export function CodeSamples({ invokeUrl, apiKey }: { invokeUrl: string; apiKey?: string }) {
  const [lang, setLang] = useState<Lang>("curl");
  const key = apiKey ?? KEY_PLACEHOLDER;
  const code = SNIPPETS[lang](invokeUrl, key);

  return (
    <div>
      <LangToggle langs={LANGS} value={lang} onChange={setLang} className="mb-3" />
      <CodeBlock code={code} lang={lang} />
      {!apiKey && (
        <p className="mt-2 font-mono text-[11px] text-muted">
          Replace <span className="text-ink">{KEY_PLACEHOLDER}</span> with the key you saved when you
          created the agent, or rotate it on this page to get a new one.
        </p>
      )}
    </div>
  );
}

/** A row of language tabs. Shared by the integrate panel and the docs recipes;
 *  on docs, one shared `value`/`onChange` makes every recipe switch together. */
export function LangToggle<L extends Lang>({
  langs,
  value,
  onChange,
  className = "",
}: {
  // Generic over the language subset: the docs page offers only a subset (no curl),
  // and a fixed `Lang` here would force it to carry unreachable entries to typecheck.
  langs: L[];
  value: L;
  onChange: (l: L) => void;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-1 ${className}`} role="tablist" aria-label="Language">
      {langs.map((l) => {
        const active = l === value;
        return (
          <button
            key={l}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(l)}
            className={`focus-ring inline-flex min-h-[40px] items-center rounded-lg px-3 font-mono text-xs transition-colors ${
              active ? "bg-ink text-canvas" : "text-muted hover:bg-fill hover:text-ink"
            }`}
          >
            {LABELS[l]}
          </button>
        );
      })}
    </div>
  );
}

export function CodeBlock({ code, lang }: { code: string; lang: Lang }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="btn-ghost absolute right-2 top-2 !min-h-0 !px-2 !py-1.5"
        title="Copy"
        aria-label="Copy code"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-live-ink" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <pre className="overflow-x-auto rounded-lg border border-line bg-raised px-4 py-3.5 font-mono text-xs leading-relaxed text-ink">
        <code>{highlight(code, lang)}</code>
      </pre>
    </div>
  );
}

/* ---- Lightweight, dependency-free syntax highlighting --------------------
 * Three short snippets don't warrant a highlighter library. This is a tiny
 * per-line tokenizer that colors comments, strings, numbers, and a small set
 * of keywords in the console palette. Strings are matched before comments so a
 * `#`/`//` inside a string (e.g. a URL) isn't mistaken for a comment. */
const TOKEN_COLOR = {
  comment: TINT.faint,
  string: TINT.live,
  keyword: TINT.accentInk, // the signature
  number: TINT.clayInk,
} as const;

const KEYWORDS: Record<Lang, Set<string>> = {
  curl: new Set(["curl"]),
  typescript: new Set(["const", "await", "do", "while", "new", "method", "headers", "body"]),
  python: new Set(["import", "while", "if", "break", "print"]),
};

/** Comment lead per language: shell/python use `#`, TS uses `//`. */
const COMMENT_RE: Record<Lang, RegExp> = {
  curl: /#[^\n]*/,
  python: /#[^\n]*/,
  typescript: /\/\/[^\n]*/,
};

function highlight(code: string, lang: string): React.ReactNode {
  const l = (lang as Lang) in KEYWORDS ? (lang as Lang) : "curl";
  const commentSrc = COMMENT_RE[l].source;
  // Order matters: strings, then comment, then number, then word.
  const re = new RegExp(
    `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(${commentSrc})|(\\b\\d+\\b)|([A-Za-z_$][\\w$]*)`,
    "g",
  );
  return code.split("\n").map((line, li) => {
    const parts: React.ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    let k = 0;
    while ((m = re.exec(line))) {
      if (m.index > last) parts.push(line.slice(last, m.index));
      const [tok, str, comment, num, word] = m;
      let color: string | undefined;
      if (str) color = TOKEN_COLOR.string;
      else if (comment) color = TOKEN_COLOR.comment;
      else if (num) color = TOKEN_COLOR.number;
      else if (word && KEYWORDS[l].has(word)) color = TOKEN_COLOR.keyword;
      parts.push(color ? <span key={k++} style={{ color }}>{tok}</span> : tok);
      last = m.index + tok.length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return (
      <span key={li}>
        {parts}
        {"\n"}
      </span>
    );
  });
}

export type Lang = "curl" | "typescript" | "python";
const LANGS: Lang[] = ["curl", "typescript", "python"];
const LABELS: Record<Lang, string> = { curl: "curl", typescript: "TypeScript", python: "Python" };

/**
 * Each snippet is the minimal flow: trigger the agent, then poll until it's done.
 * Kept deliberately simple - the delta-cursor optimization (`?after=`) is a
 * footnote in the API docs, not something you need to get started.
 */
const SNIPPETS: Record<Lang, (url: string, key: string) => string> = {
  curl: (url, key) => `# 1. Trigger the agent. Returns a session id right away; it runs in the background.
curl -sX POST ${url} \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt": "Summarize the latest release notes."}'
# → { "sessionId": "abc123", "status": "triggered" }

# 2. Poll the session for status + events. Repeat while "status" is "working".
curl -s "${sessionsUrl(url)}/abc123" -H "Authorization: Bearer ${key}"
# → { "status": "idle", "events": [ ... ] }`,

  typescript: (url, key) => `const API_KEY = "${key}";
const headers = { Authorization: \`Bearer \${API_KEY}\`, "Content-Type": "application/json" };

// 1. Trigger the agent - returns a session id; it runs in the background.
const start = await fetch("${url}", {
  method: "POST",
  headers,
  body: JSON.stringify({ prompt: "Summarize the latest release notes." }),
}).then((r) => r.json());

// 2. Poll once a second until the agent is done.
let session;
do {
  await new Promise((r) => setTimeout(r, 1000));
  session = await fetch(\`${sessionsUrl(url)}/\${start.sessionId}\`, { headers }).then((r) => r.json());
} while (session.status === "working");

console.log(session.events);`,

  python: (url, key) => `import time, requests

API_KEY = "${key}"
headers = {"Authorization": f"Bearer {API_KEY}"}

# 1. Trigger the agent - returns a session id; it runs in the background.
start = requests.post(
    "${url}",
    headers=headers,
    json={"prompt": "Summarize the latest release notes."},
).json()

# 2. Poll once a second until the agent is done.
while True:
    time.sleep(1)
    session = requests.get(f"${sessionsUrl(url)}/{start['sessionId']}", headers=headers).json()
    if session["status"] != "working":
        break

print(session["events"])`,
};

/**
 * Derive the poll base URL from the invoke URL. The invoke URL ends in
 * `/agents/:id/invoke`; polling is `/agents/:id/sessions/:sessionId`.
 */
function sessionsUrl(invokeUrl: string): string {
  return invokeUrl.replace(/\/invoke$/, "/sessions");
}
