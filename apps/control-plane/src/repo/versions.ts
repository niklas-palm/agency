/**
 * Agent config version history. Append-only: one item per config snapshot, keyed
 * by (agentId, version). The agent item holds the CURRENT config + version (so
 * the invoke path is unchanged); this table is the archive so a prior config can
 * be inspected or restored. Ownership is enforced at the route (the agent record
 * is org-checked (canView) before any version read), so items carry no ownerId.
 */
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { AgentVersion } from "@agency/shared";
import { ddb } from "../ddb.js";
import { VERSIONS_TABLE } from "../config.js";

/** Append a config snapshot. Idempotent per (agentId, version) via the PK. */
/**
 * Append a version snapshot. CLAIMS the (agentId, version) slot: the condition
 * makes a concurrent second writer of the SAME version number fail instead of
 * overwriting - two PATCHes that both read version=5 and both compute 6 would
 * otherwise silently drop one config from history (and leave the agent's live
 * config disagreeing with the v6 snapshot). The caller re-reads and retries on
 * ConditionalCheckFailedException.
 *
 * Note this is a genuine claim, not just retry-idempotency: a retry of the *same*
 * write is the one case it rejects harmlessly, which the caller treats as "someone
 * else took this number" and recomputes - the same safe outcome.
 */
export async function putVersion(v: AgentVersion): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: VERSIONS_TABLE,
      Item: v,
      ConditionExpression: "attribute_not_exists(agentId) AND attribute_not_exists(version)",
    }),
  );
}

/**
 * The highest version number that exists in HISTORY, or 0 if there is none.
 *
 * The agent record's `version` and this can diverge: `putVersion` may succeed and the
 * following `updateAgent` fail non-conditionally (throttling, timeout), leaving an
 * orphaned row at a version the agent doesn't point at. Computing the next version from
 * the agent alone would then re-claim the same taken slot forever, and every config edit
 * would 503 with no way to recover - so the bump reconciles against this too.
 */
export async function highestVersion(agentId: string): Promise<number> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: VERSIONS_TABLE,
      KeyConditionExpression: "agentId = :a",
      ExpressionAttributeValues: { ":a": agentId },
      ScanIndexForward: false, // highest version first
      Limit: 1,
      ProjectionExpression: "version",
    }),
  );
  return ((res.Items ?? [])[0] as { version?: number } | undefined)?.version ?? 0;
}

/**
 * List an agent's versions, newest first. Pages to exhaustion: the history is
 * append-only and unbounded (every config edit adds a full config snapshot), so a
 * single 1 MB Query would silently drop the OLDEST versions from a long-lived
 * agent's history - which a restore-from-v1 would then be unable to find.
 */
export async function listVersions(agentId: string): Promise<AgentVersion[]> {
  const out: AgentVersion[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: VERSIONS_TABLE,
        KeyConditionExpression: "agentId = :a",
        ExpressionAttributeValues: { ":a": agentId },
        ScanIndexForward: false, // highest version first
        ExclusiveStartKey: startKey,
      }),
    );
    for (const it of res.Items ?? []) out.push(it as AgentVersion);
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return out;
}
