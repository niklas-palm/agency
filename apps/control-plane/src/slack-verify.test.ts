import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { isUrlVerification, verifySlackSignature } from "./slack-verify.js";

const SECRET = "test_signing_secret_000000";
const NOW = 1_700_000_000;

function sign(rawBody: string, timestamp: number, secret = SECRET) {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

function verify(rawBody: string, over: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) {
  return verifySlackSignature({
    rawBody,
    timestamp: String(NOW),
    signature: sign(rawBody, NOW),
    signingSecret: SECRET,
    nowSeconds: NOW,
    ...over,
  });
}

describe("verifySlackSignature", () => {
  it("accepts a correctly signed request", () => {
    expect(verify('{"type":"event_callback"}')).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    const body = '{"type":"event_callback"}';
    const sig = sign(body, NOW);
    expect(verifySlackSignature({
      rawBody: '{"type":"event_callback","evil":true}',
      timestamp: String(NOW),
      signature: sig,
      signingSecret: SECRET,
      nowSeconds: NOW,
    })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature made with a different secret", () => {
    const body = "{}";
    expect(verify(body, { signature: sign(body, NOW, "another_secret_000000") })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a replay outside the window, in both directions", () => {
    const old = NOW - 301;
    expect(verify("{}", { timestamp: String(old), signature: sign("{}", old) })).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
    const future = NOW + 301;
    expect(verify("{}", { timestamp: String(future), signature: sign("{}", future) })).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("accepts a timestamp at the edge of the window", () => {
    const edge = NOW - 300;
    expect(verify("{}", { timestamp: String(edge), signature: sign("{}", edge) })).toEqual({ ok: true });
  });

  /**
   * Regression: a non-numeric timestamp must be REJECTED. `Number("abc")` is NaN and every
   * comparison with NaN is false, so a naive `Math.abs(now - ts) > window` guard would let it
   * through to the HMAC check - and if the attacker controls the timestamp they use in the
   * signature, the HMAC would then pass.
   */
  it("rejects a non-numeric timestamp rather than treating it as in-window", () => {
    const body = "{}";
    const bogus = "not-a-number";
    const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${bogus}:${body}`).digest("hex")}`;
    expect(verify(body, { timestamp: bogus, signature: sig })).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("rejects missing headers and an empty secret", () => {
    expect(verify("{}", { signature: undefined })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verify("{}", { timestamp: undefined })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verify("{}", { signingSecret: "" })).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects a wrong-length signature without throwing", () => {
    // timingSafeEqual throws on a length mismatch; the length pre-check must catch it.
    expect(() => verify("{}", { signature: "v0=short" })).not.toThrow();
    expect(verify("{}", { signature: "v0=short" })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("verifies over the RAW body, so key order matters", () => {
    // Two JSON texts that parse equal but differ byte-wise: only the signed one verifies.
    const signed = '{"a":1,"b":2}';
    const reordered = '{"b":2,"a":1}';
    const sig = sign(signed, NOW);
    expect(verify(signed, { signature: sig })).toEqual({ ok: true });
    expect(verify(reordered, { signature: sig })).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("isUrlVerification", () => {
  it("recognizes the genuine handshake", () => {
    expect(isUrlVerification({ type: "url_verification", challenge: "abc" })).toBe(true);
  });

  /**
   * THE regression test for this feature. The handshake is the one request answered without a
   * verified signature, so a body must not be able to claim `url_verification` while also
   * carrying an `event`. If this returns true, an unsigned payload could reach the invoke path.
   */
  it("refuses a handshake that also carries an event, so it must be signature-verified", () => {
    expect(
      isUrlVerification({
        type: "url_verification",
        challenge: "abc",
        event: { type: "app_mention", text: "do something destructive" },
      }),
    ).toBe(false);
  });

  it("refuses anything that isn't exactly the handshake shape", () => {
    expect(isUrlVerification({ type: "event_callback", challenge: "abc" })).toBe(false);
    expect(isUrlVerification({ type: "url_verification" })).toBe(false);
    expect(isUrlVerification({ type: "url_verification", challenge: "" })).toBe(false);
    expect(isUrlVerification({ type: "url_verification", challenge: 42 })).toBe(false);
    expect(isUrlVerification(null)).toBe(false);
    expect(isUrlVerification("url_verification")).toBe(false);
    expect(isUrlVerification([])).toBe(false);
  });
});
