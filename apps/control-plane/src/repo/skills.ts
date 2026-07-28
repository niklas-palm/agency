/**
 * Skills table access. A skill is org-scoped and reusable across the org's
 * agents. Keyed (orgId, skillId) so listing an org's skills is a cheap partition
 * query and a bare skill id never resolves cross-org. Within the org, the
 * per-resource visibility rule (shared || createdBy===caller) is applied by the
 * handler, not here. Agents reference skills by id; content is resolved at invoke.
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Skill } from "@agency/shared";
import { ensureSkillFrontmatter } from "@agency/shared";
import { ddb } from "../ddb.js";
import { SKILLS_TABLE } from "../config.js";

/** The stored shape IS the Skill wire type (orgId/createdBy/shared/id all live on it). */
export type SkillRecord = Skill;

/**
 * Read-time up-migration: reconstruct SKILL.md frontmatter from the stored
 * name/description for legacy skills whose `content` is body-only (created before
 * the single-document format). A no-op for skills already carrying frontmatter,
 * so the returned `content` is always a complete, editable SKILL.md.
 */
function normalizeSkill(r: SkillRecord): SkillRecord {
  return { ...r, content: ensureSkillFrontmatter(r.content, r.name, r.description) };
}

export async function putSkill(record: SkillRecord): Promise<void> {
  await ddb.send(new PutCommand({ TableName: SKILLS_TABLE, Item: record }));
}

/** Get one skill, scoped to its org (returns null cross-tenant or missing). */
export async function getSkill(orgId: string, id: string): Promise<SkillRecord | null> {
  const res = await ddb.send(new GetCommand({ TableName: SKILLS_TABLE, Key: { orgId, id } }));
  const item = res.Item as SkillRecord | undefined;
  return item ? normalizeSkill(item) : null;
}

/** List an org's skills (partition query). */
export async function listSkills(orgId: string): Promise<SkillRecord[]> {
  const out: SkillRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: SKILLS_TABLE,
        KeyConditionExpression: "orgId = :o",
        ExpressionAttributeValues: { ":o": orgId },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const it of res.Items ?? []) out.push(normalizeSkill(it as SkillRecord));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return out;
}

/** Resolve a set of the org's skills by id, preserving the input order. */
export async function getSkillsByIds(orgId: string, ids: string[]): Promise<SkillRecord[]> {
  if (ids.length === 0) return [];
  // Small N (bounded by MAX_SKILLS); a per-id Get keeps it org-scoped and simple.
  const found = await Promise.all(ids.map((id) => getSkill(orgId, id)));
  return found.filter((s): s is SkillRecord => s !== null);
}

export async function deleteSkill(orgId: string, id: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: SKILLS_TABLE, Key: { orgId, id } }));
}
