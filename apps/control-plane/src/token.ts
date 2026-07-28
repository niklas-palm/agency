/**
 * Personal Access Tokens (PATs). A PAT authorizes the management API on behalf
 * of the user who minted it, scoped to a chosen set of permissions. Like agent
 * API keys, we store only a SHA-256 hash and return the plaintext once. There is no
 * comparison to make timing-safe: the tokens table is KEYED by the hash, so auth is a
 * single GetItem on a value derived from the presented secret. The `agpat_` prefix
 * distinguishes a PAT
 * (`Authorization: Bearer agpat_…`) from an agent key (`ag_…`) on the wire.
 */
import { randomBytes, createHash } from "node:crypto";

const PREFIX = "agpat_"; // Agency Personal Access Token

/** True if a bearer value looks like a PAT (vs a JWT or an agent key). */
export function isAccessToken(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Generate a new PAT (plaintext) and its stored hash. */
export function generateAccessToken(): { token: string; hash: string } {
  const token = PREFIX + randomBytes(24).toString("base64url");
  return { token, hash: hashAccessToken(token) };
}

/** The lookup key for a token: its SHA-256 hash (hex). */
export function hashAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
