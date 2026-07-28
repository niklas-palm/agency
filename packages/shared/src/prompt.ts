/**
 * The platform "harness" system prompt - the single source of truth for what
 * Agency prepends to every agent's own system prompt. Lives in shared so BOTH
 * the runtime (which sends it to the model) and the web UI (which shows the
 * creator the full picture) render from the exact same text and can never drift.
 *
 * Composition order (see composeSystemPrompt): base → isolated note → coding
 * tools → web tools → integrations note → env-var note → the creator's own prompt.
 */

/** The base prompt prepended to every agent. */
export const BASE_PROMPT = `You are an agent running on Agency, a managed agent platform.

Operating rules:
- Work autonomously toward the user's goal. When done, state the result plainly.
- Tools never throw: if a tool returns an { error, hint } object, read the hint and adapt.
- When you call tools in parallel, each call is INDEPENDENT - never nest one tool call
  inside another tool's parameters. Each parallel call carries its own complete arguments.
- You have get_current_time. Call it whenever the task touches dates - "today", "latest",
  "this year", recent events - rather than assuming what the date is; your training data is
  not "now".
- You may receive an <injected-message> mid-task - it is a new instruction from the
  user that arrived while you were working. Treat it as a first-class request and
  incorporate it into what you are doing.`;

/** Appended only when the base coding toolset is enabled. */
export const CODING_TOOLS_PROMPT = `You have a working directory and basic file + shell tools
(read_file, write_file, edit_file, run_bash). Use them to accomplish tasks that involve
reading, writing, or running things - including listing, globbing, and searching via
run_bash (ls, find, grep). Prefer small, verifiable steps.`;

/** Appended only for agents in isolated network mode (no public egress). */
export const ISOLATED_PROMPT = `You are running in an isolated environment with NO public
internet access. There is no web search or fetch, and shell commands cannot reach the
internet (network calls will fail). Do not attempt to browse, download, call external APIs,
or otherwise reach the network - rely only on your own knowledge, the provided input, and
your local tools. (Your own model inference reaches AWS Bedrock over a private connection;
that is separate and works normally.)`;

/**
 * Appended when web access is enabled. `web_search` is only listed when the
 * search gateway is actually wired (prod); otherwise only `fetch_webpage` is
 * available, so the prompt must not claim a tool the agent doesn't have.
 */
export function webToolsPrompt(hasSearch: boolean): string {
  const lines = ["You can access the public web:"];
  if (hasSearch) lines.push("- web_search - search the web for current information and return result links/snippets.");
  lines.push("- fetch_webpage - fetch an https:// URL and read its readable text.");
  lines.push(
    hasSearch
      ? "Use web_search to find sources, then fetch_webpage to read the most relevant one. Cite the URLs you used."
      : "Fetch pages by URL when a question needs current or external facts. Cite the URLs you used.",
  );
  if (hasSearch) {
    lines.push(
      "For current events: first check get_current_time, then search - and if results look " +
        "like a pre-event preview, search again with terms like \"final result\", \"winner\", " +
        'or "post-match" to get the outcome, not the forecast.',
    );
  }
  return lines.join("\n");
}

/**
 * Tell the model it has downstream API integrations available (by name), and to
 * discover their operations before calling. The platform injects credentials and
 * forwards the request, so the agent never handles secrets. Full operation details
 * come from `list_integration_operations` at run time (kept out of the prompt so a
 * large manifest doesn't bloat every turn).
 *
 * `canWriteFiles` (base tools on): also teach the model WHEN to persist a response to
 * disk via `call_integration`'s `outputPath` instead of pulling it into context - the
 * load-bearing pattern for a code agent that computes over fetched data. Omitted when
 * base tools are off (there'd be no run_bash to process the file anyway).
 */
export function integrationsPrompt(names: string[], canWriteFiles = false): string {
  const base =
    `You can call these downstream API integrations: ${names.join(", ")}. ` +
    "Use list_integration_operations to see their available operations, then " +
    "call_integration to invoke one. The platform injects credentials and forwards " +
    "the request - you never handle API keys or URLs directly.";
  if (!canWriteFiles) return base;
  return (
    base +
    " By default the response is returned to you directly - fine for reads, writes, and " +
    "small results. When you intend to PROCESS a response (parse, compute over, or page " +
    "through a large dataset) rather than just read it, pass call_integration an " +
    "`outputPath` (e.g. data/result.json): the body is written to that file in your " +
    "workspace instead of into your context, and you get back { status, path, bytes } to " +
    "work with from there. For a paginated API, use a distinct outputPath per page."
  );
}

/**
 * Tell the model which environment variables are available (names only - the
 * values may be secrets and must not enter the prompt/trajectory).
 */
export function envPrompt(keys: string[]): string {
  return (
    "The following environment variables are configured for you and available to your " +
    `tools (e.g. read them in run_bash via $NAME): ${keys.join(", ")}. ` +
    "Their values are secret - use them via the environment, don't print them."
  );
}

/** The capability inputs that decide which conditional blocks are added. */
export interface PromptContext {
  baseTools: boolean;
  webSearch: boolean;
  networkAccess: boolean;
  networkMode?: "public" | "isolated";
  /** Whether the managed web-search tool is wired (prod). The UI assumes true. */
  hasSearch: boolean;
  /** The env-var key names configured for the agent (values never included). */
  envKeys: string[];
  /** Names of attached integrations (values/URLs never included). */
  integrationNames?: string[];
}

/**
 * The platform-added blocks, in order, that precede the creator's own prompt -
 * i.e. everything Agency adds. The web UI shows these so a creator sees the full
 * system prompt their agent runs with, not just their own text.
 */
export function platformPromptBlocks(ctx: PromptContext): string[] {
  // Web tools require the webSearch + networkAccess toggles, and never in
  // isolated mode (no egress) - mirror agent.ts exactly.
  const webEnabled = ctx.networkMode !== "isolated" && ctx.webSearch && ctx.networkAccess;
  return [
    BASE_PROMPT,
    ctx.networkMode === "isolated" ? ISOLATED_PROMPT : "",
    ctx.baseTools ? CODING_TOOLS_PROMPT : "",
    webEnabled ? webToolsPrompt(ctx.hasSearch) : "",
    ctx.integrationNames?.length ? integrationsPrompt(ctx.integrationNames, ctx.baseTools) : "",
    ctx.envKeys.length ? envPrompt(ctx.envKeys) : "",
  ].filter((p) => p && p.trim());
}

/**
 * Compose the full system prompt the model receives: the platform blocks
 * followed by the creator's own prompt. This is exactly what the runtime sends.
 */
export function composeSystemPrompt(ctx: PromptContext, creatorPrompt: string): string {
  return [...platformPromptBlocks(ctx), creatorPrompt].filter((p) => p && p.trim()).join("\n\n");
}
