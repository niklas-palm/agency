#!/usr/bin/env node
/**
 * CDK entrypoint. One stack per concern:
 *   AgencyAuth  - Cognito user pool + web/M2M clients
 *   AgencyData  - DynamoDB tables
 *   AgencyControlPlane - runtime image + the shared AgentCore runtime pool (public + isolated) + IAM + API Lambda
 *   AgencyWeb   - the SPA on S3 + CloudFront
 *   AgencyWebCert - us-east-1 certificate for the SPA's custom domain (only with one configured)
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
import { WebCertStack } from "../lib/web-cert-stack.js";
import { WebSearchStack } from "../lib/web-search-stack.js";
import { SampleApiStack } from "../lib/sample-api-stack.js";
import { REGION, WEB_SEARCH_REGION, CLOUDFRONT_CERT_REGION } from "../lib/config.js";
import { resolveDomain } from "../lib/domain.js";

const app = new App();
const env = { region: REGION };

// The optional custom domain (`-c domainName=… -c hostedZoneId=…`). Resolved once here
// so every stack sees the same answer, and so a half-set pair fails at synth.
const domain = resolveDomain(app);

const auth = new AuthStack(app, "AgencyAuth", { env, domain });
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
  domain,
});

// CloudFront accepts an ACM certificate only from us-east-1, so the SPA's certificate
// needs a us-east-1 stack of its own (same single-region reason as AgencyWebSearch);
// AgencyWeb reads its ARN cross-region. The API's certificate is regional and is issued
// inside AgencyControlPlane instead. Neither exists without a configured domain.
const webCert = domain
  ? new WebCertStack(app, "AgencyWebCert", {
      env: { region: CLOUDFRONT_CERT_REGION },
      crossRegionReferences: true,
      domain,
    })
  : undefined;
new WebStack(app, "AgencyWeb", {
  env,
  crossRegionReferences: true,
  site: domain && webCert ? { domain, certificateArn: webCert.certificateArn } : undefined,
});

// A REMOVABLE sample downstream API to integrate against end-to-end (its own stack, so
// deleting it is `cdk destroy AgencySampleApi` - it touches nothing else).
//
// OPT-IN, because it is a second internet-facing API that exists only for the
// integrations E2E: `cdk deploy --all` shouldn't hand a deployer a demo endpoint they
// didn't ask for. Enable with `-c sampleApi=true` (or in cdk.context.json).
if (app.node.tryGetContext("sampleApi") === "true" || app.node.tryGetContext("sampleApi") === true) {
  new SampleApiStack(app, "AgencySampleApi", { env });
}

