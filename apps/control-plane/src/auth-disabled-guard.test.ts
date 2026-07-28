/**
 * AUTH_DISABLED=true turns every caller into an admin, so the guard that decides
 * when it's allowed is load-bearing: get it wrong and a real deployment serves an
 * unauthenticated admin API. It runs at module load, so each case imports config.ts
 * fresh with its own env (resetModules + a dynamic import).
 */
import { describe, it, expect, afterEach, vi } from "vitest";

/** Load config.ts fresh under the given env; resolves true if it refused to start. */
async function refuses(env: Record<string, string>): Promise<boolean> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  try {
    await import("./config.js");
    return false;
  } catch {
    return true;
  }
}

afterEach(() => vi.unstubAllEnvs());

describe("the AUTH_DISABLED guard", () => {
  it("allows a genuinely local dev stack", async () => {
    expect(await refuses({ AUTH_DISABLED: "true", PUBLIC_API_URL: "http://localhost:8787" })).toBe(false);
  });

  it("allows the loopback IP forms", async () => {
    expect(await refuses({ AUTH_DISABLED: "true", PUBLIC_API_URL: "http://127.0.0.1:8787" })).toBe(false);
    expect(await refuses({ AUTH_DISABLED: "true", PUBLIC_API_URL: "http://[::1]:8787" })).toBe(false);
  });

  it("refuses a real deployment", async () => {
    expect(
      await refuses({ AUTH_DISABLED: "true", PUBLIC_API_URL: "https://api.example.com" }),
    ).toBe(true);
  });

  it("refuses MODE=prod even on a localhost URL", async () => {
    expect(
      await refuses({ AUTH_DISABLED: "true", MODE: "prod", PUBLIC_API_URL: "http://localhost:8787" }),
    ).toBe(true);
  });

  /**
   * The bypass this guard was rewritten to close: a string-prefix test sees
   * "http://localhost:8787…" and passes, but everything before the `@` is USERINFO -
   * the real host is evil.com. Parsing the URL is the only way to be sure.
   */
  it("refuses a loopback-looking prefix whose real host is remote (userinfo)", async () => {
    expect(new URL("http://localhost:8787@evil.com/").hostname).toBe("evil.com"); // the premise
    expect(
      await refuses({ AUTH_DISABLED: "true", PUBLIC_API_URL: "http://localhost:8787@evil.com/" }),
    ).toBe(true);
  });

  it("refuses a hostname that merely starts with localhost", async () => {
    expect(
      await refuses({ AUTH_DISABLED: "true", PUBLIC_API_URL: "http://localhost.evil.com/" }),
    ).toBe(true);
  });

  it("refuses an unparseable URL rather than falling open", async () => {
    expect(await refuses({ AUTH_DISABLED: "true", PUBLIC_API_URL: "not a url" })).toBe(true);
    expect(await refuses({ AUTH_DISABLED: "true", PUBLIC_API_URL: "" })).toBe(true);
  });

  it("starts normally when AUTH_DISABLED is unset, whatever the URL", async () => {
    expect(await refuses({ PUBLIC_API_URL: "https://api.example.com" })).toBe(false);
  });
});
