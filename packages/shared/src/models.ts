/**
 * The model catalog - a dependency-free leaf module.
 *
 * This lives apart from `index.ts` on purpose: both `index.ts` and `openapi.ts`
 * need `MODEL_KEYS`, and `index.ts` also re-exports `openapi.ts`. Importing the
 * catalog from here (a leaf with no imports) instead of from `index.ts` keeps
 * those two files off a mutual import cycle - a cycle that previously let the
 * bundler evaluate `openapi.ts` before `MODEL_KEYS` was initialized and crashed
 * the control-plane Lambda at init. `index.ts` re-exports everything here, so
 * consumers still `import { MODELS } from "@agency/shared"`.
 */

/**
 * The models a creator can pick. Each maps to a concrete provider + model id in
 * the agent-runtime's model factory. `provider` decides which Strands model
 * class is constructed; `openai` models route through Bedrock's OpenAI-compatible
 * "Mantle" endpoint (keyless, via AWS credentials).
 */
export const MODELS = {
  // Anthropic IDs use the `eu.` cross-region inference-profile prefix - the
  // platform runs in eu-north-1, and a profile prefix must match the calling
  // region (a `us.` profile is invalid in eu-north-1). If the platform ever moves
  // region, re-prefix these (or switch to the region-agnostic `global.` profiles).
  "sonnet-5": { provider: "bedrock", modelId: "eu.anthropic.claude-sonnet-5" },
  "opus-4.8": { provider: "bedrock", modelId: "eu.anthropic.claude-opus-4-8" },
  "haiku-4.5": { provider: "bedrock", modelId: "eu.anthropic.claude-haiku-4-5-20251001-v1:0" },
  // OpenAI models run through Bedrock's OpenAI-compatible "Mantle" endpoint,
  // keyless via the AWS credential chain. The gpt-5.6 family (luna, terra, sol)
  // is served from the `/openai/v1` Mantle base path - requires @strands-agents/sdk
  // >= 1.10.0, which routes gpt-5.* there (earlier versions 404'd them).
  "gpt-5.6-luna": { provider: "openai", modelId: "openai.gpt-5.6-luna" },
  "gpt-5.6-terra": { provider: "openai", modelId: "openai.gpt-5.6-terra" },
  "gpt-5.6-sol": { provider: "openai", modelId: "openai.gpt-5.6-sol" },
  "gpt-oss-120b": { provider: "openai", modelId: "openai.gpt-oss-120b" },
} as const;

export type ModelKey = keyof typeof MODELS;
export type ModelProvider = (typeof MODELS)[ModelKey]["provider"];

export const MODEL_KEYS = Object.keys(MODELS) as ModelKey[];

/**
 * Whether a model can run under a given network mode. OpenAI/Mantle is us-east-1
 * only and reached cross-region over egress, which an ISOLATED (no-egress, no
 * cross-region PrivateLink) runtime can't do - so OpenAI models are unavailable in
 * isolated mode; Anthropic (in-region Bedrock) works in every mode. Rejected at
 * config time so it fails clearly on create/edit, not as an invoke-time hang.
 */
export function isModelAllowedInNetworkMode(model: ModelKey, networkMode: "public" | "isolated" | undefined): boolean {
  return networkMode !== "isolated" || MODELS[model].provider !== "openai";
}

/**
 * Presentation metadata for the model picker - a human label and the vendor
 * family. Kept alongside MODELS so the UI shows more than the raw key. `family`
 * drives the picker's per-vendor color coding; it's cosmetic (the transport
 * provider is in MODELS - a Claude model is served via provider `bedrock`).
 */
export type ModelFamily = "Anthropic" | "OpenAI";

export interface ModelInfo {
  label: string;
  family: ModelFamily;
}

export const MODEL_INFO: Record<ModelKey, ModelInfo> = {
  "sonnet-5": { label: "Claude Sonnet 5", family: "Anthropic" },
  "opus-4.8": { label: "Claude Opus 4.8", family: "Anthropic" },
  "haiku-4.5": { label: "Claude Haiku 4.5", family: "Anthropic" },
  "gpt-5.6-luna": { label: "GPT-5.6 Luna", family: "OpenAI" },
  "gpt-5.6-terra": { label: "GPT-5.6 Terra", family: "OpenAI" },
  "gpt-5.6-sol": { label: "GPT-5.6 Sol", family: "OpenAI" },
  "gpt-oss-120b": { label: "GPT-OSS 120B", family: "OpenAI" },
};

/**
 * Per-model price, USD per 1,000,000 tokens. Used to turn the token counts the
 * runtime records (see SessionSummary) into a dollar cost in the metrics
 * aggregation. Four drivers, because that's how LLM billing works:
 *   input, output, cacheRead (cheap - a cache hit), cacheWrite (a premium).
 * Prompt caching is ON for Anthropic (model.ts cacheConfig: "auto"), so cache
 * fields materially affect real cost - they are priced separately here.
 *
 * ANTHROPIC rates are the current Bedrock/first-party sticker prices (Bedrock
 * matches first-party): cacheRead ~= 0.1x input, cacheWrite (5-min) ~= 1.25x
 * input. OPENAI-via-Mantle rates are ESTIMATES pending verification against a
 * real AWS Bedrock Mantle bill (the Mantle-brokered rate can differ from
 * openai.com list prices) - correct these here once a bill is available; the
 * token counts they multiply are exact regardless.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export const MODEL_PRICING: Record<ModelKey, ModelPrice> = {
  // Anthropic (Bedrock) - verified sticker prices.
  "opus-4.8": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  "sonnet-5": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  "haiku-4.5": { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
  // OpenAI via Bedrock Mantle - ESTIMATES, verify against a real bill.
  "gpt-5.6-luna": { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheWritePerMTok: 1.5625 },
  "gpt-5.6-terra": { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheWritePerMTok: 1.5625 },
  "gpt-5.6-sol": { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheWritePerMTok: 1.5625 },
  "gpt-oss-120b": { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.015, cacheWritePerMTok: 0.1875 },
};

/**
 * Token usage for one session, split by billing driver. Defined in this leaf module
 * (not index.ts) because the helpers below operate on it and this file must import
 * nothing - see the header note about the import cycle. Re-exported from index.ts.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** An all-zero usage bundle (a legacy row, or a run that reported nothing). */
export function zeroTokens(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Sum the four billing drivers. Shared so every "total tokens" in the product means
 * the same thing - a fifth driver added to TokenUsage must not leave the run list and
 * the dashboard silently disagreeing.
 *
 * Coerces each field: a session summary is self-reported by the runtime, so a partial
 * or non-numeric bundle must total 0, never NaN (one NaN poisons a whole window's sum).
 */
export function tokenTotal(t: Partial<TokenUsage> | undefined): number {
  return (
    (Number(t?.inputTokens) || 0) +
    (Number(t?.outputTokens) || 0) +
    (Number(t?.cacheReadTokens) || 0) +
    (Number(t?.cacheWriteTokens) || 0)
  );
}

/**
 * Dollar cost of a token bundle for a model. Unknown model → 0 (tokens still tracked).
 *
 * Coerces each field, like `tokenTotal`: the bundle comes from a self-reported session
 * summary, so a partial or non-numeric one must price as 0 rather than NaN. NaN here
 * doesn't stay local - it sums into the window total and every percentile, and JSON
 * renders it as `null`, so ONE bad row used to blank the whole dashboard's cost.
 */
export function costFor(model: string, tokens: Partial<TokenUsage> | undefined): number {
  // Own-property check, not a bare index: `model` comes from a stored session row, and
  // a value like "constructor" would otherwise resolve an Object.prototype member and
  // poison every downstream total with NaN.
  const p = Object.hasOwn(MODEL_PRICING, model) ? MODEL_PRICING[model as ModelKey] : undefined;
  if (!p) return 0;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return (
    (n(tokens?.inputTokens) * p.inputPerMTok +
      n(tokens?.outputTokens) * p.outputPerMTok +
      n(tokens?.cacheReadTokens) * p.cacheReadPerMTok +
      n(tokens?.cacheWriteTokens) * p.cacheWritePerMTok) /
    1_000_000
  );
}
