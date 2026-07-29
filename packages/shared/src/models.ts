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
 * Prompt caching is ON for Anthropic (model.ts cacheConfig: "auto") and implicit
 * on the OpenAI models, so cache fields materially affect real cost - they are
 * priced separately here.
 *
 * ANTHROPIC: the rates are Bedrock's, NOT Anthropic's first-party list, and the
 * distinction is worth 10%: Bedrock publishes two tiers, and a `global.` profile is
 * cheaper than a geo-pinned (`eu.`/`us.`) or in-region one, which carries a 1.1x
 * uplift. `MODELS` uses `eu.` profiles (a profile prefix must match the calling
 * region), so these are the GEO-tier prices - if the platform ever switches to
 * `global.` profiles, divide by 1.1. Within a tier the rate is the same in
 * eu-north-1 and us-east-1. cacheRead = 0.1x input, cacheWrite = 1.25x input (the
 * 5-minute TTL, which is what a bare `cachePoint` asks for; the 1h TTL would be 2x,
 * and nothing here requests it).
 *
 * OPENAI-via-Mantle: AWS publishes a Mantle rate for `gpt-oss-*` only, so that one is
 * exact (and identical in both regions); the gpt-5.6 family is priced from OpenAI's
 * own standard short-context list, because AWS publishes nothing for it. Two known
 * gaps in those three, both bounded and neither worth modelling until a bill says
 * otherwise: AWS notes Bedrock-brokered OpenAI billing "may differ" from OpenAI's
 * list, and OpenAI's long-context tier (2x) isn't modelled - a very large prompt is
 * under-priced.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export const MODEL_PRICING: Record<ModelKey, ModelPrice> = {
  // Anthropic on Bedrock, geo-profile tier (= 1.1x the `global.` tier).
  "opus-4.8": { inputPerMTok: 5.5, outputPerMTok: 27.5, cacheReadPerMTok: 0.55, cacheWritePerMTok: 6.875 },
  // Sonnet 5 is on promotional launch pricing ($2/$10 global → $2.2/$11 geo) through
  // 2026-08-31; after that it moves to $3/$15 global → $3.3/$16.5 geo. Deliberately a
  // single current rate rather than a dated table: cost is priced when the dashboard
  // loads, so a date switch here would still re-price OLD runs at the new rate. Pricing
  // history properly needs an effective-dated table keyed on the run's endedAt.
  "sonnet-5": { inputPerMTok: 2.2, outputPerMTok: 11, cacheReadPerMTok: 0.22, cacheWritePerMTok: 2.75 },
  "haiku-4.5": { inputPerMTok: 1.1, outputPerMTok: 5.5, cacheReadPerMTok: 0.11, cacheWritePerMTok: 1.375 },
  // OpenAI via Bedrock Mantle. gpt-5.6-*: OpenAI standard list (cached input 0.1x,
  // cache write 1.25x). Strands' Responses adapter doesn't surface OpenAI's
  // `cache_write_tokens`, so cacheWrite is priced but always reports 0 today.
  "gpt-5.6-luna": { inputPerMTok: 1, outputPerMTok: 6, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
  "gpt-5.6-terra": { inputPerMTok: 2.5, outputPerMTok: 15, cacheReadPerMTok: 0.25, cacheWritePerMTok: 3.125 },
  "gpt-5.6-sol": { inputPerMTok: 5, outputPerMTok: 30, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  // gpt-oss-120b: AWS's published Mantle rate. AWS publishes no cached-token discount
  // for it and it runs on the Chat Completions path, which reports no cache fields at
  // all - so its cache rates are its input rate, never a fabricated discount.
  "gpt-oss-120b": { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.15, cacheWritePerMTok: 0.15 },
};

/**
 * Token usage for one session, split by billing driver. Defined in this leaf module
 * (not index.ts) because the helpers below operate on it and this file must import
 * nothing - see the header note about the import cycle. Re-exported from index.ts.
 *
 * The four fields are meant to be DISJOINT - each token counted exactly once, so a
 * total is their sum and a cost is four multiplications. A stored row is not
 * guaranteed to be, because providers disagree (see `inputIncludesCacheRead`), so
 * everything read-side goes through `normalizeUsage` first.
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
 * Whether this model's provider counts cache reads INSIDE `inputTokens`.
 *
 * The two providers report prompt-cache hits in opposite conventions, and taking one
 * for the other silently inflates both totals and cost:
 *  - Bedrock/Converse (Anthropic) EXCLUDES them: total input = inputTokens +
 *    cacheRead + cacheWrite (documented on the Converse `TokenUsage` type).
 *  - OpenAI (Responses + Chat) INCLUDES them: `cached_tokens` counts how many of
 *    `input_tokens` came from cache, and the cached rate REPLACES the input rate for
 *    those tokens. Strands maps it onto the same `cacheReadInputTokens` field the
 *    Bedrock adapter uses, so nothing downstream can tell them apart.
 * Keyed off the provider in `MODELS` rather than a per-model flag - it's a property of
 * the endpoint, not the model. An unrecognized model is assumed disjoint (it prices at
 * 0 anyway, and the alternative subtracts tokens a caller never double-counted).
 */
export function inputIncludesCacheRead(model: string): boolean {
  return Object.hasOwn(MODELS, model) && MODELS[model as ModelKey].provider === "openai";
}

/**
 * Coerce a stored, self-reported usage bundle into disjoint drivers - the single
 * read-side entry point for a session row's tokens.
 *
 * Two jobs, both about not lying on the dashboard:
 *  1. De-overlap: where the provider counts cache reads inside `inputTokens`, subtract
 *     them, so `tokenTotal` counts each token once and `costFor` charges the cached
 *     ones at the cache rate INSTEAD of the input rate rather than as well as it. On a
 *     long agent session most input is a cache hit, so this is a multiple, not a rounding
 *     error.
 *  2. Coerce: every numeric on a summary row is written by the runtime and not
 *     shape-validated at ingest, so a missing or non-numeric field must become 0, never
 *     NaN - one NaN propagates into every total, percentile and bucket, and JSON renders
 *     it as `null`.
 *
 * Applied read-side (not at write time) for the same reason cost is: it re-states rows
 * already in the table, so a run recorded before this existed prices correctly on the
 * next dashboard load. `tokenTotal` and `costFor` therefore assume an already-normalized
 * bundle - don't hand them a raw row, and don't normalize twice.
 */
export function normalizeUsage(model: string, t: Partial<TokenUsage> | undefined): TokenUsage {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const cacheReadTokens = n(t?.cacheReadTokens);
  const inputTokens = n(t?.inputTokens);
  return {
    // max(0): the subtraction rests on a self-reported pair, so a bad row must not
    // contribute a NEGATIVE input count to the window.
    inputTokens: inputIncludesCacheRead(model) ? Math.max(0, inputTokens - cacheReadTokens) : inputTokens,
    outputTokens: n(t?.outputTokens),
    cacheReadTokens,
    cacheWriteTokens: n(t?.cacheWriteTokens),
  };
}

/**
 * Sum the four billing drivers. Shared so every "total tokens" in the product means
 * the same thing - a fifth driver added to TokenUsage must not leave the run list and
 * the dashboard silently disagreeing.
 *
 * Expects a bundle from `normalizeUsage` (disjoint drivers). Coerces each field anyway:
 * a session summary is self-reported by the runtime, so a partial or non-numeric bundle
 * must total 0, never NaN (one NaN poisons a whole window's sum).
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
 * Expects a bundle from `normalizeUsage`: the drivers must be disjoint, or the cached
 * tokens get charged at the input rate as well as the cache rate.
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
