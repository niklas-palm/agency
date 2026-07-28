/**
 * The per-turn budget is read at MODULE LOAD, so its parsing can only be tested by
 * importing config.ts fresh under a given env. That matters more than it looks: a
 * `const` used by the parser but declared after the three top-level calls sits in its
 * temporal dead zone and crashes the runtime at boot - and ONLY when someone actually
 * sets one of these vars, so every default-valued test passes.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

/** Load config.ts fresh under the given env and return the three budget values. */
async function budgetUnder(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  // assertLocalCredentials's gate reads DDB_ENDPOINT; keep it unset so importing
  // config.ts stays a pure parse.
  const m = await import("./config.js");
  return {
    turns: m.MAX_TURNS_PER_INVOCATION,
    tokens: m.MAX_TOKENS_PER_INVOCATION,
    deadline: m.INVOCATION_DEADLINE_MS,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("the per-turn budget from env", () => {
  it("uses generous defaults when nothing is set", async () => {
    const b = await budgetUnder({});
    expect(b.turns).toBe(60);
    expect(b.tokens).toBe(2_000_000);
    expect(b.deadline).toBe(30 * 60_000);
  });

  it("loads WITHOUT crashing when a var is actually set, and honours it", async () => {
    const b = await budgetUnder({
      MAX_TURNS_PER_INVOCATION: "2",
      MAX_TOKENS_PER_INVOCATION: "5000",
      INVOCATION_DEADLINE_MS: "1000",
    });
    expect(b).toEqual({ turns: 2, tokens: 5000, deadline: 1000 });
  });

  it("tolerates surrounding whitespace on a real value", async () => {
    const b = await budgetUnder({ MAX_TURNS_PER_INVOCATION: " 12 " });
    expect(b.turns).toBe(12);
  });

  it("treats 0 as 'disable this dimension'", async () => {
    const b = await budgetUnder({ MAX_TURNS_PER_INVOCATION: "0", INVOCATION_DEADLINE_MS: "0" });
    expect(b.turns).toBe(0);
    expect(b.deadline).toBe(0);
  });

  it("falls back on garbage rather than throwing", async () => {
    // " " matters specifically: Number(" ") is 0, which would DISABLE the cap - so a
    // whitespace-only value must fall back, not silently remove the guard.
    for (const bad of ["abc", "-1", "1.5", " ", "  \t ", "Infinity", "NaN"]) {
      const b = await budgetUnder({ MAX_TURNS_PER_INVOCATION: bad });
      expect(b.turns, bad).toBe(60);
    }
  });

  it("accepts exponential notation, since it's an exact integer", async () => {
    const b = await budgetUnder({ MAX_TOKENS_PER_INVOCATION: "1e6" });
    expect(b.tokens).toBe(1_000_000);
  });

  /**
   * The deadline feeds `AbortSignal.timeout` directly, so whatever survives parsing must
   * actually WORK. Two different ceilings are easy to confuse: above 2^32-1 it throws a
   * RangeError, but above 2^31-1 (Node's setTimeout max) it silently CLAMPS TO 1ms - so an
   * over-large value wouldn't be rejected, it would abort every turn instantly. Both brick
   * the shared runtime, so the test asserts behaviour, not just "didn't throw".
   */
  it.each([2 ** 31, 2 ** 32 - 1, 2 ** 32, Number.MAX_SAFE_INTEGER])(
    "rejects an unusable deadline (%i) and falls back to a WORKING one",
    async (tooBig) => {
      const b = await budgetUnder({ INVOCATION_DEADLINE_MS: String(tooBig) });
      expect(b.deadline).toBe(30 * 60_000);
      // The fallback must not fire immediately - the failure mode a clamp would cause.
      const signal = AbortSignal.timeout(b.deadline);
      await new Promise((r) => setTimeout(r, 5));
      expect(signal.aborted).toBe(false);
    },
  );

  it("accepts the largest deadline that still works", async () => {
    const b = await budgetUnder({ INVOCATION_DEADLINE_MS: String(2 ** 31 - 1) });
    expect(b.deadline).toBe(2 ** 31 - 1);
    const signal = AbortSignal.timeout(b.deadline);
    await new Promise((r) => setTimeout(r, 5));
    expect(signal.aborted).toBe(false);
  });
});

describe("assertLocalCredentials", () => {
  /**
   * Bedrock is called for real even locally, so the key pair must be present. But a
   * SESSION token is only there for temporary (STS/Identity Center) creds - someone
   * with a fresh AWS account has a long-lived IAM user key and no session token.
   * Requiring it turned that working setup into a boot failure demanding a variable
   * they can't obtain.
   */
  async function assertUnder(env: Record<string, string>) {
    vi.resetModules();
    vi.stubEnv("DDB_ENDPOINT", "http://dynamodb:8000"); // marks this as local dev
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const m = await import("./config.js");
    return () => m.assertLocalCredentials();
  }

  it("accepts a long-lived IAM key pair with NO session token", async () => {
    const run = await assertUnder({ AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "s", AWS_SESSION_TOKEN: "" });
    expect(run).not.toThrow();
  });

  it("accepts temporary creds with a session token", async () => {
    const run = await assertUnder({ AWS_ACCESS_KEY_ID: "ASIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "s", AWS_SESSION_TOKEN: "t" });
    expect(run).not.toThrow();
  });

  it("still refuses a missing key pair, naming what's absent", async () => {
    const run = await assertUnder({ AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" });
    expect(run).toThrow(/AWS_ACCESS_KEY_ID/);
    expect(run).toThrow(/AWS_SECRET_ACCESS_KEY/);
  });
});
