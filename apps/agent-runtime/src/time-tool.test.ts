import { describe, it, expect } from "vitest";
import { buildTimeTool } from "./time-tool.js";

describe("get_current_time", () => {
  it("returns a valid ISO + UTC timestamp with no input", async () => {
    const t = buildTimeTool() as unknown as { invoke: (a: unknown) => Promise<{ iso: string; utc: string }> };
    const r = await t.invoke({});
    expect(r.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isNaN(Date.parse(r.iso))).toBe(false);
    expect(r.utc).toContain("GMT");
  });
});
