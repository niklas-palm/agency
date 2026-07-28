/**
 * Slack request verification. This is the ONLY thing standing in front of the webhook route:
 * it is public and unauthenticated by necessity (Slack has no way to hold our credential), so
 * a mistake here turns the endpoint into an open invoke.
 *
 * Slack signs every request with HMAC-SHA256 over `v0:{timestamp}:{rawBody}` using the app's
 * signing secret. Three properties matter and each has bitten someone:
 *
 *  1. **Raw body.** The signature covers the exact bytes Slack sent. Re-serializing the parsed
 *     JSON changes key order and whitespace and breaks verification - so the route must read
 *     the raw text and verify BEFORE parsing.
 *  2. **Timestamp window.** Without it a captured request replays forever.
 *  3. **Constant-time compare.** A `===` on a hex digest leaks it a byte at a time.
 *
 * The one request type that CANNOT be verified is `url_verification` - see
 * `isUrlVerification` below.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * How far a request's timestamp may be from now. Slack recommends 5 minutes; that also
 * tolerates modest clock skew between their senders and our Lambda.
 */
const SLACK_TIMESTAMP_WINDOW_SECONDS = 300;

export interface SlackVerifyInput {
  /** The exact request body bytes, as text. NOT a re-serialized object. */
  rawBody: string;
  /** `X-Slack-Request-Timestamp`. */
  timestamp: string | undefined;
  /** `X-Slack-Signature`, e.g. `v0=abc…`. */
  signature: string | undefined;
  /** The app's signing secret. */
  signingSecret: string;
  /** Unix seconds; injectable so tests don't depend on the clock. */
  nowSeconds: number;
}

export type SlackVerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" };

/**
 * Verify a Slack request signature. Returns a reason rather than throwing, so the route can
 * log WHY a callback was rejected - "I mentioned it and nothing happened" is otherwise
 * undebuggable, and this is the most likely place for it to go wrong during setup.
 */
export function verifySlackSignature(input: SlackVerifyInput): SlackVerifyResult {
  const { rawBody, timestamp, signature, signingSecret, nowSeconds } = input;
  if (!timestamp || !signature || !signingSecret) return { ok: false, reason: "missing_headers" };

  // A non-numeric timestamp must fail as a timestamp problem, not sail through to the HMAC:
  // `Number.parseInt("abc")` is NaN, and every comparison with NaN is false, so a naive
  // `if (Math.abs(now - ts) > window)` guard would ACCEPT it.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "stale_timestamp" };
  if (Math.abs(nowSeconds - ts) > SLACK_TIMESTAMP_WINDOW_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  // timingSafeEqual throws on a length mismatch, so compare lengths first - a wrong-length
  // signature is a wrong signature either way.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

/**
 * Is this Slack's one-time URL handshake?
 *
 * Slack POSTs `{"type":"url_verification","challenge":"…"}` and expects the challenge echoed
 * back. It fires when the app is CREATED from the manifest - before any install, and before we
 * could know the app's signing secret - so this is the one request we must answer WITHOUT a
 * verified signature.
 *
 * That exemption is the sharpest edge in this feature, so it is deliberately narrow:
 *
 *  - `type` must be exactly `url_verification`, and
 *  - `challenge` must be a non-empty string, and
 *  - the body must carry NO `event` field.
 *
 * The last clause is the one that matters. Without it, a body claiming
 * `{"type":"url_verification","challenge":"x","event":{…}}` would take the unverified path;
 * if a caller later reordered the route's checks, that shape could reach the invoke path with
 * no signature at all. Refusing to classify such a body as a handshake means it falls through
 * to signature verification and is rejected. Echoing a challenge is safe (the reply contains
 * only what the caller sent, and it starts no work); starting a run is not.
 */
export function isUrlVerification(body: unknown): body is { type: "url_verification"; challenge: string } {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    b.type === "url_verification" &&
    typeof b.challenge === "string" &&
    b.challenge.length > 0 &&
    !("event" in b)
  );
}
