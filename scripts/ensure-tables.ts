/**
 * Create the DynamoDB tables (agents + trajectory + tokens + versions + sessions +
 * skills + integrations + orgs + memberships + invites) if they don't exist. Runs
 * against DynamoDB Local in dev (DDB_ENDPOINT set) and is idempotent, so it's
 * safe to run on every `docker compose up`. In prod the tables come from CDK,
 * so this script is dev-only. (DynamoDB Local is -inMemory, so a container restart
 * IS the local "wipe" - the org re-keying needs no explicit local migration.)
 */
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";

const REGION = process.env.AWS_REGION ?? "eu-north-1";
const ENDPOINT = process.env.DDB_ENDPOINT ?? "http://localhost:8000";
const AGENTS_TABLE = process.env.AGENTS_TABLE ?? "agency-agents";
const TRAJECTORY_TABLE = process.env.TRAJECTORY_TABLE ?? "agency-trajectory";
const TOKENS_TABLE = process.env.TOKENS_TABLE ?? "agency-tokens";
const VERSIONS_TABLE = process.env.VERSIONS_TABLE ?? "agency-versions";
const SESSIONS_TABLE = process.env.SESSIONS_TABLE ?? "agency-sessions";
const SKILLS_TABLE = process.env.SKILLS_TABLE ?? "agency-skills";
const INTEGRATIONS_TABLE = process.env.INTEGRATIONS_TABLE ?? "agency-integrations";
const ORGS_TABLE = process.env.ORGS_TABLE ?? "agency-orgs";
const MEMBERSHIPS_TABLE = process.env.MEMBERSHIPS_TABLE ?? "agency-memberships";
const INVITES_TABLE = process.env.INVITES_TABLE ?? "agency-invites";

const client = new DynamoDBClient({
  region: REGION,
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

async function exists(name: string): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return false;
    throw err;
  }
}

async function ensureAgents(): Promise<void> {
  if (await exists(AGENTS_TABLE)) return;
  await client.send(
    new CreateTableCommand({
      TableName: AGENTS_TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "id", AttributeType: "S" },
        { AttributeName: "orgId", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "byOrg",
          KeySchema: [{ AttributeName: "orgId", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
  console.log(`created table ${AGENTS_TABLE}`);
}

async function ensureTrajectory(): Promise<void> {
  if (await exists(TRAJECTORY_TABLE)) return;
  await client.send(
    new CreateTableCommand({
      TableName: TRAJECTORY_TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "sessionId", AttributeType: "S" },
        { AttributeName: "cursor", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "sessionId", KeyType: "HASH" },
        { AttributeName: "cursor", KeyType: "RANGE" },
      ],
    }),
  );
  console.log(`created table ${TRAJECTORY_TABLE}`);
}

async function ensureTokens(): Promise<void> {
  if (await exists(TOKENS_TABLE)) return;
  await client.send(
    new CreateTableCommand({
      TableName: TOKENS_TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "tokenHash", AttributeType: "S" },
        { AttributeName: "ownerId", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "tokenHash", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "byOwner",
          KeySchema: [{ AttributeName: "ownerId", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
  console.log(`created table ${TOKENS_TABLE}`);
}

async function ensureVersions(): Promise<void> {
  if (await exists(VERSIONS_TABLE)) return;
  await client.send(
    new CreateTableCommand({
      TableName: VERSIONS_TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "agentId", AttributeType: "S" },
        { AttributeName: "version", AttributeType: "N" },
      ],
      KeySchema: [
        { AttributeName: "agentId", KeyType: "HASH" },
        { AttributeName: "version", KeyType: "RANGE" },
      ],
    }),
  );
  console.log(`created table ${VERSIONS_TABLE}`);
}

async function ensureSessions(): Promise<void> {
  if (await exists(SESSIONS_TABLE)) return;
  await client.send(
    new CreateTableCommand({
      TableName: SESSIONS_TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "agentId", AttributeType: "S" },
        { AttributeName: "runId", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "agentId", KeyType: "HASH" },
        { AttributeName: "runId", KeyType: "RANGE" },
      ],
    }),
  );
  console.log(`created table ${SESSIONS_TABLE}`);
}

async function ensureSkills(): Promise<void> {
  if (await exists(SKILLS_TABLE)) return;
  await client.send(
    new CreateTableCommand({
      TableName: SKILLS_TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "orgId", AttributeType: "S" },
        { AttributeName: "id", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "orgId", KeyType: "HASH" },
        { AttributeName: "id", KeyType: "RANGE" },
      ],
    }),
  );
  console.log(`created table ${SKILLS_TABLE}`);
}

async function ensureIntegrations(): Promise<void> {
  if (await exists(INTEGRATIONS_TABLE)) return;
  await client.send(
    new CreateTableCommand({
      TableName: INTEGRATIONS_TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "orgId", AttributeType: "S" },
        { AttributeName: "id", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "orgId", KeyType: "HASH" },
        { AttributeName: "id", KeyType: "RANGE" },
      ],
    }),
  );
  console.log(`created table ${INTEGRATIONS_TABLE}`);
}

async function ensureOrgs(): Promise<void> {
  if (await exists(ORGS_TABLE)) return;
  await client.send(
    new CreateTableCommand({
      TableName: ORGS_TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "orgId", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "orgId", KeyType: "HASH" }],
    }),
  );
  console.log(`created table ${ORGS_TABLE}`);
}

async function ensureMemberships(): Promise<void> {
  if (await exists(MEMBERSHIPS_TABLE)) return;
  await client.send(
    new CreateTableCommand({
      TableName: MEMBERSHIPS_TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "orgId", AttributeType: "S" },
        { AttributeName: "userId", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "orgId", KeyType: "HASH" },
        { AttributeName: "userId", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "byUser",
          KeySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
  console.log(`created table ${MEMBERSHIPS_TABLE}`);
}

async function ensureInvites(): Promise<void> {
  if (await exists(INVITES_TABLE)) return;
  await client.send(
    new CreateTableCommand({
      TableName: INVITES_TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "email", AttributeType: "S" },
        { AttributeName: "orgId", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "email", KeyType: "HASH" },
        { AttributeName: "orgId", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "byOrg",
          KeySchema: [{ AttributeName: "orgId", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
  console.log(`created table ${INVITES_TABLE}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for DynamoDB Local to accept connections (it starts slightly after us). */
async function waitForDdb(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      await exists(AGENTS_TABLE);
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`DynamoDB not reachable at ${ENDPOINT} after 30s`);
}

async function main(): Promise<void> {
  await waitForDdb();
  await ensureAgents();
  await ensureTrajectory();
  await ensureTokens();
  await ensureVersions();
  await ensureSessions();
  await ensureSkills();
  await ensureIntegrations();
  await ensureOrgs();
  await ensureMemberships();
  await ensureInvites();
  console.log("tables ready");
}

main().catch((err) => {
  console.error("ensure-tables failed:", err);
  process.exit(1);
});
