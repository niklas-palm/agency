import { describe, it, expect } from "vitest";
import { BedrockModel } from "@strands-agents/sdk/models/bedrock";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import { MODELS, MODEL_KEYS } from "@agency/shared";
import { buildModel } from "./model.js";

describe("buildModel - provider selection", () => {
  it("builds a BedrockModel for an Anthropic model key", () => {
    expect(buildModel("opus-4.8")).toBeInstanceOf(BedrockModel);
    expect(buildModel("haiku-4.5")).toBeInstanceOf(BedrockModel);
  });

  it("builds an OpenAIModel (Bedrock Mantle) for an OpenAI model key", () => {
    const m = buildModel("gpt-oss-120b");
    expect(m).toBeInstanceOf(OpenAIModel);
    // Mantle routes through the Responses API by default and is stateless here.
    expect((m as OpenAIModel).api).toBe("responses");
  });

  it("uses the correct Bedrock model id from the shared MODELS map", () => {
    const m = buildModel("haiku-4.5") as BedrockModel;
    expect(m.getConfig().modelId).toBe("eu.anthropic.claude-haiku-4-5-20251001-v1:0");
  });

  /**
   * The OpenAI/Mantle path needs `@aws/bedrock-token-generator` at RUNTIME, and the Strands SDK
   * imports it LAZILY - on the first token mint, not at construction. So every existing test here
   * passed while the package was missing from the runtime's dependencies, and the failure only
   * appeared on a real turn: "Failed to get token from 'apiKey' function: bedrockMantleConfig
   * requires the '@aws/bedrock-token-generator' package".
   *
   * Verified against live Bedrock Mantle: with the package installed, the provider mints a bearer
   * token from the ordinary AWS credential chain (it is a base64'd SigV4-presigned
   * `bedrock.amazonaws.com/?Action=CallWithBearerToken` URL) and a real model call succeeds.
   * There is no credential-chain-only alternative on Node - `BedrockOpenAI` refuses to construct
   * without `apiKey` or `bedrockTokenProvider`, unlike the Python SDK's `openai[bedrock]`.
   *
   * This asserts the dependency is resolvable, which is the one thing that was actually wrong.
   */
  it("can resolve the token generator every OpenAI model needs at runtime", async () => {
    const mod = await import("@aws/bedrock-token-generator");
    expect(typeof mod.getTokenProvider).toBe("function");
  });

  /** Every non-Anthropic model takes the same branch, so one missing dep breaks all of them. */
  it("routes every OpenAI model in the shared map through the Mantle path", () => {
    const openaiKeys = MODEL_KEYS.filter((k) => MODELS[k].provider === "openai");
    expect(openaiKeys.length).toBeGreaterThan(0);
    for (const key of openaiKeys) {
      // Constructing must not throw for any of them - a model id typo or a missing branch would.
      expect(() => buildModel(key), key).not.toThrow();
    }
  });
});
