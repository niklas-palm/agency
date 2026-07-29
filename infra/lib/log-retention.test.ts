/**
 * Every log group this platform writes to must expire.
 *
 * The trap: nothing in AWS expires a log group by default, and none of these groups
 * is declared by CDK - Lambda and AgentCore create them on first use - so a missing
 * retention policy is invisible in the template and in `cdk diff`. It only shows up
 * as a group holding a year of agent output, which is both a bill and a retention
 * posture nobody chose (see SECURITY.md). A new Lambda is the easy way to
 * reintroduce it: add the function, forget `expireFunctionLogs`, and nothing fails.
 *
 * So this asserts the COUNT per stack as well as the retention value - the count is
 * what catches the forgotten call. If you add a Lambda or a runtime, the number here
 * moves with it, deliberately.
 */
import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AuthStack } from "./auth-stack.js";
import { DataStack } from "./data-stack.js";
import { ControlPlaneStack } from "./control-plane-stack.js";
import { WebSearchStack } from "./web-search-stack.js";
import { SampleApiStack } from "./sample-api-stack.js";

const ENV = { account: "000000000000", region: "eu-north-1" };

/** Synthesize once - a full app synth is slow and every assertion reads the same templates. */
function templates() {
  const app = new App();
  const auth = new AuthStack(app, "TestAuth", { env: ENV });
  const data = new DataStack(app, "TestData", { env: ENV });
  const search = new WebSearchStack(app, "TestSearch", {
    env: { ...ENV, region: "us-east-1" },
    crossRegionReferences: true,
  });
  const cp = new ControlPlaneStack(app, "TestControlPlane", {
    env: ENV,
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
    webSearchGatewayUrl: search.gatewayUrl,
    webSearchGatewayArn: search.gatewayArn,
  });
  const sample = new SampleApiStack(app, "TestSampleApi", { env: ENV });
  return {
    controlPlane: Template.fromStack(cp),
    auth: Template.fromStack(auth),
    sampleApi: Template.fromStack(sample),
  };
}

/** The retention custom resources in a template, as `[logGroupName, retentionInDays]`. */
function retentions(t: Template): Array<[string, unknown]> {
  return Object.values(t.findResources("Custom::LogRetention")).map((r) => {
    const props = (r as { Properties: Record<string, unknown> }).Properties;
    // The group name is a token (it embeds the function name / runtime id), so it
    // renders as an Fn::Join - stringify it and match on the literal parts.
    return [JSON.stringify(props.LogGroupName), props.RetentionInDays];
  });
}

describe("log retention", () => {
  const t = templates();

  it("expires the control plane's four Lambdas and both runtime log groups", () => {
    const found = retentions(t.controlPlane);
    // ControlPlaneFn, IngestFn, ScheduleTriggerFn, DiscoverySweepFn + the public and
    // isolated AgentCore runtimes.
    expect(found).toHaveLength(6);
    expect(found.filter(([name]) => name.includes("/aws/lambda/"))).toHaveLength(4);
    expect(
      found.filter(([name]) => name.includes("/aws/bedrock-agentcore/runtimes/")),
      "the microVM log groups are AgentCore's, not CDK's - they need retention by name",
    ).toHaveLength(2);
  });

  it("expires the pre-token Lambda and the sample API's Lambda", () => {
    expect(retentions(t.auth)).toHaveLength(1);
    expect(retentions(t.sampleApi)).toHaveLength(1);
  });

  it("keeps every group for 30 days", () => {
    const all = [...retentions(t.controlPlane), ...retentions(t.auth), ...retentions(t.sampleApi)];
    for (const [name, days] of all) {
      expect(days, `${name} is not on the 30-day retention`).toBe(30);
    }
  });
});
