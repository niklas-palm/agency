/**
 * Resolving an agent's attached skills + integrations into the invoke payload.
 *
 * Shared by BOTH invoke paths - the API route and the schedule trigger Lambda - so
 * a scheduled run gets exactly what an API run gets. They used to carry separate
 * inline copies, which is how they drifted.
 *
 * Two failure modes, deliberately treated differently:
 * - An id that's been deleted, or is no longer visible to the agent's creator
 *   (`visibleToCreator` - un-shared since attach), silently drops out. That's real
 *   state, and degrading gracefully is the intent.
 * - A read FAILURE propagates. Resolving to nothing would run the agent with its
 *   instructions or its only means of calling a downstream API missing, and report
 *   success - the model improvises without the knowledge it was configured to have.
 *   A retryable error (503 on the API path; a failed tick EventBridge retries on the
 *   schedule path) is the honest outcome.
 */
import type { ResolvedIntegration, ResolvedSkill } from "@agency/shared";
import { getSkillsByIds } from "./repo/skills.js";
import { getIntegrationsByIds } from "./repo/integrations.js";
import { visibleToCreator } from "./authz.js";

/** Resolve attached skill ids to the payload shape (name + description + content). */
export async function resolveSkills(
  orgId: string,
  agentCreatedBy: string,
  skillIds: string[] | undefined,
): Promise<ResolvedSkill[]> {
  if (!skillIds || skillIds.length === 0) return [];
  const records = await getSkillsByIds(orgId, skillIds);
  return records
    .filter((s) => visibleToCreator(s, agentCreatedBy))
    .map((s) => ({ name: s.name, description: s.description, content: s.content }));
}

/**
 * Resolve attached integration ids to the payload shape: metadata + operation
 * manifest, NEVER the secret or baseUrl. Also returns the resolved (visible) ids,
 * so the caller mints a session-token grant matching what the agent can really see.
 */
export async function resolveIntegrations(
  orgId: string,
  agentCreatedBy: string,
  integrationIds: string[] | undefined,
): Promise<{ manifests: ResolvedIntegration[]; grantedIds: string[] }> {
  if (!integrationIds || integrationIds.length === 0) return { manifests: [], grantedIds: [] };
  const records = (await getIntegrationsByIds(orgId, integrationIds)).filter((i) =>
    visibleToCreator(i, agentCreatedBy),
  );
  return {
    manifests: records.map((i) => ({ id: i.id, name: i.name, description: i.description, operations: i.operations })),
    grantedIds: records.map((i) => i.id),
  };
}
