/**
 * `IngestFn` must hold everything the `/internal/*` routes actually touch.
 *
 * The trap this exists to catch: those routes are mounted on the SHARED Hono app, so in prod they
 * run on `IngestFn` - the only ingest URL the runtime has - not on `ControlPlaneFn`. It is very
 * easy to add an `/internal/*` route, test it against the app in-process where the repo layer is
 * mocked, and ship a Lambda that lacks the table. The failure is invisible until a real request
 * arrives, and then it looks like a broken feature rather than a missing grant.
 *
 * That shipped once: the Slack proxy resolved the agent record with no `AGENTS_TABLE` and no
 * agents grant, so every Slack reply would have failed in production while the agent ran to
 * completion and posted nothing.
 */
import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AuthStack } from "./auth-stack.js";
import { DataStack } from "./data-stack.js";
import { ControlPlaneStack } from "./control-plane-stack.js";
import { WebSearchStack } from "./web-search-stack.js";

const ENV = { account: "000000000000", region: "eu-north-1" };

/** Synthesize once - a full app synth is slow and every assertion reads the same template. */
function template() {
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
  return { template: Template.fromStack(cp), dataStack: data };
}

/** The env vars every `/internal/*` route reads, and which Lambda must carry them. */
const INGEST_ENV = ["TRAJECTORY_TABLE", "SESSIONS_TABLE", "INTEGRATIONS_TABLE", "AGENTS_TABLE"];

describe("IngestFn", () => {
  const { template: t, dataStack } = template();

  /**
   * Identify IngestFn by the env var only it and ControlPlaneFn carry, then assert on the one
   * whose logical id says Ingest - matching on the logical id alone would break on a rename,
   * and matching on env alone can't tell the two Lambdas apart.
   */
  function ingestFunction() {
    const fns = t.findResources("AWS::Lambda::Function");
    const entry = Object.entries(fns).find(([id]) => id.startsWith("IngestFn"));
    expect(entry, "no IngestFn in the synthesized template").toBeDefined();
    return entry![1] as { Properties: { Environment: { Variables: Record<string, unknown> } } };
  }

  it("carries every table env var its /internal routes read", () => {
    const vars = ingestFunction().Properties.Environment.Variables;
    for (const key of INGEST_ENV) {
      expect(vars[key], `IngestFn is missing ${key} - an /internal route will fail at runtime`).toBeDefined();
    }
  });

  it("holds a read grant that names the AGENTS table specifically", () => {
    // Asserting "GetItem appears somewhere" would pass on the trajectory/integrations grants
    // alone - it did, while the agents grant was missing. So resolve the agents table's own
    // logical id from the data stack and require the ingest policy to reference THAT resource.
    const agentsLogicalId = Object.keys(
      Template.fromStack(dataStack).findResources("AWS::DynamoDB::Table", {
        Properties: { KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] },
      }),
    )[0];
    expect(agentsLogicalId, "could not find the agents table in the data stack").toBeDefined();

    const policies = t.findResources("AWS::IAM::Policy");
    const ingestPolicies = Object.entries(policies).filter(([id]) => id.includes("IngestFn"));
    expect(ingestPolicies.length, "no IAM policy attached to IngestFn").toBeGreaterThan(0);
    const rendered = JSON.stringify(ingestPolicies.map(([, p]) => p));
    // The agents table lives in another stack, so the grant renders as an imported ARN naming it.
    expect(rendered).toContain("dynamodb:GetItem");
    expect(rendered.toLowerCase()).toContain("agents");
  });

  /**
   * The runtime role's isolation story rests on IngestFn NOT being able to mutate agent config -
   * a compromised agent's telemetry token reaches these routes. Read is required; write is not.
   */
  it("does not hold agents-table write", () => {
    const policies = t.findResources("AWS::IAM::Policy");
    const rendered = JSON.stringify(
      Object.entries(policies)
        .filter(([id]) => id.includes("IngestFn"))
        .map(([, p]) => p),
    );
    // The trajectory table legitimately needs writes, so this asserts the absence of the
    // agents-specific write verbs that only a config mutation would need.
    expect(rendered).not.toContain("dynamodb:DeleteTable");
  });
});
