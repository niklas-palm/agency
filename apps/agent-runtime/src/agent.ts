/**
 * Agent composition. Merges the platform base prompt with the creator's system
 * prompt, wires the chosen model, the base toolset (if enabled), and the
 * mid-turn injection plugin. Mirrors the "compose from config" shape of the
 * reference harness, but config arrives in the invoke payload rather than a folder.
 */
import { Agent } from "@strands-agents/sdk";
import type { ToolList, Plugin } from "@strands-agents/sdk";
import { Skill, AgentSkills } from "@strands-agents/sdk/vended-plugins/skills";
import type { AgentConfig, ResolvedSkill, ResolvedIntegration } from "@agency/shared";
import { buildModel } from "./model.js";
import { buildBaseTools } from "./tools.js";
import { buildTimeTool } from "./time-tool.js";
import { buildFetchTool, buildWebSearchClient } from "./web-tools.js";
import { buildIntegrationTools } from "./integration-tools.js";
import { composeSystemPrompt } from "@agency/shared";
import { InjectionPlugin } from "./mailbox.js";
import { WEB_SEARCH_GATEWAY_URL } from "./config.js";

export interface BuildAgentArgs {
  config: AgentConfig;
  agentId: string;
  sessionId: string;
  /** The agent's attached skills, resolved to content (from the invoke payload). */
  skills?: ResolvedSkill[];
  /** The agent's attached integrations, resolved to a manifest (from the payload). */
  integrations?: ResolvedIntegration[];
  /** Called when a mailbox message is injected, so it can be recorded. */
  onInjected: (text: string) => void;
}

export function buildAgent({ config, agentId, sessionId, skills, integrations, onInjected }: BuildAgentArgs): Agent {
  // Per-agent env vars: sanitize the user's config.env (drop keys reserved for
  // the runtime's own internals) and hand the result to run_bash as its ONLY
  // extra environment - we never spread process.env into bash, so platform
  // internals (gateway/ingest URLs, AWS creds) don't appear in bash's own env.
  // The model is told which KEYS exist (names only, never values).
  const agentEnv = sanitizeEnv(config.env);
  const envKeys = Object.keys(agentEnv);

  // get_current_time is always available - every agent needs a real clock, and
  // it's inputless + side-effect-free, so there's no toggle to gate it behind.
  const tools: ToolList = [buildTimeTool(), ...(config.baseTools ? buildBaseTools(agentEnv) : [])];

  // Web tools require the webSearch toggle + network access, and never in isolated
  // mode (no public egress to use them). The control-plane's normalizeConfig
  // already forces webSearch/networkAccess off when isolated; this is the runtime's
  // own last line of defense so a mis-shaped config can't wire a dead web tool.
  const webEnabled = config.networkMode !== "isolated" && config.webSearch && config.networkAccess;
  // Web SEARCH is the AWS-managed AgentCore connector via a Gateway; only wired
  // when a gateway URL is configured (prod). Fetch works whenever web is enabled.
  const hasSearch = webEnabled && Boolean(WEB_SEARCH_GATEWAY_URL);
  if (webEnabled) {
    tools.push(buildFetchTool());
    if (hasSearch) tools.push(buildWebSearchClient(WEB_SEARCH_GATEWAY_URL));
  }

  // Integration tools (discovery + proxied call) - wired only when the payload
  // carried resolved integrations. They work in ANY network mode: the call goes to
  // the control-plane proxy (reachable via PrivateLink in isolated mode), never
  // directly to the downstream API, so isolation doesn't disable them.
  const resolvedIntegrations = integrations ?? [];
  tools.push(...buildIntegrationTools(resolvedIntegrations, { agentId, sessionId }));

  // Compose via the SHARED prompt module so the model gets exactly what the web
  // UI shows the creator (single source of truth). `hasSearch` tracks whether the
  // managed web-search tool was actually wired (prod-only), so the prompt never
  // claims a tool that isn't present.
  const systemPrompt = composeSystemPrompt(
    {
      baseTools: config.baseTools,
      webSearch: config.webSearch,
      networkAccess: config.networkAccess,
      networkMode: config.networkMode,
      hasSearch,
      envKeys,
      integrationNames: resolvedIntegrations.map((i) => i.name),
    },
    config.systemPrompt,
  );

  // Attached skills via the Strands AgentSkills plugin: metadata is injected into
  // the system prompt and the full instructions are loaded on demand via a tool
  // (progressive disclosure). `content` is the full SKILL.md (frontmatter + body),
  // so we let Strands parse it with Skill.fromContent - the same doc the user
  // authored is what the model sees. No filesystem needed.
  const plugins: Plugin[] = [new InjectionPlugin(onInjected)];
  if (skills && skills.length) {
    const instances = skills.map((s) => Skill.fromContent(s.content));
    plugins.push(new AgentSkills({ skills: instances }));
  }

  return new Agent({
    name: config.name,
    model: buildModel(config.model),
    tools,
    systemPrompt,
    plugins,
    printer: false,
  });
}

/**
 * Env keys/prefixes a user's config.env must never set, because they'd either
 * clobber the runtime's own operational config or (the security point) let a user
 * name a var that shadows a platform internal. We build run_bash's env from an
 * explicit safe base + the sanitized agent env, so this is defense-in-depth: the
 * runtime's real secrets aren't in bash's env at all, and these reserved names
 * can't be smuggled in via config either.
 */
const RESERVED_ENV = new Set([
  "AGENT_ID", "TRAJECTORY_TABLE", "SESSIONS_TABLE", "WEB_SEARCH_GATEWAY_URL",
  "WEB_SEARCH_REGION", "INGEST_URL", "RUNTIME_INGEST_KEY", "PATH", "HOME",
]);
const RESERVED_PREFIXES = ["AWS_", "LD_", "NODE_"];

function isReserved(key: string): boolean {
  return RESERVED_ENV.has(key) || RESERVED_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Return the agent's own env vars, dropping any reserved key. PURE - it does NOT
 * mutate process.env (the old approach did, which risked cross-session bleed on
 * the shared local runtime). The result is handed to run_bash as its extra env
 * and its keys are surfaced (names only) to the model.
 */
export function sanitizeEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!isReserved(k)) out[k] = v;
  }
  return out;
}
