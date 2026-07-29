/**
 * Per-session capability tokens: a token is scoped to exactly one (orgId,
 * agentCreatedBy, agentId, sessionId) and carries the granted integration ids, so
 * a token leaked from a microVM only authorizes that session's own telemetry + its
 * own integrations, never another tenant's. Tested with a stubbed signing key +
 * fresh import (the key is read from config at module load).
 */
import { describe, it, expect, vi } from "vitest";

async function tokenModule(key = "test-signing-key") {
  vi.stubEnv("RUNTIME_INGEST_KEY", key);
  vi.resetModules();
  return import("./session-token.js");
}

describe("session tokens", () => {
  it("mints a token whose claims are its own (orgId, agentCreatedBy, agentId, sessionId, integrationIds)", async () => {
    const { mintSessionToken, verifySessionToken } = await tokenModule();
    const t = mintSessionToken("org-1", "user-1", "agent-1", "sess-1", ["int-a", "int-b"]);
    expect(t).toBeTruthy();
    expect(verifySessionToken(t)).toEqual({
      orgId: "org-1",
      agentCreatedBy: "user-1",
      agentId: "agent-1",
      sessionId: "sess-1",
      integrationIds: ["int-a", "int-b"],
    });
    vi.unstubAllEnvs();
  });

  it("defaults to no integration grant when none is passed", async () => {
    const { mintSessionToken, verifySessionToken } = await tokenModule();
    const t = mintSessionToken("org-1", "user-1", "agent-1", "sess-1");
    expect(verifySessionToken(t)).toEqual({
      orgId: "org-1",
      agentCreatedBy: "user-1",
      agentId: "agent-1",
      sessionId: "sess-1",
      integrationIds: [],
    });
    vi.unstubAllEnvs();
  });

  it("binds the integration grant to the signature (can't append an id post-hoc)", async () => {
    const { mintSessionToken, verifySessionToken } = await tokenModule();
    const t = mintSessionToken("org", "u", "a", "s", ["int-a"]);
    const claims = verifySessionToken(t);
    expect(claims?.integrationIds).toEqual(["int-a"]);
    // Tampering with any claim byte breaks the signature entirely.
    expect(verifySessionToken(t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"))).toBeNull();
    vi.unstubAllEnvs();
  });

  it("rejects a tampered / garbage / empty token", async () => {
    const { mintSessionToken, verifySessionToken } = await tokenModule();
    const t = mintSessionToken("org", "u", "a", "s");
    expect(verifySessionToken(t + "x")).toBeNull(); // tampered sig
    expect(verifySessionToken("garbage")).toBeNull();
    expect(verifySessionToken("")).toBeNull();
    vi.unstubAllEnvs();
  });

  it("rejects an expired token", async () => {
    const { mintSessionToken, verifySessionToken } = await tokenModule();
    const now = 1_000_000_000_000;
    const t = mintSessionToken("org", "u", "a", "s", [], now);
    // 10h later (TTL is 9h) → expired.
    expect(verifySessionToken(t, now + 10 * 60 * 60 * 1000)).toBeNull();
    // Still valid at 1h later.
    expect(verifySessionToken(t, now + 60 * 60 * 1000)).not.toBeNull();
    vi.unstubAllEnvs();
  });

  it("mints empty + verifies null when no signing key is configured", async () => {
    const { mintSessionToken, verifySessionToken } = await tokenModule("");
    expect(mintSessionToken("org", "u", "a", "s")).toBe("");
    expect(verifySessionToken("anything")).toBeNull();
    vi.unstubAllEnvs();
  });

  it("handles ids containing the '.' delimiter char unambiguously (b64url-encoded claims)", async () => {
    const { mintSessionToken, verifySessionToken } = await tokenModule();
    const t = mintSessionToken("org.with.dots", "user.dots", "agent.with.dots", "sess.also.dotted", ["int-a", "int-b"]);
    expect(verifySessionToken(t)).toEqual({
      orgId: "org.with.dots",
      agentCreatedBy: "user.dots",
      agentId: "agent.with.dots",
      sessionId: "sess.also.dotted",
      integrationIds: ["int-a", "int-b"],
    });
    vi.unstubAllEnvs();
  });

  it("is not forgeable without the signing key (different key → verify null)", async () => {
    const m1 = await tokenModule("key-one");
    const t = m1.mintSessionToken("org", "u", "a", "s");
    const m2 = await tokenModule("key-two");
    expect(m2.verifySessionToken(t)).toBeNull();
    vi.unstubAllEnvs();
  });

  /**
   * The Slack reply target is an OPTIONAL 7th claim, and its position is load-bearing: verify
   * splits the signature off at the LAST dot, so a claim placed after `exp` is read as the
   * signature and the token fails. That shipped, and every Slack run's telemetry 401'd in
   * production while the agent ran and its output was discarded.
   *
   * Both shapes are asserted, because the bug broke one while leaving the other working - which
   * is why the existing tests all passed.
   */
  it("round-trips a token carrying the Slack reply target, and one without", async () => {
    const { mintSessionToken, verifySessionToken } = await tokenModule();
    const withTs = mintSessionToken("o1", "u1", "a1", "s1", ["int-a"], Date.now(), "1700000000.000900");
    const claims = verifySessionToken(withTs);
    expect(claims).not.toBeNull();
    expect(claims).toMatchObject({
      orgId: "o1",
      agentId: "a1",
      sessionId: "s1",
      integrationIds: ["int-a"],
      replyToTs: "1700000000.000900",
    });

    // No target: unchanged from before the claim existed, and no stray field.
    const plain = verifySessionToken(mintSessionToken("o1", "u1", "a1", "s1", ["int-a"]));
    expect(plain).toMatchObject({ agentId: "a1", integrationIds: ["int-a"] });
    expect(plain && "replyToTs" in plain).toBe(false);
  });

  it("binds the reply target to the signature, so it can't be swapped for another thread", async () => {
    const { mintSessionToken, verifySessionToken } = await tokenModule();
    const t = mintSessionToken("o1", "u1", "a1", "s1", [], Date.now(), "1700000000.000900");
    const parts = t.split(".");
    // Re-point the target at a different message, keeping everything else.
    parts[5] = Buffer.from("1700000000.000001", "utf8").toString("base64url");
    expect(verifySessionToken(parts.join("."))).toBeNull();
  });
});
