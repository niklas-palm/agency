#!/usr/bin/env node
/**
 * CDK entrypoint. One stack per concern:
 *   AgencyAuth  - Cognito user pool + web/M2M clients
 *   AgencyData  - DynamoDB tables
 *   AgencyControlPlane - runtime image + the shared AgentCore runtime pool (public + isolated) + IAM + API Lambda
 *   AgencyWeb   - the SPA on S3 + CloudFront
 *   AgencySampleApi - a REMOVABLE sample downstream API to demo integrations end-to-end
 *                     (OPT-IN: only synthesized with `-c sampleApi=true`)
 *
 * A shared AgentCore runtime pool (public + isolated/VPC, picked per agent by
 * config.networkMode) backs every agent, created in AgencyControlPlane. Agents
 * are pure config - creating one is just a DynamoDB write, no per-agent runtime
 * provisioning.
 */
import { App } from "aws-cdk-lib";
import { AuthStack } from "../lib/auth-stack.js";
import { DataStack } from "../lib/data-stack.js";
import { ControlPlaneStack } from "../lib/control-plane-stack.js";
import { WebStack } from "../lib/web-stack.js";
import { WebSearchStack } from "../lib/web-search-stack.js";
import { SampleApiStack } from "../lib/sample-api-stack.js";
import { REGION, WEB_SEARCH_REGION } from "../lib/config.js";

const app = new App();
const env = { region: REGION };

const auth = new AuthStack(app, "AgencyAuth", { env });
const data = new DataStack(app, "AgencyData", { env });

// Web search lives in us-east-1 (the only region with the managed connector);
// the control-plane consumes its gateway URL + ARN cross-region. See the stack.
const webSearch = new WebSearchStack(app, "AgencyWebSearch", { env: { region: WEB_SEARCH_REGION } });

new ControlPlaneStack(app, "AgencyControlPlane", {
  // crossRegionReferences lets this eu-north-1 stack read the us-east-1 gateway's
  // URL/ARN (CDK provisions a small custom resource to ferry the values).
  env,
  crossRegionReferences: true,
  agentsTable: data.agentsTable,
  trajectoryTable: data.trajectoryTable,
  tracesBucket: data.tracesBucket,
  tokensTable: data.tokensTable,
  versionsTable: data.versionsTable,
  sessionsTable: data.sessionsTable,
  skillsTable: data.skillsTable,
  integrationsTable: data.integrationsTable,
  orgsTable: data.orgsTable,
  membershipsTable: data.membershipsTable,
  invitesTable: data.invitesTable,
  userPool: auth.userPool,
  webSearchGatewayUrl: webSearch.gatewayUrl,
  webSearchGatewayArn: webSearch.gatewayArn,
});
new WebStack(app, "AgencyWeb", { env });

// A REMOVABLE sample downstream API to integrate against end-to-end (its own stack, so
// deleting it is `cdk destroy AgencySampleApi` - it touches nothing else).
//
// OPT-IN, because it is a second internet-facing API that exists only for the
// integrations E2E: `cdk deploy --all` shouldn't hand a deployer a demo endpoint they
// didn't ask for. Enable with `-c sampleApi=true` (or in cdk.context.json).
if (app.node.tryGetContext("sampleApi") === "true" || app.node.tryGetContext("sampleApi") === true) {
  new SampleApiStack(app, "AgencySampleApi", { env });
}

