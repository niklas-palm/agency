import { describe, it, expect, vi } from "vitest";
import { generateApiKey, verifyApiKey, hashApiKey } from "./apikey.js";
import { newSessionId, isValidSessionId } from "./session-id.js";
import { authorizePayload } from "./auth.js";

describe("api keys", () => {
  it("verifies a generated key against its stored hash", () => {
    const { apiKey, hash } = generateApiKey();
    expect(verifyApiKey(apiKey, hash)).toBe(true);
  });

  it("rejects a wrong key", () => {
    const { hash } = generateApiKey();
    expect(verifyApiKey("af_wrong", hash)).toBe(false);
  });

  it("never stores the plaintext (hash differs from key)", () => {
    const { apiKey, hash } = generateApiKey();
    expect(hash).not.toContain(apiKey);
    expect(hash).toBe(hashApiKey(apiKey));
  });

  it("generates unique keys with the ag_ prefix", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.apiKey).toMatch(/^ag_/);
    expect(a.apiKey).not.toBe(b.apiKey);
    expect(a.hash).not.toBe(b.hash);
  });

  it("rejects an empty presented key", () => {
    const { hash } = generateApiKey();
    expect(verifyApiKey("", hash)).toBe(false);
  });

  it("rejects a key whose hash length differs (no timing-unsafe throw)", () => {
    // A valid-hex-but-wrong-length stored hash must not throw in timingSafeEqual.
    expect(verifyApiKey("af_x", "deadbeef")).toBe(false);
  });
});

describe("session ids", () => {
  it("generates AgentCore-compliant ids (33-100 chars)", () => {
    const id = newSessionId();
    expect(isValidSessionId(id)).toBe(true);
    expect(id.length).toBeGreaterThanOrEqual(33);
    expect(id.length).toBeLessThanOrEqual(100);
  });

  it("generates unique ids", () => {
    expect(newSessionId()).not.toBe(newSessionId());
  });

  it("rejects too-short ids", () => {
    expect(isValidSessionId("short")).toBe(false);
  });

  it("rejects ids with illegal characters", () => {
    expect(isValidSessionId("a".repeat(20) + "/" + "b".repeat(20))).toBe(false);
    expect(isValidSessionId("has spaces " + "x".repeat(30))).toBe(false);
  });

  it("rejects over-long ids (>100 chars)", () => {
    expect(isValidSessionId("a".repeat(101))).toBe(false);
  });

  it("accepts a compliant client-supplied id", () => {
    expect(isValidSessionId("my-app_" + "x".repeat(30))).toBe(true);
  });
});

describe("authorizePayload", () => {
  const SCOPE = "agency/api";

  it("authorizes an M2M token (client_id, correct scope) → its userId", () => {
    const d = authorizePayload({ client_id: "m2m-1", scope: SCOPE }, SCOPE);
    expect(d.ok).toBe(true);
    // authorizePayload now extracts identity only; org+role+scopes are resolved
    // separately (they need a membership lookup).
    expect(d.ok && d.userId).toBe("m2m-1");
  });

  it("authorizes a user token (sub) and prefers sub over client_id; pulls email", () => {
    const d = authorizePayload({ sub: "user-1", client_id: "web", scope: SCOPE, email: "a@b.co" }, SCOPE);
    expect(d.ok && d.userId).toBe("user-1");
    expect(d.ok && d.email).toBe("a@b.co");
  });

  it("accepts a token whose scope claim lists multiple scopes", () => {
    const d = authorizePayload({ sub: "u", scope: `openid ${SCOPE} email` }, SCOPE);
    expect(d.ok).toBe(true);
  });

  it("rejects (403) a token missing the required scope", () => {
    const d = authorizePayload({ sub: "u", scope: "openid email" }, SCOPE);
    expect(d).toEqual({ ok: false, status: 403, error: "missing required scope" });
  });

  it("rejects (403) a token with no scope claim", () => {
    const d = authorizePayload({ sub: "u" }, SCOPE);
    expect(d.ok).toBe(false);
  });

  it("rejects (401) a scoped token with no subject or client_id", () => {
    const d = authorizePayload({ scope: SCOPE }, SCOPE);
    expect(d).toEqual({ ok: false, status: 401, error: "token has no subject" });
  });

  it("does not substring-match scopes (guards against 'agency/apix')", () => {
    const d = authorizePayload({ sub: "u", scope: "agency/apix" }, SCOPE);
    expect(d.ok).toBe(false);
  });

  it("accepts an access token (token_use=access) with the scope", () => {
    const d = authorizePayload({ sub: "u", token_use: "access", scope: SCOPE }, SCOPE);
    expect(d.ok).toBe(true);
  });

  it("rejects a non-access token (e.g. an ID token) even with the scope", () => {
    const d = authorizePayload({ sub: "u", token_use: "id", scope: SCOPE }, SCOPE);
    expect(d).toEqual({ ok: false, status: 403, error: "not an access token" });
  });
});

describe("runtimeArnFor (network-mode routing)", () => {
  it("selects the isolated ARN only for isolated mode, public otherwise", async () => {
    vi.stubEnv("RUNTIME_ARN_PUBLIC", "arn:public");
    vi.stubEnv("RUNTIME_ARN_ISOLATED", "arn:isolated");
    vi.resetModules(); // re-read env at module load
    const { runtimeArnFor } = await import("./config.js");
    expect(runtimeArnFor("isolated")).toBe("arn:isolated");
    expect(runtimeArnFor("public")).toBe("arn:public");
    expect(runtimeArnFor(undefined)).toBe("arn:public"); // default
    vi.unstubAllEnvs();
  });
});
