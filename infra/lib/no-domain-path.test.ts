/**
 * The no-domain path must keep working, because it is what a stranger deploys.
 *
 * `infra/cdk.context.json` is tracked and ships with THIS deployment's domain, so the documented
 * first step for a fork is to delete two lines. That makes the no-domain path the most-travelled
 * one for everybody except us - and the one we would never notice breaking, since our own deploys
 * always have a domain.
 *
 * So this asserts what the README promises: with no domain configured, the app synthesizes no
 * certificates, no DNS records, no us-east-1 certificate stack, and URLs that resolve to the
 * AWS-provided hostnames.
 */
import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AuthStack } from "./auth-stack.js";
import { DataStack } from "./data-stack.js";
import { ControlPlaneStack } from "./control-plane-stack.js";
import { WebSearchStack } from "./web-search-stack.js";
import { WebStack } from "./web-stack.js";
import { resolveDomain } from "./domain.js";

const ENV = { account: "000000000000", region: "eu-north-1" };

/** Build the app exactly as bin/agency.ts does, with whatever context is given. */
function synth(context: Record<string, unknown>) {
  const app = new App({ context });
  const domain = resolveDomain(app);
  const auth = new AuthStack(app, "TestAuth", { env: ENV, domain });
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
    domain,
  });
  // bin/agency.ts passes `site` from the us-east-1 cert stack; a synthetic ARN is enough here
  // (we're asserting record shape, not certificate wiring - domain.test.ts covers that).
  const web = new WebStack(app, "TestWeb", {
    env: ENV,
    crossRegionReferences: true,
    ...(domain
      ? {
          site: {
            domain,
            certificateArn: `arn:aws:acm:us-east-1:${ENV.account}:certificate/00000000-0000-0000-0000-000000000000`,
          },
        }
      : {}),
  });
  return { domain, cp: Template.fromStack(cp), web: Template.fromStack(web) };
}

const countOf = (t: Template, type: string) => Object.keys(t.findResources(type)).length;

describe("with no domain configured (what a fork deploys)", () => {
  const { domain, cp, web } = synth({ sampleApi: "false" });

  it("resolves to no domain at all", () => {
    expect(domain).toBeUndefined();
  });

  it("synthesizes no certificates and no DNS records", () => {
    for (const t of [cp, web]) {
      expect(countOf(t, "AWS::CertificateManager::Certificate")).toBe(0);
      expect(countOf(t, "AWS::Route53::RecordSet")).toBe(0);
    }
  });

  it("maps the API onto no custom domain", () => {
    expect(countOf(cp, "AWS::ApiGatewayV2::DomainName")).toBe(0);
    expect(countOf(cp, "AWS::ApiGatewayV2::ApiMapping")).toBe(0);
  });

  /**
   * The promise the README makes: the SPA and API still have working URLs. If these stopped
   * resolving to the AWS-provided hostnames, a fork's SPA would be built against nothing.
   */
  it("still emits usable ApiUrl and SiteUrl outputs", () => {
    const apiUrl = JSON.stringify(cp.findOutputs("ApiUrl").ApiUrl?.Value);
    expect(apiUrl).toContain("ApiEndpoint");
    const siteUrl = JSON.stringify(web.findOutputs("SiteUrl").SiteUrl?.Value);
    expect(siteUrl).toContain("DomainName"); // the distribution's own domain
  });

  it("treats empty strings as unset, which is what a careless edit produces", () => {
    expect(resolveDomain(new App({ context: { domainName: "", hostedZoneId: "" } }))).toBeUndefined();
    expect(resolveDomain(new App({ context: { domainName: "   ", hostedZoneId: "  " } }))).toBeUndefined();
  });
});

describe("with a domain configured", () => {
  const { domain, cp, web } = synth({
    domainName: "agency.example.com",
    hostedZoneId: "Z0000000000000EXAMPLE",
    sampleApi: "false",
  });

  it("issues the API certificate in-region and maps the API domain", () => {
    expect(domain).toMatchObject({ siteDomain: "agency.example.com", apiDomain: "api.agency.example.com" });
    expect(countOf(cp, "AWS::CertificateManager::Certificate")).toBe(1);
    expect(countOf(cp, "AWS::ApiGatewayV2::DomainName")).toBe(1);
    // A record for `api.`, and no AAAA - a regional HTTP API custom domain is IPv4-only, so an
    // AAAA alias would resolve to nothing.
    const records = Object.values(cp.findResources("AWS::Route53::RecordSet")) as Array<{
      Properties: { Type: string };
    }>;
    expect(records.map((r) => r.Properties.Type)).toEqual(["A"]);
  });

  it("gives the SPA both A and AAAA (CloudFront is dual-stack)", () => {
    const types = (
      Object.values(web.findResources("AWS::Route53::RecordSet")) as Array<{ Properties: { Type: string } }>
    ).map((r) => r.Properties.Type);
    expect(types.sort()).toEqual(["A", "AAAA"]);
  });

  /** Deleting only one line must fail at synth, not deploy half a domain. */
  it("refuses a half-set pair", () => {
    expect(() => resolveDomain(new App({ context: { domainName: "agency.example.com" } }))).toThrow(
      /must be set together/,
    );
    expect(() => resolveDomain(new App({ context: { hostedZoneId: "Z0000000000000EXAMPLE" } }))).toThrow(
      /must be set together/,
    );
  });
});
