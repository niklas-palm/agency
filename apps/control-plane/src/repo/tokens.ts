/**
 * Access-tokens table. One item per Personal Access Token, keyed by the token's
 * SHA-256 hash - so authenticating a presented token is a single O(1) GetItem on
 * the hash (the hash IS the key, so there's no timing-attack surface: an attacker
 * can't brute-force a SHA-256 preimage). A `byOwner` GSI backs list/revoke in the
 * UI. We never store the plaintext.
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { AccessToken, Scope } from "@agency/shared";
import { ddb } from "../ddb.js";
import { TOKENS_TABLE } from "../config.js";

export interface TokenRecord {
  /** SHA-256 hash of the plaintext token - the partition key. */
  tokenHash: string;
  /** Public id (safe to show; distinct from the hash). Used for revoke-by-id. */
  id: string;
  /** userId of the owner (a PAT belongs to a person). The byOwner GSI keys on this. */
  ownerId: string;
  /** The org this token acts within (chosen at mint). Effective authority =
   *  token scopes ∩ the owner's role in this org (resolved in auth.ts). */
  orgId: string;
  name: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt: string | null;
}

/** Strip the hash (the secret-equivalent lookup key) to produce the wire type. */
export function toPublicToken(r: TokenRecord): AccessToken {
  const { tokenHash: _drop, ...pub } = r;
  return pub;
}

export async function putToken(record: TokenRecord): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TOKENS_TABLE, Item: record }));
}

/** Look up a token by its hash (the auth path). Null if unknown/revoked. */
export async function getTokenByHash(tokenHash: string): Promise<TokenRecord | null> {
  const res = await ddb.send(new GetCommand({ TableName: TOKENS_TABLE, Key: { tokenHash } }));
  return (res.Item as TokenRecord | undefined) ?? null;
}

/** List a user's tokens (for the Settings page). Uses the byOwner GSI. */
export async function listTokensByOwner(ownerId: string): Promise<TokenRecord[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TOKENS_TABLE,
      IndexName: "byOwner",
      KeyConditionExpression: "ownerId = :o",
      ExpressionAttributeValues: { ":o": ownerId },
    }),
  );
  return (res.Items as TokenRecord[] | undefined) ?? [];
}

/**
 * Delete a token by public id, but only if it belongs to `ownerId` - so a user
 * can't revoke another user's token. Returns true if a token was deleted. The id
 * isn't the table key, so we resolve via the byOwner GSI first.
 */
export async function deleteTokenById(ownerId: string, id: string): Promise<boolean> {
  const owned = await listTokensByOwner(ownerId);
  const match = owned.find((t) => t.id === id);
  if (!match) return false;
  await ddb.send(new DeleteCommand({ TableName: TOKENS_TABLE, Key: { tokenHash: match.tokenHash } }));
  return true;
}

/**
 * Record that a token was just used. Best-effort "last used" telemetry for the
 * UI - callers ignore failures so a telemetry write never fails an auth'd
 * request.
 */
export async function touchToken(tokenHash: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TOKENS_TABLE,
      Key: { tokenHash },
      UpdateExpression: "SET lastUsedAt = :t",
      // Only ever update a live token. UpdateItem is an upsert, so without this a
      // touch racing a concurrent revoke would recreate the just-deleted item as
      // a scope-less ghost (un-revokable, invisible to byOwner). The
      // ConditionalCheckFailedException is swallowed by the caller's .catch().
      ConditionExpression: "attribute_exists(tokenHash)",
      ExpressionAttributeValues: { ":t": new Date().toISOString() },
    }),
  );
}
