/**
 * Memberships table access (pk=orgId, sk=userId; GSI byUser). This is the
 * AUTHORITY SOURCE: `getMembership(orgId, userId)` yields the role that gates
 * every request in that org, and the `byUser` GSI answers "which orgs am I in"
 * for the org switcher. See docs/auth.md + docs/org-model.md.
 */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Membership, Role } from "@agency/shared";
import { ddb } from "../ddb.js";
import { MEMBERSHIPS_TABLE } from "../config.js";

export async function putMembership(m: Membership): Promise<void> {
  await ddb.send(new PutCommand({ TableName: MEMBERSHIPS_TABLE, Item: m }));
}

/**
 * Change an existing member's role. Conditional on the row still being there, so a
 * concurrent removal wins.
 *
 * Not a whole-item Put: reading the row, then writing it back, is a read-modify-write,
 * and a DELETE landing in between would be UNDONE by the write - resurrecting a removed
 * member at the role being set (a promotion would restore them as an admin, and their
 * PATs bound to this org would start authenticating again). Same reasoning as
 * `setMembershipEmail`'s guard, on the field that actually carries authority.
 *
 * Returns false when the membership is gone (the caller reports "not a member").
 */
export async function updateMembershipRole(orgId: string, userId: string, role: Role): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: MEMBERSHIPS_TABLE,
        Key: { orgId, userId },
        UpdateExpression: "SET #r = :role",
        ExpressionAttributeNames: { "#r": "role" },
        ExpressionAttributeValues: { ":role": role },
        ConditionExpression: "attribute_exists(userId)",
      }),
    );
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/**
 * Cache a member's resolved email on their row, touching ONLY that field.
 *
 * Deliberately not a whole-item Put. The roster resolves a missing email over a slow
 * network call, so a write built from the row it read BEFORE that call would revert
 * anything an admin changed meanwhile - and worse, recreate a membership that a
 * concurrent DELETE had just removed, restoring the removed member's access. This is
 * the AUTHORITY SOURCE table: `role` gates every request, and removal is promised to
 * be immediate (docs/auth.md), so a cosmetic label must never write it.
 *
 * `attribute_exists(userId)` means a deleted row stays deleted;
 * `attribute_not_exists(email)` means the member's own self-heal (which has their
 * verified claim, so it's more authoritative) wins over ours. A failed condition is
 * the expected outcome in both races, so it resolves quietly.
 */
export async function backfillMembershipEmail(orgId: string, userId: string, email: string): Promise<void> {
  await setMembershipEmail(orgId, userId, email, "onlyIfAbsent");
}

/**
 * Write a member's email, touching ONLY that field on a row that still exists.
 *
 * `when` picks the guard:
 * - `"onlyIfAbsent"` (the roster backfill): don't overwrite an email the member's own
 *   self-heal already wrote - that one carries their verified token claim, so it's the
 *   more authoritative source.
 * - `"always"` (the self-heal itself): DO correct a stale value, which is the whole
 *   point of that path.
 *
 * Both keep `attribute_exists(userId)`, so neither can recreate a membership a
 * concurrent DELETE removed - the failure mode that would restore a removed member's
 * access. A lost condition is the expected outcome in those races, so it's quiet.
 */
export async function setMembershipEmail(
  orgId: string,
  userId: string,
  email: string,
  when: "always" | "onlyIfAbsent",
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: MEMBERSHIPS_TABLE,
        Key: { orgId, userId },
        UpdateExpression: "SET email = :e",
        ConditionExpression:
          when === "onlyIfAbsent"
            ? "attribute_exists(userId) AND attribute_not_exists(email)"
            : "attribute_exists(userId)",
        ExpressionAttributeValues: { ":e": email },
      }),
    );
  } catch (e) {
    if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
  }
}

/** The role-resolving lookup on the request hot path (management routes). Null =
 *  the user is not a member of this org. */
export async function getMembership(orgId: string, userId: string): Promise<Membership | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: MEMBERSHIPS_TABLE, Key: { orgId, userId } }),
  );
  return (res.Item as Membership | undefined) ?? null;
}

/**
 * Every member of an org (for the members list + admin management).
 *
 * Pages to exhaustion: this list is LOAD-BEARING for two invariants - countAdmins
 * (the last-admin guard) and the already-a-member check on invite creation. A
 * silently truncated page would under-count admins (letting the last one be
 * demoted/removed) or miss an existing member, so it must be complete, not just
 * the first 1 MB.
 */
export async function listMembersByOrg(orgId: string): Promise<Membership[]> {
  const out: Membership[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: MEMBERSHIPS_TABLE,
        KeyConditionExpression: "orgId = :o",
        ExpressionAttributeValues: { ":o": orgId },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const it of res.Items ?? []) out.push(it as Membership);
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return out;
}

/** Every org a user belongs to (the org switcher). Uses the byUser GSI. */
export async function listMembershipsByUser(userId: string): Promise<Membership[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: MEMBERSHIPS_TABLE,
      IndexName: "byUser",
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": userId },
    }),
  );
  return (res.Items as Membership[] | undefined) ?? [];
}

export async function deleteMembership(orgId: string, userId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: MEMBERSHIPS_TABLE, Key: { orgId, userId } }));
}

/**
 * Demote or remove an admin ONLY IF another named admin is still an admin at write
 * time - the last-admin invariant, enforced atomically.
 *
 * A plain count-then-write can't hold the invariant: two concurrent requests
 * demoting two DIFFERENT admins of a 2-admin org both count 2, both pass the
 * check, and the org ends up with zero admins - unrecoverable through the API
 * (every route that could fix it requires an admin). So the caller picks a
 * `witness`: another member it just observed to be an admin. The transaction
 * applies the change only while that witness's role is still exactly "admin", so
 * the concurrent request that demoted the witness makes this one fail
 * (TransactionCanceledException) instead of jointly emptying the org.
 *
 * `change` is the write to apply to the target: "delete" (remove) or a new role.
 */
export async function demoteAdminIfWitnessRemains(
  orgId: string,
  target: Membership,
  change: "delete" | Membership,
  witnessUserId: string,
): Promise<void> {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: MEMBERSHIPS_TABLE,
            Key: { orgId, userId: witnessUserId },
            ConditionExpression: "#r = :admin",
            ExpressionAttributeNames: { "#r": "role" },
            ExpressionAttributeValues: { ":admin": "admin" },
          },
        },
        change === "delete"
          ? { Delete: { TableName: MEMBERSHIPS_TABLE, Key: { orgId, userId: target.userId } } }
          : {
              Put: {
                TableName: MEMBERSHIPS_TABLE,
                Item: change,
                // The target must still exist. Without this, a Put racing a concurrent
                // DELETE re-creates the row - resurrecting a removed member, at the
                // role being written (so a promotion resurrects them as an admin).
                ConditionExpression: "attribute_exists(userId)",
              },
            },
      ],
    }),
  );
}
