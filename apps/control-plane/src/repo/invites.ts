/**
 * Invites table access (pk=email lowercased, sk=orgId; GSI byOrg). An invite is
 * tied to an EMAIL (not a user id), so it works whether or not the invitee already
 * has an account - matched against the JWT email on accept. The email PK is the
 * invitee's hot lookup ("my pending invites"); the byOrg GSI is the admin's
 * "pending invites in my org". Deleted on accept/decline/rescind.
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Invite } from "@agency/shared";
import { ddb } from "../ddb.js";
import { INVITES_TABLE } from "../config.js";

/** Normalize an email for the key (case-insensitive matching). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function putInvite(invite: Invite): Promise<void> {
  await ddb.send(new PutCommand({ TableName: INVITES_TABLE, Item: invite }));
}

export async function getInvite(email: string, orgId: string): Promise<Invite | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: INVITES_TABLE, Key: { email: normalizeEmail(email), orgId } }),
  );
  return (res.Item as Invite | undefined) ?? null;
}

/** A user's pending invites, by their (verified) email. */
export async function listInvitesByEmail(email: string): Promise<Invite[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: INVITES_TABLE,
      KeyConditionExpression: "email = :e",
      ExpressionAttributeValues: { ":e": normalizeEmail(email) },
    }),
  );
  return (res.Items as Invite[] | undefined) ?? [];
}

/** Pending invites in an org (admin view). Uses the byOrg GSI. */
export async function listInvitesByOrg(orgId: string): Promise<Invite[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: INVITES_TABLE,
      IndexName: "byOrg",
      KeyConditionExpression: "orgId = :o",
      ExpressionAttributeValues: { ":o": orgId },
    }),
  );
  return (res.Items as Invite[] | undefined) ?? [];
}

export async function deleteInvite(email: string, orgId: string): Promise<void> {
  await ddb.send(
    new DeleteCommand({ TableName: INVITES_TABLE, Key: { email: normalizeEmail(email), orgId } }),
  );
}
