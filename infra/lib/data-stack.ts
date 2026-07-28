/**
 * Data stack: the DynamoDB tables. Mirrors the local schema created by
 * scripts/ensure-tables.ts - agents (pk=id, GSI byOrg), trajectory
 * (pk=sessionId, sk=cursor, TTL), tokens (pk=tokenHash, GSI byOwner), versions
 * (pk=agentId, sk=version), sessions (pk=agentId, sk=runId), skills
 * (pk=orgId, sk=id), integrations (pk=orgId, sk=id), and the org model: orgs
 * (pk=orgId), memberships (pk=orgId, sk=userId, GSI byUser), invites (pk=email,
 * sk=orgId, GSI byOrg). All are retained except trajectory (disposable, TTL).
 *
 * Plus the TRACES bucket: the trajectory table has a 30-day TTL, so a finished run's
 * events are archived to S3 to make run history durable (see docs/metrics.md).
 */
import { Stack, type StackProps, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";

export class DataStack extends Stack {
  readonly agentsTable: dynamodb.Table;
  readonly trajectoryTable: dynamodb.Table;
  readonly tokensTable: dynamodb.Table;
  readonly versionsTable: dynamodb.Table;
  readonly sessionsTable: dynamodb.Table;
  readonly skillsTable: dynamodb.Table;
  readonly integrationsTable: dynamodb.Table;
  readonly orgsTable: dynamodb.Table;
  readonly membershipsTable: dynamodb.Table;
  readonly invitesTable: dynamodb.Table;
  readonly tracesBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // No explicit tableName - CDK derives a unique physical name from the logical
    // id, and the concrete name is passed to consumers via env (see the
    // control-plane stack). This way renaming/rebranding never forces a table
    // replacement (which would drop data).
    this.agentsTable = new dynamodb.Table(this, "AgentsTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.agentsTable.addGlobalSecondaryIndex({
      indexName: "byOrg",
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
    });

    this.trajectoryTable = new dynamodb.Table(this, "TrajectoryTable", {
      partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "cursor", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Personal Access Tokens: keyed by the token's SHA-256 hash so auth is an
    // O(1) GetItem on the presented token's hash; byOwner GSI backs list/revoke.
    // Retained - these are user credentials, not disposable like trajectories.
    this.tokensTable = new dynamodb.Table(this, "TokensTable", {
      partitionKey: { name: "tokenHash", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.tokensTable.addGlobalSecondaryIndex({
      indexName: "byOwner",
      partitionKey: { name: "ownerId", type: dynamodb.AttributeType.STRING },
    });

    // Agent config version history: pk=agentId, sk=version (append-only archive
    // of config snapshots). Retained - it's the record you restore from.
    this.versionsTable = new dynamodb.Table(this, "VersionsTable", {
      partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "version", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Durable per-session metric summaries: pk=agentId, sk=runId (one row per
    // runtime lifetime, overwritten as the session progresses). The metrics
    // engine's source of truth; retained (unlike ephemeral trajectory).
    this.sessionsTable = new dynamodb.Table(this, "SessionsTable", {
      partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "runId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Reusable skills, ORG-scoped: pk=orgId, sk=id. A skill lives in one org and
    // carries createdBy + shared (the per-resource visibility rule is applied in the
    // handler). Retained (user content).
    this.skillsTable = new dynamodb.Table(this, "SkillsTable", {
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Reusable integrations, ORG-scoped: pk=orgId, sk=id. Holds the write-only
    // downstream credential (secret), so it's retained (user content + secrets).
    this.integrationsTable = new dynamodb.Table(this, "IntegrationsTable", {
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- Org model ---------------------------------------------------------

    // Organizations: pk=orgId. One row per org (personal + team alike). Retained.
    this.orgsTable = new dynamodb.Table(this, "OrgsTable", {
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Memberships: pk=orgId, sk=userId (the authority source; attr `role`). The
    // byUser GSI answers "which orgs am I in" for the org switcher. Retained.
    this.membershipsTable = new dynamodb.Table(this, "MembershipsTable", {
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.membershipsTable.addGlobalSecondaryIndex({
      indexName: "byUser",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
    });

    // Pending invites: pk=email (lowercased - the invitee's hot lookup), sk=orgId.
    // The byOrg GSI lists an admin's pending invites. Deleted on accept/decline/
    // rescind. Retained (RETAIN is harmless; these are short-lived rows anyway).
    this.invitesTable = new dynamodb.Table(this, "InvitesTable", {
      partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.invitesTable.addGlobalSecondaryIndex({
      indexName: "byOrg",
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
    });

    // Archived run trajectories: one object per run, `traces/<agentId>/<runId>.json`.
    // The trajectory TABLE is the hot store with a 30-day TTL; this makes a run's
    // events readable long after those rows expire, so the Monitor run list can open a
    // past run.
    //
    // Keyed by runId, not sessionId: a client may reuse one sessionId across microVM
    // lifetimes, and each lifetime is its own run writing into that SAME trajectory
    // partition - so a session-keyed object let a later run overwrite an earlier run's
    // trace. One object per run can't collide.
    //
    // Private + TLS-only + owner-enforced: nothing here is public, and the console
    // reads it through the control-plane (which authorizes the agent first), never
    // directly. RETAIN, like every other durable store here.
    //
    // Traces are kept FOREVER - no lifecycle expiry. A run's trajectory is the record
    // of what an agent actually did, so it stays openable for the life of the
    // deployment: the run LIST (the session rows) is durable, and this makes the trace
    // behind every row durable to match. Nothing deletes an object either - neither
    // Lambda holds s3:Delete*, by design - so deleting an agent (or cascading an org)
    // leaves its traces orphaned but unreachable, since every read goes through an
    // authorized agent record. The trade-off accepted here is storage cost and the
    // indefinite retention of prompt content; see docs/data-model.md.
    this.tracesBucket = new s3.Bucket(this, "TracesBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
