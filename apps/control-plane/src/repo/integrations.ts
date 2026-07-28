/**
 * Integrations table access. An integration is org-scoped and reusable across
 * the org's agents (mirrors skills.ts). Keyed (orgId, integrationId) so
 * listing a user's integrations is a cheap partition query and every read is
 * naturally tenant-isolated (a bare integration id never resolves cross-tenant).
 *
 * The stored record carries the downstream `secret` (the credential). It is
 * NEVER returned to a client or the runtime: `toPublicIntegration` strips it. Only
 * the platform reads it via `credentialHeaders` (integration-proxy.ts) - the proxy
 * to inject it into the forwarded request, and discovery to authenticate the spec
 * fetch (an API often gates its own OpenAPI doc behind the same credential).
 * Agents reference integrations by id; the manifest is resolved at invoke, the
 * credential only at proxy-call time.
 */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Integration } from "@agency/shared";
import { ddb } from "../ddb.js";
import { INTEGRATIONS_TABLE } from "../config.js";

/**
 * The stored shape: the public integration (which carries orgId/createdBy/shared/id)
 * plus the write-only credential. The `secret` is optional (auth.kind "none" needs
 * none, and it can be left unset).
 */
export interface IntegrationRecord extends Integration {
  /** The downstream credential (bearer token / api-key value). Never returned. */
  secret?: string;
}

/** Strip the credential (and mark whether one is set) for any client-facing read. */
export function toPublicIntegration(r: IntegrationRecord): Integration {
  const { secret, ...rest } = r;
  return { ...rest, hasSecret: Boolean(secret) };
}

export async function putIntegration(record: IntegrationRecord): Promise<void> {
  await ddb.send(new PutCommand({ TableName: INTEGRATIONS_TABLE, Item: record }));
}

/**
 * Persist a discovery refresh by updating ONLY the three fields it owns
 * (`operations`, `discovery`, `updatedAt`).
 *
 * Deliberately not a whole-item Put. A refresh reads the record, then makes a slow
 * network call to fetch the spec, then writes - so a user's PATCH landing in that
 * window would be silently reverted by a Put built from the stale read, taking
 * `secret`, `shared`, `managers`, and `baseUrl` back with it. An UpdateItem can't
 * clobber fields it doesn't name.
 *
 * The condition closes the other half: if the PATCH switched this integration to a
 * different spec URL (or to manual authoring, dropping `discovery` entirely), this
 * refresh describes an upstream the user no longer asked for, so it must not land.
 * Returns false in that case (the caller treats it as "superseded", not an error).
 */
export async function updateDiscoveryResult(
  orgId: string,
  id: string,
  expectedUrl: string,
  next: { operations: Integration["operations"]; discovery: NonNullable<Integration["discovery"]>; updatedAt: string },
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: INTEGRATIONS_TABLE,
        Key: { orgId, id },
        UpdateExpression: "SET operations = :ops, discovery = :disc, updatedAt = :u",
        ConditionExpression: "discovery.#url = :expectedUrl",
        ExpressionAttributeNames: { "#url": "url" },
        ExpressionAttributeValues: {
          ":ops": next.operations,
          ":disc": next.discovery,
          ":u": next.updatedAt,
          ":expectedUrl": expectedUrl,
        },
      }),
    );
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/** Get one integration, scoped to its org (null cross-tenant or missing). */
export async function getIntegration(orgId: string, id: string): Promise<IntegrationRecord | null> {
  const res = await ddb.send(new GetCommand({ TableName: INTEGRATIONS_TABLE, Key: { orgId, id } }));
  return (res.Item as IntegrationRecord | undefined) ?? null;
}

/** List an org's integrations (partition query). */
export async function listIntegrations(orgId: string): Promise<IntegrationRecord[]> {
  const out: IntegrationRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: INTEGRATIONS_TABLE,
        KeyConditionExpression: "orgId = :o",
        ExpressionAttributeValues: { ":o": orgId },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const it of res.Items ?? []) out.push(it as IntegrationRecord);
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return out;
}

/** Resolve a set of the org's integrations by id, preserving the input order. */
export async function getIntegrationsByIds(orgId: string, ids: string[]): Promise<IntegrationRecord[]> {
  if (ids.length === 0) return [];
  // Small N (bounded by MAX_INTEGRATIONS); a per-id Get keeps it org-scoped and simple.
  const found = await Promise.all(ids.map((id) => getIntegration(orgId, id)));
  return found.filter((r): r is IntegrationRecord => r !== null);
}

export async function deleteIntegration(orgId: string, id: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: INTEGRATIONS_TABLE, Key: { orgId, id } }));
}

/**
 * Scan every integration that has a discovery URL, across all owners - the input to
 * the scheduled refresh sweep. A cross-tenant Scan (not a per-owner Query) because
 * the sweep is a platform job, not a user request; the FilterExpression keeps only
 * discovery-backed records so manual ones aren't fetched. Integrations are low-count,
 * so a full scan is cheap and simple (revisit with a GSI if the table grows large).
 */
export async function scanDiscoveryIntegrations(): Promise<IntegrationRecord[]> {
  const out: IntegrationRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: INTEGRATIONS_TABLE,
        FilterExpression: "attribute_exists(discovery)",
        ExclusiveStartKey: startKey,
      }),
    );
    for (const it of res.Items ?? []) out.push(it as IntegrationRecord);
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return out;
}
