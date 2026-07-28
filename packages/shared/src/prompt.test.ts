import { describe, it, expect } from "vitest";
import {
  BASE_PROMPT,
  CODING_TOOLS_PROMPT,
  ISOLATED_PROMPT,
  composeSystemPrompt,
  platformPromptBlocks,
  type PromptContext,
} from "./prompt.js";

const base: PromptContext = {
  baseTools: false,
  webSearch: false,
  networkAccess: true,
  hasSearch: false,
  envKeys: [],
};

describe("platformPromptBlocks", () => {
  it("always starts with the base prompt", () => {
    expect(platformPromptBlocks(base)[0]).toBe(BASE_PROMPT);
  });

  it("adds the coding-tools block only when baseTools is on", () => {
    expect(platformPromptBlocks(base)).not.toContain(CODING_TOOLS_PROMPT);
    expect(platformPromptBlocks({ ...base, baseTools: true })).toContain(CODING_TOOLS_PROMPT);
  });

  it("adds the web block only when webSearch + networkAccess and NOT isolated", () => {
    // enabled
    const web = platformPromptBlocks({ ...base, webSearch: true, networkAccess: true, hasSearch: true });
    expect(web.some((b) => b.includes("access the public web"))).toBe(true);
    // isolated forces it off even if the flags are set
    const iso = platformPromptBlocks({ ...base, webSearch: true, networkAccess: true, networkMode: "isolated" });
    expect(iso.some((b) => b.includes("access the public web"))).toBe(false);
  });

  it("adds the isolated notice in isolated mode", () => {
    expect(platformPromptBlocks({ ...base, networkMode: "isolated" })).toContain(ISOLATED_PROMPT);
    expect(platformPromptBlocks(base)).not.toContain(ISOLATED_PROMPT);
  });

  it("adds an env-var block naming the keys (never values) when env keys exist", () => {
    const blocks = platformPromptBlocks({ ...base, envKeys: ["OPENAI_KEY", "DB_URL"] });
    const env = blocks.find((b) => b.includes("environment variables"));
    expect(env).toContain("OPENAI_KEY");
    expect(env).toContain("DB_URL");
  });

  it("adds an integrations block naming the integrations only when some are attached", () => {
    expect(platformPromptBlocks(base).some((b) => b.includes("downstream API integrations"))).toBe(false);
    const blocks = platformPromptBlocks({ ...base, integrationNames: ["Petstore", "Weather"] });
    const block = blocks.find((b) => b.includes("downstream API integrations"));
    expect(block).toContain("Petstore");
    expect(block).toContain("Weather");
    expect(block).toContain("list_integration_operations");
  });
});

describe("composeSystemPrompt", () => {
  it("appends the creator's prompt after the platform blocks", () => {
    const full = composeSystemPrompt(base, "You are a poet.");
    expect(full.startsWith(BASE_PROMPT)).toBe(true);
    expect(full.endsWith("You are a poet.")).toBe(true);
  });

  it("omits an empty creator prompt (no trailing blank block)", () => {
    const full = composeSystemPrompt(base, "");
    expect(full).toBe(BASE_PROMPT);
  });
});
