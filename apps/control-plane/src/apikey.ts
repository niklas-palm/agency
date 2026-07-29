/**
 * Per-agent API keys. A key authorizes invoking exactly one agent, and nothing else - it cannot
 * read config, list agents, or reach another agent.
 *
 * The stored hash is what invoke VERIFIES against, with a timing-safe compare. The plaintext is
 * ALSO stored on the agent record, deliberately: the Run and Integrate tabs prefill it, which has
 * to survive a sign-out and a cleared cache, and no client-side store can do that. So the hash here
 * is not a secrecy boundary against someone who can already read the record - it is only what stops
 * a *presented* key being compared in variable time. Who may read the plaintext back is decided by
 * `canWrite` on the agent (see Agent.apiKey + docs/auth.md); a viewer never sees it.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const PREFIX = "ag_"; // Agency

/** Generate a new API key (plaintext) and its stored hash. */
export function generateApiKey(): { apiKey: string; hash: string } {
  const apiKey = PREFIX + randomBytes(24).toString("base64url");
  return { apiKey, hash: hashApiKey(apiKey) };
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** Timing-safe comparison of a presented key against a stored hash. */
export function verifyApiKey(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashApiKey(presented));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}
