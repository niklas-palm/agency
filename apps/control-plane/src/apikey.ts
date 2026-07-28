/**
 * Per-agent API keys. A key authorizes invoking exactly one agent. We store only
 * a SHA-256 hash (never the plaintext), return the plaintext exactly once at
 * create/rotate time, and compare with a timing-safe equal on invoke.
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
