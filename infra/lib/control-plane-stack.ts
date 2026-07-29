/**
 * ControlPlane stack: the API Lambda + a small pool of shared agent runtimes +
 * IAM roles.
 *
 * - Builds the agent-runtime container as an ARM64 DockerImageAsset (→ ECR).
 * - AgentRuntime (PUBLIC): the default AgentCore runtime running that image,
 *   backing every non-isolated agent (AgentCore still isolates each session in
 *   its own microVM). The agent's id/config/skills/version ride the invoke
 *   payload, so a config change needs no re-provision and a deploy updates the
 *   image for all agents at once.
 * - AgentRuntimeIsolated (VPC): the SAME image on a runtime placed in a VPC with
 *   NO public egress (no IGW / no NAT). It reaches AWS only via PrivateLink
 *   interface endpoints - crucially bedrock-runtime (Anthropic) + bedrock-mantle
 *   (OpenAI keyless) for model inference + bedrock-agentcore (the microVM data plane),
 *   plus logs/ecr/s3 + execute-api (the private ingest API for telemetry). Backs
 *   agents with `config.networkMode: "isolated"`.
 * - RuntimeRole: assumed by both runtimes. BEDROCK-ONLY: Bedrock InvokeModel/
 *   Converse + bedrock-mantle (OpenAI-on-Bedrock) + InvokeGateway on the web-search
 *   gateway + logs + ECR pull. NO DynamoDB - the runtime posts telemetry to the
 *   ingest API (below) authed by a per-session token that rides its invoke payload
 *   (it holds no long-lived secret), so a stolen-via-MMDS role cred can invoke our
 *   models but reach no table. See docs/runtime.md.
 * - IngestFn + front doors: a dedicated Lambda (same Hono app, granted trajectory
 *   read+write + sessions write + traces-bucket PUT + integrations READ + the token
 *   signing key) receives
 *   the runtime's telemetry AND serves the integrations proxy (/internal/integrations/
 *   call - resolves the org-scoped integration, injects its credential, forwards).
 *   Public runtime reaches it via a public HTTP API; the isolated runtime via a
 *   VPC-private REST API (HTTP APIs can't be private) over an execute-api endpoint.
 * - ControlPlaneFn: the Hono app on Lambda behind an HTTP API. Grants it
 *   InvokeAgentRuntime on BOTH runtimes + DynamoDB. No create/update/delete of
 *   runtimes (there's nothing per-agent to provision); the invoker picks the
 *   runtime ARN by the agent's network mode. With a custom domain configured
 *   (infra/lib/domain.ts) that API also answers on `api.<domain>` via a regional
 *   certificate issued here + an alias record.
 */
import { Stack, type StackProps, CfnOutput, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as apigwRest from "aws-cdk-lib/aws-apigateway";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { REGION, WEB_SEARCH_REGION } from "./config.js";
import { expireFunctionLogs, expireLogGroup } from "./logging.js";
import type { DomainConfig } from "./domain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

interface ControlPlaneStackProps extends StackProps {
  agentsTable: dynamodb.Table;
  trajectoryTable: dynamodb.Table;
  /** Archived run trajectories (see DataStack.tracesBucket). */
  tracesBucket: s3.Bucket;
  tokensTable: dynamodb.Table;
  versionsTable: dynamodb.Table;
  sessionsTable: dynamodb.Table;
  skillsTable: dynamodb.Table;
  integrationsTable: dynamodb.Table;
  orgsTable: dynamodb.Table;
  membershipsTable: dynamodb.Table;
  invitesTable: dynamodb.Table;
  userPool: cognito.UserPool;
  /**
   * The us-east-1 web-search MCP gateway (AgencyWebSearch stack), consumed
   * cross-region: its URL rides the PUBLIC runtime's env and the runtime role is
   * granted InvokeGateway on its ARN. The public runtime signs to WEB_SEARCH_REGION.
   */
  webSearchGatewayUrl: string;
  webSearchGatewayArn: string;
  /**
   * Optional custom domain (infra/lib/domain.ts). When set, the API also answers on
   * `api.<domain>` with a regional certificate this stack issues, and that host - not
   * the execute-api one - becomes the advertised `PUBLIC_API_URL` + `ApiUrl` output.
   */
  domain?: DomainConfig;
}

export class ControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    // The agent-runtime container image (shared by every created runtime).
    const runtimeImage = new DockerImageAsset(this, "RuntimeImage", {
      directory: REPO_ROOT,
      file: "apps/agent-runtime/Dockerfile",
      platform: Platform.LINUX_ARM64,
      // Exclude CDK output + deps from the build context so the asset doesn't
      // recurse into its own output (infra/cdk.out lives inside the repo).
      exclude: ["**/node_modules", "**/dist", "infra/cdk.out", "cdk.out", ".git"],
    });

    // Role the created AgentCore runtimes assume.
    const runtimeRole = new iam.Role(this, "RuntimeRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
      description: "Assumed by Agency AgentCore runtimes",
    });
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:Converse",
          "bedrock:ConverseStream",
          // OpenAI-on-Bedrock (Mantle): the Strands OpenAIModel mints a bearer
          // token and calls the Mantle endpoint. In practice this authorizes
          // against bedrock-mantle:CallWithBearerToken; CreateInference is kept
          // too as a belt-and-suspenders for the classic-inference path (the
          // exact action isn't in CloudTrail's data plane, so both are granted).
          "bedrock-mantle:CallWithBearerToken",
          "bedrock-mantle:CreateInference",
        ],
        resources: ["*"],
      }),
    );
    runtimeImage.repository.grantPull(runtimeRole);
    // The runtime role is BEDROCK-ONLY (+ logs + ECR pull + web-search gateway).
    // It has NO DynamoDB grant: the runtime posts trajectory + session summaries
    // to the ingest API (below) authed by a per-session token (carried in its invoke
    // payload), not with this role. So an agent that steals these creds via MMDS can
    // invoke our models but cannot touch the trajectory/sessions tables (or the
    // agents table - never granted). See docs/runtime.md.
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: ["*"],
      }),
    );

    // ---- Telemetry ingest (runtime → control-plane, no DDB on the runtime) ----
    // The HMAC signing key for the per-session ingest tokens. Stored in Secrets
    // Manager (generated once), injected as RUNTIME_INGEST_KEY into the MINTERS
    // (ControlPlaneFn + ScheduleTriggerFn) and the VERIFIER (IngestFn) - NOT into
    // either runtime, which holds no long-lived ingest secret (see session-token.ts).
    const ingestKey = new secretsmanager.Secret(this, "RuntimeIngestKey", {
      description: "HMAC signing key for per-session telemetry ingest tokens",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    const ingestKeyValue = ingestKey.secretValue.unsafeUnwrap(); // resolved at deploy into env

    // A DEDICATED ingest Lambda runs the same Hono app but is granted only the two
    // telemetry-table writes + trajectory READ (to pull a run's events for the archive)
    // + traces PUT + the signing key - a small blast radius, and (crucially)
    // it has NO dependency on the runtime ARNs, so wiring the runtimes to reach it
    // creates no CloudFormation cycle. Two front doors target it: a public HTTP API
    // (public runtime) and a private REST API (isolated runtime - HTTP APIs can't
    // be made VPC-private, so REST is required for the no-egress path).
    const ingestFn = new NodejsFunction(this, "IngestFn", {
      entry: join(REPO_ROOT, "apps/control-plane/src/lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // 512 MB: this Lambda also serves the integrations proxy, which buffers a
      // response up to MAX_LARGE_RESPONSE_BYTES (2.5 MiB) and then decodes +
      // JSON-escapes it - several multiples of the raw size transiently, and the
      // escaping is CPU-bound (CPU scales with memory on Lambda).
      memorySize: 512,
      // MUST exceed the proxy's own work budget, or the Lambda is killed before it
      // can return its crafted timeout error and the agent sees an opaque 502 for
      // every slow downstream. Budget: OAuth mint (<=10s) + downstream request
      // (<=10s, see integration-proxy REQUEST_TIMEOUT_MS) + overhead, under the
      // API Gateway ~30s ceiling.
      timeout: Duration.seconds(29),
      bundling: { format: "esm" as never, target: "node22" },
      environment: {
        MODE: "prod",
        TRAJECTORY_TABLE: props.trajectoryTable.tableName,
        SESSIONS_TABLE: props.sessionsTable.tableName,
        // The integrations proxy route (/internal/integrations/call) runs on this
        // Lambda too; it resolves the org-scoped integration record (READ ONLY) to
        // forward the call + inject the credential.
        INTEGRATIONS_TABLE: props.integrationsTable.tableName,
        // The Slack proxy route (/internal/slack/call) also runs on this Lambda, and it resolves
        // the agent record (READ ONLY) to reach the bot token + re-check the channel allowlist.
        // Without this the table name fell back to a literal that doesn't exist, so every Slack
        // reply failed with a 500 the agent was told not to retry - the agent would run, finish,
        // and post nothing.
        AGENTS_TABLE: props.agentsTable.tableName,
        RUNTIME_INGEST_KEY: ingestKeyValue,
        // Where a finished run's trajectory is archived, so it outlives the
        // trajectory table's 30-day TTL and stays openable in the run list.
        TRACES_BUCKET: props.tracesBucket.bucketName,
        // The ingest app never invokes runtimes; give it a harmless
        // issuer so config validation is happy. Management routes aren't meaningfully
        // reachable through its front doors (public HTTP API / private REST both hit
        // the same app, but management needs a JWT the runtime doesn't have, and this
        // Lambda holds no TOKENS grant, and only READ on agents - only /internal/* works).
        COGNITO_ISSUER: `https://cognito-idp.${REGION}.amazonaws.com/${props.userPool.userPoolId}`,
        API_SCOPE: "agency/api",
      },
    });
    expireFunctionLogs(ingestFn);
    // Trajectory + sessions: exactly PutItem and Query, spelled out rather than taken from
    // grantReadWriteData/grantWriteData. Those helpers also hand over DeleteItem and
    // BatchWriteItem, which nothing here calls (`recordEvent` appends, `writeSummary`
    // overwrites one row, `readEvents` queries) - and a DeleteItem IngestFn doesn't need is a
    // way for a leaked session token to ERASE its tenant's trajectory, which is the one thing
    // an audit trail exists to prevent. Query is needed on trajectory so the session-summary
    // handler can pull a run's events back out to archive them.
    for (const table of [props.trajectoryTable, props.sessionsTable]) {
      ingestFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["dynamodb:PutItem", "dynamodb:Query"],
          resources: [table.tableArn],
        }),
      );
    }
    // Archive only - PUT, never delete. IngestFn re-writes a run's object at each idle
    // point (events are append-only, so each write is a superset). Nothing expires a trace
    // either: the bucket has no lifecycle rule, by design (see data-stack.ts).
    props.tracesBucket.grantPut(ingestFn);
    // Integrations proxy: READ ONLY. IngestFn resolves the org-scoped record to
    // forward the call; it never mutates integrations, so no write grant (the
    // credential secret leaves only via the outbound forward, never back to a caller).
    props.integrationsTable.grantReadData(ingestFn);
    // READ ONLY on agents, for the Slack proxy. This does widen IngestFn's reach - the agent
    // record carries `slackSecrets` and `apiKeyHash` - so it's stated deliberately rather than
    // quietly, as the integrations grant was. The alternative (carrying the reply target in the
    // session token so the record is never read) would drop the allowlist re-check that lets a
    // revoked channel take effect on a thread that's already running.
    props.agentsTable.grantReadData(ingestFn);

    // Public runtime front door: a small public HTTP API fronting IngestFn. (NOT a
    // Lambda Function URL: `authType: NONE` gives the URL an AnyPrincipal `*` invoke
    // grant, i.e. a genuinely world-invocable function. Automated security tooling
    // reasonably flags that and commonly auto-scopes the `*` principal down to the
    // account, which then 403s the anonymous runtime call - so the URL is fragile even
    // where it's allowed. An HTTP API invokes Lambda via the apigateway service
    // principal instead: no `*` grant, nothing to flag, and the same path the main
    // control-plane API already uses.) No IAM auth on the route; the
    // per-session ingest token (verified in-app) is the auth. Only /internal/* is
    // meaningfully reachable (management routes need a JWT the runtime doesn't have,
    // and IngestFn holds no tokens grant, and only READ on agents).
    const publicIngestApi = new apigw.HttpApi(this, "PublicIngestApi", {
      defaultIntegration: new HttpLambdaIntegration("PublicIngestIntegration", ingestFn),
    });
    // apiEndpoint has no trailing slash; the runtime's ingest client appends /internal/...
    const ingestUrl = publicIngestApi.apiEndpoint;

    // ---- Managed web search (AgentCore Web Search via a shared Gateway) ------
    // One platform-wide MCP gateway fronting AWS's managed `web-search` connector.
    // The connector is us-east-1-only, so the gateway lives in the separate
    // AgencyWebSearch stack (us-east-1); here we consume it CROSS-REGION - the
    // PUBLIC runtime reaches it over its public egress, SigV4-signed to
    // WEB_SEARCH_REGION (the same cross-region pattern as the Mantle models).
    // Grant the runtime role InvokeGateway on the gateway's (us-east-1) ARN.
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeGateway"],
        resources: [props.webSearchGatewayArn],
      }),
    );

    // ---- The shared agent-runtime pool --------------------------------------
    // A small pool of AgentCore runtimes (one per network mode) backs every
    // agent. AgentCore still isolates each session in its own microVM (keyed by
    // runtimeSessionId), so agents never share state; what's shared is the
    // runtime *definition* (image + role + env). The agent's id, config, skills,
    // integrations, and version all ride the invoke payload - so a config change needs no
    // re-provision, and a platform deploy updates the image for every agent at
    // once (no per-agent stale image). This mirrors the local single-container
    // model (one local container serves both modes).
    //
    // The PUBLIC runtime: public egress, backs every non-isolated agent. It posts
    // telemetry to the public ingest HTTP API - no DDB env, no DDB grant. agentId
    // rides the invoke payload (one runtime, all agents). The runtime holds NO
    // ingest secret - only the ingest URL; its per-session capability token arrives
    // in each invoke payload.
    // The public runtime always gets web search: the gateway URL + the region to
    // SigV4-sign to (us-east-1). The isolated runtime deliberately omits both -
    // it has no public egress to reach the gateway.
    const runtimeEnv = {
      INGEST_URL: ingestUrl,
      WEB_SEARCH_GATEWAY_URL: props.webSearchGatewayUrl,
      WEB_SEARCH_REGION,
    };
    const lifecycle = { idleRuntimeSessionTimeout: 3600, maxLifetime: 28_800 };
    const runtime = new agentcore.CfnRuntime(this, "AgentRuntime", {
      agentRuntimeName: "agency_runtime",
      agentRuntimeArtifact: { containerConfiguration: { containerUri: runtimeImage.imageUri } },
      roleArn: runtimeRole.roleArn,
      networkConfiguration: { networkMode: "PUBLIC" },
      protocolConfiguration: "HTTP",
      // 8h max session; long idle timeout so a warm session survives between a
      // client's polls and follow-up messages.
      lifecycleConfiguration: lifecycle,
      environmentVariables: runtimeEnv,
    });

    // ---- The ISOLATED runtime (no public egress; private Bedrock only) -------
    // A second shared runtime, same image, placed in a VPC with NO route to the
    // internet (no IGW, no NAT). It backs agents with networkMode "isolated".
    // The ONLY way out is AWS PrivateLink to the services the runtime needs:
    // Bedrock for inference (both runtime + mantle), plus logs/ecr/s3 +
    // execute-api (the private ingest API for telemetry - no DynamoDB, the
    // runtime role has no table access). So `run_bash` curl, web search, and fetch simply
    // cannot reach the internet - isolation is enforced at the network layer.
    //
    // eu-north-1 offers AgentCore VPC mode across its AZs, so we let CDK pick two
    // (maxAzs:2) rather than pinning AZ names. (In us-east-1, AgentCore VPC mode was
    // limited to specific AZ *IDs* and required explicit name pinning - re-derive
    // that if ever moving back to a region with the same constraint.)
    const isolatedVpc = new ec2.Vpc(this, "IsolatedVpc", {
      maxAzs: 2,
      natGateways: 0, // no NAT: there is no public egress by construction
      subnetConfiguration: [
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // One SG for the runtime ENIs + the interface endpoints. Default egress is
    // open within CDK, but with no internet route the only reachable targets are
    // the endpoints in this VPC; we also let the endpoints accept 443 from the SG.
    const isolatedSg = new ec2.SecurityGroup(this, "IsolatedRuntimeSg", {
      vpc: isolatedVpc,
      description: "Agency isolated runtime ENIs + PrivateLink endpoints (no public egress)",
      allowAllOutbound: true,
    });
    isolatedSg.addIngressRule(isolatedSg, ec2.Port.tcp(443), "HTTPS from runtime ENIs to endpoints");

    // Gateway endpoint (free, route-table entry, no ENI): S3 for the ECR image
    // layer blobs. No DynamoDB endpoint - the runtime role has NO table access; it
    // posts telemetry to the ingest Lambda via the execute-api endpoint below.
    isolatedVpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });

    // Interface endpoints (PrivateLink ENIs, private DNS on so the SDK's default
    // endpoints resolve to them with no client change). bedrock-mantle has no CDK
    // preset, so it's constructed by service name.
    const interfaceServices: Record<string, ec2.IInterfaceVpcEndpointService> = {
      BedrockRuntime: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME, // Anthropic
      // NOTE: no bedrock-mantle endpoint here. Mantle (OpenAI-keyless) is us-east-1
      // only, and PrivateLink is same-region, so an isolated eu-north-1 VPC can't
      // reach it. Consequence: OpenAI models are unavailable in ISOLATED mode
      // (Anthropic works in every mode); public-mode agents still reach Mantle
      // cross-region over their egress. Re-add this endpoint if the region ever has
      // Mantle locally.
      // The AgentCore data-plane endpoint: the runtime's own bedrock-agentcore
      // SDK reaches it in-VM (workload identity, async-task/status reporting). No
      // NAT means without this the container's invocation handling hangs and the
      // invoke times out - it's as load-bearing as the Bedrock endpoints.
      AgentCore: ec2.InterfaceVpcEndpointAwsService.BEDROCK_AGENTCORE,
      Logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
      EcrDocker: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    };
    for (const [id, service] of Object.entries(interfaceServices)) {
      isolatedVpc.addInterfaceEndpoint(`${id}Endpoint`, {
        service,
        securityGroups: [isolatedSg],
        privateDnsEnabled: true,
      });
    }

    // execute-api endpoint: lets the isolated runtime reach a PRIVATE REST API over
    // PrivateLink (private DNS on, so the standard execute-api hostname resolves to
    // the ENIs). This is the isolated runtime's telemetry path - it can't reach the
    // public ingest HTTP API (no egress), and HTTP APIs can't be made private,
    // so a private REST API fronting the SAME ingest Lambda is required here.
    const apiGwEndpoint = isolatedVpc.addInterfaceEndpoint("ApiGwEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      securityGroups: [isolatedSg],
      privateDnsEnabled: true,
    });

    // The private REST API: PRIVATE endpoint type, locked by a resource policy to
    // this VPC endpoint, proxying everything to the ingest Lambda (same handler as
    // the public HTTP API). Only /internal/* is meaningfully reachable (the per-session
    // token gates it); management routes need a user JWT which nothing in the VPC has.
    const privateIngestApi = new apigwRest.RestApi(this, "PrivateIngestApi", {
      restApiName: "agency-ingest-private",
      description: "VPC-private telemetry ingest for the isolated runtime → ingest Lambda",
      endpointConfiguration: { types: [apigwRest.EndpointType.PRIVATE], vpcEndpoints: [apiGwEndpoint] },
      policy: new iam.PolicyDocument({
        statements: [
          // Allow only calls arriving through our VPC endpoint; deny everything else.
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
            conditions: { StringEquals: { "aws:SourceVpce": apiGwEndpoint.vpcEndpointId } },
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
            conditions: { StringNotEquals: { "aws:SourceVpce": apiGwEndpoint.vpcEndpointId } },
          }),
        ],
      }),
      deployOptions: { stageName: "prod" },
    });
    privateIngestApi.root.addProxy({
      anyMethod: true,
      defaultIntegration: new apigwRest.LambdaIntegration(ingestFn),
    });
    // The isolated runtime posts here. RestApi.url ends with the stage + trailing
    // slash; strip it so `${INGEST_URL}/internal/...` has no double slash.
    const privateIngestUrl = privateIngestApi.url.replace(/\/$/, "");

    const runtimeIsolated = new agentcore.CfnRuntime(this, "AgentRuntimeIsolated", {
      agentRuntimeName: "agency_runtime_isolated",
      agentRuntimeArtifact: { containerConfiguration: { containerUri: runtimeImage.imageUri } },
      roleArn: runtimeRole.roleArn,
      networkConfiguration: {
        networkMode: "VPC",
        networkModeConfig: {
          subnets: isolatedVpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
          securityGroups: [isolatedSg.securityGroupId],
        },
      },
      protocolConfiguration: "HTTP",
      lifecycleConfiguration: lifecycle,
      // No WEB_SEARCH_GATEWAY_URL: web search needs public egress it doesn't have.
      // Telemetry goes to the private REST ingest API over PrivateLink; no DDB, no
      // ingest secret (per-session token rides the payload).
      environmentVariables: {
        INGEST_URL: privateIngestUrl,
      },
    });

    // AgentCore validates it can PULL the ECR image (incl. ecr:GetAuthorizationToken)
    // at runtime-create time using the runtime role. `grantPull` puts those perms on
    // the role's DEFAULT policy, which CloudFormation may create AFTER the runtime
    // unless we force the order - on a fresh account/region that race fails create
    // with "Access denied while validating ECR URI". So both runtimes explicitly
    // depend on the role's default policy. (This is the documented ECR-validation
    // race; it only surfaces when the role/policy don't already exist.)
    // Depend on the role's default policy (where grantPull's ECR perms land). Fail
    // LOUD if the construct id ever changes (CDK upgrade) rather than silently
    // skipping - a silent skip would quietly reintroduce the create-race this fixes.
    const runtimePolicyDep = runtimeRole.node.tryFindChild("DefaultPolicy")?.node.defaultChild;
    if (!runtimePolicyDep) {
      throw new Error(
        "RuntimeRole DefaultPolicy not found - the ECR-validation-race dependency can't be wired. " +
          "The role's default-policy construct id likely changed in a CDK upgrade; re-derive it.",
      );
    }
    runtime.node.addDependency(runtimePolicyDep);
    runtimeIsolated.node.addDependency(runtimePolicyDep);

    // Expire the microVM logs (the agent's own stdout/stderr - the log you read when
    // an agent misbehaves) after LOG_RETENTION. AgentCore creates one group per
    // runtime and CfnRuntime has no retention property, so we name the group it will
    // create: `<runtimeId>-DEFAULT`, where runtimeId is `<name>-<suffix>`.
    for (const [id, rt] of [
      ["AgentRuntime", runtime],
      ["AgentRuntimeIsolated", runtimeIsolated],
    ] as const) {
      expireLogGroup(
        this,
        `${id}LogRetention`,
        `/aws/bedrock-agentcore/runtimes/${rt.attrAgentRuntimeId}-DEFAULT`,
      );
    }

    // The control-plane API Lambda (the Hono app).
    const issuer = `https://cognito-idp.${REGION}.amazonaws.com/${props.userPool.userPoolId}`;
    const fn = new NodejsFunction(this, "ControlPlaneFn", {
      entry: join(REPO_ROOT, "apps/control-plane/src/lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      bundling: { format: "esm" as never, target: "node22" },
      environment: {
        MODE: "prod",
        // AWS_REGION is auto-provided by the Lambda runtime; config.ts reads it.
        // CDK-generated table names (no hardcoded name - see data-stack).
        AGENTS_TABLE: props.agentsTable.tableName,
        TRAJECTORY_TABLE: props.trajectoryTable.tableName,
        TOKENS_TABLE: props.tokensTable.tableName,
        VERSIONS_TABLE: props.versionsTable.tableName,
        SESSIONS_TABLE: props.sessionsTable.tableName,
        SKILLS_TABLE: props.skillsTable.tableName,
        INTEGRATIONS_TABLE: props.integrationsTable.tableName,
        ORGS_TABLE: props.orgsTable.tableName,
        MEMBERSHIPS_TABLE: props.membershipsTable.tableName,
        INVITES_TABLE: props.invitesTable.tableName,
        // The shared runtime pool - the invoker picks by the agent's networkMode.
        RUNTIME_ARN_PUBLIC: runtime.attrAgentRuntimeArn,
        RUNTIME_ARN_ISOLATED: runtimeIsolated.attrAgentRuntimeArn,
        // Signs the per-session ingest tokens it mints at invoke (same key the
        // ingest Lambda verifies with).
        RUNTIME_INGEST_KEY: ingestKeyValue,
        COGNITO_ISSUER: issuer,
        // Read-side of the trace archive: the run-detail route serves an archived
        // trajectory once the table's TTL has expired it.
        TRACES_BUCKET: props.tracesBucket.bucketName,
        API_SCOPE: "agency/api",
        // Selects the Cognito identity provider over the local no-op (see app.ts), so
        // it's load-bearing for both halves of that seam: the invite path's lazy login
        // provisioning and the roster's userId → email lookup.
        USER_POOL_ID: props.userPool.userPoolId,
      },
    });

    expireFunctionLogs(fn);

    props.agentsTable.grantReadWriteData(fn);
    // Invites can provision a Cognito login for a new email (idempotent - existing
    // users are a no-op), and the members roster resolves a userId → email so it can
    // show a readable name instead of an opaque sub (AdminGetUser; the membership row
    // only caches the email of a member who has signed in since). Scoped to THIS
    // pool, and to those two actions - no list, no delete, no attribute writes.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"],
        resources: [props.userPool.userPoolArn],
      }),
    );
    // Read for polling; write so the control-plane can record the `prompt` event
    // at invoke time (see repo/trajectory.recordPrompt - kept out of the runtime
    // so it reaches every agent, not just newly-baked images).
    props.trajectoryTable.grantReadWriteData(fn);
    // PATs: auth reads by hash + touches lastUsedAt; routes create/list/delete.
    props.tokensTable.grantReadWriteData(fn);
    // Versioning + metrics: append/read the version history; read session summaries.
    props.versionsTable.grantReadWriteData(fn);
    props.sessionsTable.grantReadData(fn);
    // Archived traces: READ only. The control-plane serves them; it never writes or
    // deletes one (IngestFn is the sole writer, at each of a session's idle points).
    props.tracesBucket.grantRead(fn);
    // Skills: full CRUD (create/list/get/update/delete + resolve at invoke).
    props.skillsTable.grantReadWriteData(fn);
    // Integrations: full CRUD (create/list/get/update/delete + resolve at invoke).
    props.integrationsTable.grantReadWriteData(fn);
    // Org model: the control-plane resolves membership/role on every management
    // request and serves the org/member/invite routes - full CRUD on all three.
    props.orgsTable.grantReadWriteData(fn);
    props.membershipsTable.grantReadWriteData(fn);
    props.invitesTable.grantReadWriteData(fn);
    // The control-plane only INVOKES the shared runtimes now (no per-agent create/
    // update/delete), so its AgentCore surface narrows to InvokeAgentRuntime on
    // both pool runtimes. (No more bedrock-agentcore:* or PassRole - the runtimes
    // are provisioned by CDK, not at request time.)
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [
          runtime.attrAgentRuntimeArn,
          `${runtime.attrAgentRuntimeArn}/*`,
          runtimeIsolated.attrAgentRuntimeArn,
          `${runtimeIsolated.attrAgentRuntimeArn}/*`,
        ],
      }),
    );

    // ---- Schedule trigger (EventBridge Scheduler → trigger Lambda) ----------
    // A per-agent schedule (created at runtime by the control-plane) targets
    // this Lambda with `{agentId}`; it reads the agent's schedule prompt and
    // invokes the agent's runtime. Kept separate from the API Lambda so the
    // scheduler's blast radius is just "invoke an agent", not the whole API.
    const triggerFn = new NodejsFunction(this, "ScheduleTriggerFn", {
      entry: join(REPO_ROOT, "apps/control-plane/src/trigger-lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      bundling: { format: "esm" as never, target: "node22" },
      environment: {
        MODE: "prod",
        AGENTS_TABLE: props.agentsTable.tableName,
        SKILLS_TABLE: props.skillsTable.tableName,
        INTEGRATIONS_TABLE: props.integrationsTable.tableName,
        TRAJECTORY_TABLE: props.trajectoryTable.tableName,
        RUNTIME_ARN_PUBLIC: runtime.attrAgentRuntimeArn,
        RUNTIME_ARN_ISOLATED: runtimeIsolated.attrAgentRuntimeArn,
        // Mints per-session ingest tokens for scheduled invokes (same key).
        RUNTIME_INGEST_KEY: ingestKeyValue,
      },
    });
    expireFunctionLogs(triggerFn);
    // Read any agent's config (the schedule passes the agentId) + update the
    // metrics counter via bumpInvocation (an UpdateItem). Scoped to UpdateItem
    // (dropping DeleteItem/PutItem/BatchWrite) narrows the blast radius, but note
    // the residual: UpdateItem is table-wide (the Lambda legitimately touches
    // arbitrary agentIds, so no LeadingKeys condition is possible), so a
    // compromise could still `SET` fields - including apiKeyHash/config - on any
    // agent item. True item-scoping would require moving metrics to a separate
    // table the trigger holds write on while holding none on the config table;
    // deferred with the rest of the IAM tightening (see CLAUDE.md).
    props.agentsTable.grantReadData(triggerFn);
    // Resolve a scheduled agent's attached skills + integrations (read-only).
    props.skillsTable.grantReadData(triggerFn);
    props.integrationsTable.grantReadData(triggerFn);
    // Record the scheduled prompt in the trajectory (recordPrompt), same as the
    // API invoke path - so a scheduled run's trace shows the message that fired it.
    props.trajectoryTable.grantWriteData(triggerFn);
    triggerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:UpdateItem"],
        resources: [props.agentsTable.tableArn],
      }),
    );
    triggerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [
          runtime.attrAgentRuntimeArn,
          `${runtime.attrAgentRuntimeArn}/*`,
          runtimeIsolated.attrAgentRuntimeArn,
          `${runtimeIsolated.attrAgentRuntimeArn}/*`,
        ],
      }),
    );

    // A dedicated schedule group so all agent schedules are namespaced together.
    const scheduleGroup = new scheduler.CfnScheduleGroup(this, "ScheduleGroup", {
      name: "agency",
    });

    // The role EventBridge Scheduler assumes to invoke the trigger Lambda.
    // Confused-deputy hardening: only Scheduler acting for THIS account may assume
    // it (so another account's Scheduler can't be pointed at our trigger Lambda).
    const schedulerRole = new iam.Role(this, "SchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: "Assumed by EventBridge Scheduler to fire agent schedules",
    });
    triggerFn.grantInvoke(schedulerRole);

    // The control-plane manages schedules at runtime (create/update/delete) and
    // must pass the scheduler role to each schedule it creates.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule"],
        resources: [
          `arn:aws:scheduler:${REGION}:${this.account}:schedule/agency/*`,
        ],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [schedulerRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } },
      }),
    );
    fn.addEnvironment("SCHEDULE_GROUP", scheduleGroup.name!);
    fn.addEnvironment("TRIGGER_FUNCTION_ARN", triggerFn.functionArn);
    fn.addEnvironment("SCHEDULER_ROLE_ARN", schedulerRole.roleArn);

    // ---- Discovery refresh sweep (daily EventBridge rule → sweep Lambda) -----
    // Integrations whose operations were auto-discovered from a spec URL are
    // re-fetched daily so an evolving downstream API stays in sync. Reconcile keeps
    // the stored per-op selection (new ops default OFF - never an auto-grant); users
    // can also refresh on demand. Its own Lambda so the sweep's blast radius is just
    // "read+rewrite integrations", separate from the API and the schedule trigger.
    const discoverySweepFn = new NodejsFunction(this, "DiscoverySweepFn", {
      entry: join(REPO_ROOT, "apps/control-plane/src/discovery-sweep-lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // Public egress to fetch tenant spec URLs (guardedFetch is the SSRF anchor).
      // Bounded work per integration; a few minutes covers a full sweep.
      timeout: Duration.minutes(5),
      bundling: { format: "esm" as never, target: "node22" },
      environment: {
        MODE: "prod",
        INTEGRATIONS_TABLE: props.integrationsTable.tableName,
      },
    });
    expireFunctionLogs(discoverySweepFn);
    // Scan + rewrite discovery-backed integrations (across owners): read to find
    // them, write the refreshed catalog back.
    props.integrationsTable.grantReadWriteData(discoverySweepFn);

    new events.Rule(this, "DiscoverySweepRule", {
      description: "Daily refresh of auto-discovered integration operation catalogs",
      schedule: events.Schedule.rate(Duration.days(1)),
      targets: [new eventsTargets.LambdaFunction(discoverySweepFn)],
    });

    // ---- Optional custom domain for the API (api.<domain>) -------------------
    // The certificate MUST be issued in THIS region: an API Gateway regional custom
    // domain only accepts a same-region certificate (the mirror image of CloudFront,
    // which only accepts us-east-1 - hence the separate AgencyWebCert stack). Both are
    // DNS-validated in the same hosted zone.
    let apiDomainName: apigw.DomainName | undefined;
    if (props.domain) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
        hostedZoneId: props.domain.hostedZoneId,
        zoneName: props.domain.siteDomain,
      });
      apiDomainName = new apigw.DomainName(this, "ApiDomainName", {
        domainName: props.domain.apiDomain,
        certificate: new acm.Certificate(this, "ApiCertificate", {
          domainName: props.domain.apiDomain,
          validation: acm.CertificateValidation.fromDns(zone),
        }),
      });
      // `api` under the site-domain zone. A record only: a regional HTTP API custom
      // domain is IPv4-only by default, so an AAAA alias would resolve to nothing.
      new route53.ARecord(this, "ApiAliasA", {
        zone,
        recordName: "api",
        target: route53.RecordTarget.fromAlias(
          new route53Targets.ApiGatewayv2DomainProperties(
            apiDomainName.regionalDomainName,
            apiDomainName.regionalHostedZoneId,
          ),
        ),
      });
    }

    // CORS is handled inside the Hono app (see app.ts), not here: the
    // `ANY /{proxy+}` route below sends OPTIONS preflights to the Lambda, which
    // would override any API Gateway CORS config anyway.
    const api = new apigw.HttpApi(this, "HttpApi", {
      apiName: "agency-control-plane",
      // Maps the whole API (all stages' default stage) onto the custom domain. The
      // execute-api endpoint stays enabled: agent keys already in the wild were issued
      // with invoke URLs on it.
      defaultDomainMapping: apiDomainName ? { domainName: apiDomainName } : undefined,
    });
    api.addRoutes({
      path: "/{proxy+}",
      methods: [apigw.HttpMethod.ANY],
      integration: new HttpLambdaIntegration("Integration", fn),
    });

    // The origin we ADVERTISE: invoke URLs, the OpenAPI `servers` entry and the coding-agent
    // skill are all built from PUBLIC_API_URL (routes.ts), and the SPA build reads the
    // ApiUrl output - so with a custom domain configured they must all name it, not the
    // execute-api host. apiEndpoint is known at synth time, as is the custom host.
    const apiUrl = props.domain ? `https://${props.domain.apiDomain}` : api.apiEndpoint;
    fn.addEnvironment("PUBLIC_API_URL", apiUrl);

    new CfnOutput(this, "ApiUrl", { value: apiUrl });
    new CfnOutput(this, "RuntimeArn", { value: runtime.attrAgentRuntimeArn });
    new CfnOutput(this, "RuntimeArnIsolated", { value: runtimeIsolated.attrAgentRuntimeArn });
  }
}
