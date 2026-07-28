/**
 * Agents table access. One item per agent, keyed by `id`. Stores the creator
 * config, the API-key hash (never plaintext), the owner, and operational
 * counters. The stored shape is internal; the API maps it to the public `Agent`
 * wire type (which omits the key hash) in routes.
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Agent, AgentConfig, AgentMetrics } from "@agency/shared";
import { ddb } from "../ddb.js";
import { AGENTS_TABLE } from "../config.js";

export interface AgentRecord {
  id: string;
  /** The org this agent lives in (partition of the byOrg GSI). */
  orgId: string;
  /** userId of the creator - attribution + the shared/private visibility rule. */
  createdBy: string;
  /** true = visible to the whole org; false = visible only to its creator. */
  shared: boolean;
  /** Extra org members (userIds) who may manage this agent, beyond creator + admins. */
  managers?: string[];
  config: AgentConfig;
  /** Non-versioned human description shown on the roster (metadata, not behavior). */
  description?: string;
  /** Current config version (starts at 1, bumped on every config change). */
  version: number;
  invokeUrl: string;
  /** SHA-256 hash of the API key, for the timing-safe verify on invoke/poll. */
  apiKeyHash: string;
  createdAt: string;
  updatedAt: string;
  metrics: AgentMetrics;
  /**
   * The Slack app's secrets, when the agent has a Slack trigger. WRITE-ONLY: never
   * returned by a read route (`toPublic` strips them), exactly like an integration's
   * `secret`. Kept on the agent record rather than in a side table because their
   * lifetime IS the trigger's - deleting the agent deletes them, with no orphan to reap.
   *
   * `signingSecret` verifies inbound webhooks; `botToken` authorizes our outbound calls to
   * Slack. Neither ever reaches the runtime: replies go through the control-plane, so a
   * compromised microVM has no Slack credential to steal.
   */
  slackSecrets?: {
    signingSecret?: string;
    botToken?: string;
  };
}

const ZERO_METRICS: AgentMetrics = {
  invocations: 0,
  lastInvokedAt: null,
};

/**
 * Return a config in the current shape, up-migrating any legacy record that
 * predates typed triggers: an old `config.trigger: "api" | "schedule"` string
 * becomes `config.triggers`. Pure - returns a fresh object and never mutates the
 * input (so it's safe to use both for the response and when building a PATCH
 * merge). Read-time migration keeps old items readable without a backfill; a
 * PATCH persists the migrated shape (and drops the dead `trigger` key).
 */
export function normalizeConfig(config: AgentConfig): AgentConfig {
  const c = { ...(config as AgentConfig & { trigger?: string }) };
  if (!Array.isArray(c.triggers)) {
    // Legacy: only ever "api" was actually provisioned, so map to [api].
    c.triggers = [{ type: "api" }];
  }
  delete c.trigger; // drop the dead legacy key if present
  // Canonicalize empty skillIds/integrationIds/env to absent so an edit that sends
  // `skillIds:[]` / `integrationIds:[]` / `env:{}` (the UI always sends them) diffs
  // equal to a config that never had them - otherwise a description-only edit would
  // mint a spurious version.
  if (c.skillIds && c.skillIds.length === 0) delete c.skillIds;
  if (c.integrationIds && c.integrationIds.length === 0) delete c.integrationIds;
  if (c.env && Object.keys(c.env).length === 0) delete c.env;
  // networkMode: "public" is the default - drop it so it diffs equal to a legacy
  // record that predates the field. In "isolated" mode there's no public egress,
  // so web tools can't work: force webSearch + networkAccess off. Doing it here
  // (the one canonical shaper) keeps the invariant true on read, response, and
  // version-diff, so the runtime always sees a coherent config.
  if (c.networkMode === "isolated") {
    c.webSearch = false;
    c.networkAccess = false;
  } else {
    delete c.networkMode;
  }
  return c;
}

/**
 * Strip internal fields and normalize the config to produce the public wire type.
 *
 * The key hash is dropped, and the plaintext key isn't here to drop: it's returned
 * exactly once at create/rotate and never stored. So the agents table holds no usable
 * credential - a table read (a PITR export, an over-broad grant) yields hashes only.
 */
export function toPublic(r: AgentRecord): Agent {
  // Both stripped fields are credentials that must never reach a read response: the API key
  // hash, and the Slack signing secret + bot token. Anything added to AgentRecord that is
  // write-only belongs in this destructure.
  const { apiKeyHash: _drop, slackSecrets: _slack, ...pub } = r;
  // Legacy records predate versioning; treat them as version 1.
  return { ...pub, version: pub.version ?? 1, config: normalizeConfig(pub.config) };
}

export async function putAgent(record: AgentRecord): Promise<void> {
  await ddb.send(new PutCommand({ TableName: AGENTS_TABLE, Item: record }));
}

export async function getAgent(id: string): Promise<AgentRecord | null> {
  const res = await ddb.send(new GetCommand({ TableName: AGENTS_TABLE, Key: { id } }));
  return (res.Item as AgentRecord | undefined) ?? null;
}

/**
 * List an org's agents. Uses the byOrg GSI. Visibility (shared/private) is
 * filtered in the handler, not here.
 *
 * Pages to exhaustion (like listSkills/listIntegrations): a single Query caps at
 * 1 MB, and an agent record carries a full config + system prompt, so a large org
 * would otherwise get a SILENTLY truncated roster - and callers that reconcile
 * against this list (or count skill/integration usage from it) would act on a
 * partial view.
 */
export async function listAgentsByOrg(orgId: string): Promise<AgentRecord[]> {
  const out: AgentRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: AGENTS_TABLE,
        IndexName: "byOrg",
        KeyConditionExpression: "orgId = :o",
        ExpressionAttributeValues: { ":o": orgId },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const it of res.Items ?? []) out.push(it as AgentRecord);
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return out;
}

/**
 * Patch config, version, and/or the API-key hash. Bumps updatedAt. A config
 * change passes the new `version` too (the route appends the config to the
 * version history and bumps the agent's current version in lock-step).
 */
export async function updateAgent(
  id: string,
  patch: {
    config?: AgentConfig;
    version?: number;
    apiKeyHash?: string;
    /** String to set the description; `null` to clear it (remove the attribute). */
    description?: string | null;
    shared?: boolean;
    /** Array to set the manager list; `null` to clear it (remove the attribute). */
    managers?: string[] | null;
    /**
     * The Slack app's credentials. An object SETs both; `null` REMOVEs the attribute (used
     * when the Slack trigger is disconnected, so no orphaned credential is left behind).
     */
    slackSecrets?: { signingSecret: string; botToken: string } | null;
    /**
     * Compare-and-swap guard: only apply if the stored `version` still equals this.
     * The version bump reads-then-writes, so without it two concurrent PATCHes both
     * advance to the same number and the last writer's config wins while the version
     * history records the other - i.e. the agent's live config stops matching its own
     * snapshot. Throws ConditionalCheckFailedException on a race so the caller retries.
     */
    expectedVersion?: number;
  },
): Promise<void> {
  const sets: string[] = ["updatedAt = :u"];
  const removes: string[] = [];
  const values: Record<string, unknown> = { ":u": new Date().toISOString() };
  if (patch.config) {
    sets.push("config = :c");
    values[":c"] = patch.config;
  }
  // description: a string SETs it; null REMOVEs it (mirrors managers below). Without
  // the null case an emptied description is indistinguishable from "not sent", so a
  // user could never clear one once set.
  if (patch.description === null) {
    removes.push("description");
  } else if (patch.description !== undefined) {
    sets.push("description = :d");
    values[":d"] = patch.description;
  }
  if (patch.shared !== undefined) {
    sets.push("shared = :sh");
    values[":sh"] = patch.shared;
  }
  // managers: an array SETs it; null REMOVEs the attribute (back to creator+admins).
  if (patch.managers != null) {
    sets.push("managers = :mg");
    values[":mg"] = patch.managers;
  } else if (patch.managers === null) {
    removes.push("managers");
  }
  // slackSecrets: an object SETs it; null REMOVEs it, so disconnecting Slack doesn't leave a
  // usable bot token on the record.
  if (patch.slackSecrets === null) {
    removes.push("slackSecrets");
  } else if (patch.slackSecrets !== undefined) {
    sets.push("slackSecrets = :ss");
    values[":ss"] = patch.slackSecrets;
  }
  if (patch.version !== undefined) {
    sets.push("version = :v");
    values[":v"] = patch.version;
  }
  if (patch.apiKeyHash) {
    sets.push("apiKeyHash = :k");
    values[":k"] = patch.apiKeyHash;
  }
  const expr = `SET ${sets.join(", ")}` + (removes.length ? ` REMOVE ${removes.join(", ")}` : "");
  if (patch.expectedVersion !== undefined) values[":expected"] = patch.expectedVersion;
  await ddb.send(
    new UpdateCommand({
      TableName: AGENTS_TABLE,
      Key: { id },
      UpdateExpression: expr,
      ExpressionAttributeValues: values,
      // `attribute_not_exists(version)` covers legacy records that predate versioning
      // (treated as v1 by toPublic), so a first bump on one still succeeds.
      ...(patch.expectedVersion !== undefined
        ? { ConditionExpression: "version = :expected OR attribute_not_exists(version)" }
        : {}),
    }),
  );
}

export async function deleteAgent(id: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: AGENTS_TABLE, Key: { id } }));
}

export function freshMetrics(): AgentMetrics {
  return { ...ZERO_METRICS };
}
