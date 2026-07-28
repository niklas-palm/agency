/**
 * Model factory - the one place a model provider is chosen. Anthropic models run
 * on Bedrock (`BedrockModel`); OpenAI models run through Bedrock's
 * OpenAI-compatible "Mantle" endpoint (`OpenAIModel` + bedrockMantleConfig),
 * which is keyless (AWS credentials, auto-minted bearer tokens). Both paths use
 * only AWS credentials, so nothing here needs an API key and OpenAI models still
 * work under an agent's network policy the same way Anthropic ones do.
 */
import type { Model } from "@strands-agents/sdk";
import { BedrockModel } from "@strands-agents/sdk/models/bedrock";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import { MODELS, type ModelKey } from "@agency/shared";
import { REGION, MANTLE_REGION } from "./config.js";

const MAX_TOKENS = 25_000;

/**
 * Per-request deadline + retry budget for the OpenAI/Mantle client.
 *
 * The SDK's default is a 10-minute timeout with 2 retries, so one wedged request
 * could hold a turn for half an hour - and a microVM lives at most 8h, all of it
 * billable. Anthropic-via-Bedrock doesn't need this: the AWS SDK already applies its
 * own timeouts and retry policy.
 */
const OPENAI_TIMEOUT_MS = 120_000;
const OPENAI_MAX_RETRIES = 2;

export function buildModel(modelKey: ModelKey): Model {
  const spec = MODELS[modelKey];

  if (spec.provider === "openai") {
    // Keyless: baseURL + bearer token derived from AWS creds via the Mantle config.
    // Mantle is us-east-1-only, so it's pinned to MANTLE_REGION independently of the
    // runtime's own REGION - a runtime elsewhere (e.g. eu-north-1) still reaches it.
    return new OpenAIModel({
      modelId: spec.modelId,
      maxTokens: MAX_TOKENS,
      bedrockMantleConfig: { region: MANTLE_REGION },
      // Bound each request so a hung call can't pin the microVM (the default is
      // 10 min × 2 retries). Only timeout/maxRetries here - Mantle derives
      // baseURL + apiKey itself and rejects those being set alongside it.
      clientConfig: { timeout: OPENAI_TIMEOUT_MS, maxRetries: OPENAI_MAX_RETRIES },
    });
  }

  // Bedrock/Anthropic. `cacheConfig: auto` turns on prompt caching after the
  // tool definitions. We omit `temperature` - the Converse API rejects it for
  // some Anthropic models, and the default is fine.
  return new BedrockModel({
    modelId: spec.modelId,
    region: REGION,
    maxTokens: MAX_TOKENS,
    cacheConfig: { strategy: "auto" },
  });
}
