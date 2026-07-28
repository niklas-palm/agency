/**
 * normalizeConfig is the one canonical config shaper - it runs on read, on the
 * API response, and when diffing for a version bump. These tests pin the
 * networkMode invariants it enforces (the load-bearing part of isolated mode:
 * an isolated agent can NEVER carry web capabilities, on any path).
 */
import { describe, it, expect } from "vitest";
import { normalizeConfig } from "./agents.js";
import type { AgentConfig } from "@agency/shared";

const base: AgentConfig = {
  name: "bot",
  systemPrompt: "s",
  model: "haiku-4.5",
  baseTools: true,
  webSearch: true,
  networkAccess: true,
  triggers: [{ type: "api" }],
};

describe("normalizeConfig - networkMode", () => {
  it("drops the default public mode so it diffs equal to a legacy record", () => {
    expect(normalizeConfig({ ...base, networkMode: "public" }).networkMode).toBeUndefined();
    // A record that never had the field is unchanged.
    expect(normalizeConfig(base).networkMode).toBeUndefined();
  });

  it("forces web capabilities OFF in isolated mode (there's no internet)", () => {
    const out = normalizeConfig({ ...base, networkMode: "isolated", webSearch: true, networkAccess: true });
    expect(out.networkMode).toBe("isolated");
    expect(out.webSearch).toBe(false);
    expect(out.networkAccess).toBe(false);
  });

  it("leaves web capabilities intact in public mode", () => {
    const out = normalizeConfig({ ...base, webSearch: true, networkAccess: true });
    expect(out.webSearch).toBe(true);
    expect(out.networkAccess).toBe(true);
  });

  it("is idempotent", () => {
    const once = normalizeConfig({ ...base, networkMode: "isolated" });
    expect(normalizeConfig(once)).toEqual(once);
  });
});
