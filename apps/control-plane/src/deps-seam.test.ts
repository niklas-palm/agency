/**
 * The local/prod seam must default to LOCAL, and prod must be asked for explicitly.
 *
 * This is a regression test for a bug that hid in plain sight: `IS_LOCAL` was
 * `MODE === "local"`, but vitest sets `MODE=test`. So under test the composition root
 * handed the suite the REAL EventBridge and AgentCore clients. Eight tests passed anyway -
 * on a developer machine that happened to have AWS credentials - and failed on a clean CI
 * runner with `CredentialsProviderError` → 500. The whole test suite was quietly
 * credential-dependent.
 *
 * The rule now: only `MODE=prod` gets prod implementations. A typo'd or unknown MODE means
 * no-op, never "call AWS for real".
 */
import { describe, it, expect, afterEach, vi } from "vitest";

/** Load the composition root fresh under a given MODE and name its implementations. */
async function depsUnder(mode: string | undefined) {
  vi.resetModules();
  if (mode === undefined) vi.stubEnv("MODE", "");
  else vi.stubEnv("MODE", mode);
  const { buildDeps } = await import("./app.js");
  const d = buildDeps();
  return {
    scheduler: d.scheduler.constructor.name,
    invoker: d.invoker.constructor.name,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("buildDeps picks implementations from MODE", () => {
  it("MODE=prod gets the real AWS clients", async () => {
    const d = await depsUnder("prod");
    expect(d.scheduler).toBe("EventBridgeScheduleProvisioner");
    expect(d.invoker).toBe("AgentCoreInvoker");
  });

  it("MODE=local gets the local ones", async () => {
    const d = await depsUnder("local");
    expect(d.scheduler).toBe("LocalScheduleProvisioner");
    expect(d.invoker).toBe("HttpAgentInvoker");
  });

  /**
   * The case that broke CI. vitest sets MODE=test, so if this ever returns the AWS clients
   * again the suite silently depends on the developer's credentials.
   */
  it("MODE=test gets the LOCAL ones - the suite must never touch AWS", async () => {
    const d = await depsUnder("test");
    expect(d.scheduler).toBe("LocalScheduleProvisioner");
    expect(d.invoker).toBe("HttpAgentInvoker");
  });

  it("an unset or unknown MODE fails closed to local", async () => {
    for (const mode of [undefined, "staging", "PROD", "prod ", "dev"]) {
      const d = await depsUnder(mode);
      expect(d.scheduler, `MODE=${String(mode)}`).toBe("LocalScheduleProvisioner");
      expect(d.invoker, `MODE=${String(mode)}`).toBe("HttpAgentInvoker");
    }
  });
});
