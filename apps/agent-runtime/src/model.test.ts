import { describe, it, expect } from "vitest";
import { BedrockModel } from "@strands-agents/sdk/models/bedrock";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
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
});
