/**
 * Scheduled discovery-refresh sweep. A daily EventBridge rule invokes this Lambda
 * with no payload; it scans every discovery-backed integration (across all owners)
 * and re-fetches each one's spec, reconciling against the stored selection - so a
 * downstream API that gains or loses operations stays in sync WITHOUT auto-granting
 * the agent new capabilities (a newly-appeared op defaults OFF; see reconcile).
 *
 * Best-effort + isolated per integration: one integration's fetch failure (its spec
 * host is down, say) is logged and skipped, never aborting the sweep. A user can also
 * refresh on demand via `POST /integrations/:id/refresh` (same primitive).
 */
import { scanDiscoveryIntegrations, updateDiscoveryResult } from "./repo/integrations.js";
import { refreshDiscovery, credentialForSpec } from "./discover-operations.js";

export async function handler(): Promise<void> {
  const integrations = await scanDiscoveryIntegrations();
  let refreshed = 0;
  let failed = 0;
  // Edited by the user mid-sweep (spec URL changed, or switched to manual), so our
  // result describes an upstream they no longer asked for and was dropped.
  let superseded = 0;
  for (const record of integrations) {
    // Read the spec URL ONCE, before the fetch: it's what we're about to fetch and
    // what the write conditions on. Re-reading it after would defeat the condition,
    // since `record` is just our snapshot of a row the user may have edited since.
    const specUrl = record.discovery!.url;
    // Anchor the credential to baseUrl: never send the write-only secret to a stored
    // discovery.url that sits off the record's base origin (same guard as the routes).
    const synced = await refreshDiscovery(
      record.discovery!,
      new Date().toISOString(),
      credentialForSpec(specUrl, record.baseUrl, record.auth, record.secret),
    ).catch((e) => {
      console.error("discovery refresh threw", record.orgId, record.id, e);
      return { error: "unexpected error" } as const;
    });
    if ("error" in synced) {
      failed++;
      console.warn("discovery refresh failed", { orgId: record.orgId, id: record.id, error: synced.error });
      continue;
    }
    // Update only the discovery-owned fields, conditioned on the spec URL still
    // being the one we fetched: the fetch above is slow, and a user PATCH landing
    // meanwhile must not be reverted by a write built from our stale read.
    const landed = await updateDiscoveryResult(record.orgId, record.id, specUrl, {
      operations: synced.operations,
      discovery: synced.discovery,
      updatedAt: synced.discovery.syncedAt,
    }).catch((e) => {
      console.error("discovery refresh put failed", record.id, e);
      return false;
    });
    if (landed) refreshed++;
    else superseded++;
  }
  console.log("discovery sweep complete", { total: integrations.length, refreshed, failed, superseded });
}
