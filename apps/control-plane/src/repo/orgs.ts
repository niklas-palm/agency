/**
 * Organizations table access (pk=orgId). One row per org - personal and team
 * alike (uniform, no special-casing). A personal org has `kind:"personal"` and is
 * never deletable; team orgs are created via `POST /orgs`. See docs/auth.md.
 */
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Org } from "@agency/shared";
import { ddb } from "../ddb.js";
import { ORGS_TABLE } from "../config.js";

export async function putOrg(org: Org): Promise<void> {
  await ddb.send(new PutCommand({ TableName: ORGS_TABLE, Item: org }));
}

export async function getOrg(orgId: string): Promise<Org | null> {
  const res = await ddb.send(new GetCommand({ TableName: ORGS_TABLE, Key: { orgId } }));
  return (res.Item as Org | undefined) ?? null;
}

export async function deleteOrg(orgId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: ORGS_TABLE, Key: { orgId } }));
}
