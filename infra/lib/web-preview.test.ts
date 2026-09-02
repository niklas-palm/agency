/**
 * PR previews: the routing rule and the stack's shape.
 *
 * The router is the part that can silently do the wrong thing - a bad host→prefix mapping
 * serves one PR's bundle under another PR's hostname, which looks like a working preview.
 * It's a CloudFront Function, so it can't be imported; the test evaluates the file the
 * stack ships (`FunctionCode.fromFile`), which is the point: a test against a copy of the
 * code would pass while the deployed function was wrong.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { WebPreviewStack } from "./web-preview-stack.js";

const ENV = { account: "000000000000", region: "eu-north-1" };
const DOMAIN = {
  siteDomain: "agency.example.com",
  apiDomain: "api.agency.example.com",
  hostedZoneId: "Z0000000000000EXAMPLE",
};

// The CloudFront Functions runtime is ES5.1 and has no module system, so the file declares
// a bare `function handler`. Evaluate it and hand back that function.
function loadRouter(): (event: unknown) => Record<string, unknown> {
  const code = readFileSync(fileURLToPath(new URL("./preview-router.js", import.meta.url)), "utf8");
  return new Function(`${code}\nreturn handler;`)() as (event: unknown) => Record<string, unknown>;
}

const handler = loadRouter();

/** A viewer-request event, as CloudFront shapes it. */
function request(host: string, uri: string) {
  return { request: { uri, headers: host ? { host: { value: host } } : {} } };
}

describe("preview router", () => {
  it("maps a PR host to that PR's key prefix", () => {
    expect(handler(request("123.agency.example.com", "/assets/index-abc.js"))).toMatchObject({
      uri: "/123/assets/index-abc.js",
    });
  });

  it("serves index.html for a directory request", () => {
    // The SPA is entered at `/` and routes on the hash, so this is the path that matters.
    expect(handler(request("123.agency.example.com", "/"))).toMatchObject({ uri: "/123/index.html" });
    expect(handler(request("7.agency.example.com", "/sub/"))).toMatchObject({ uri: "/7/sub/index.html" });
  });

  it("keeps previews apart - the prefix comes from the host, never the path", () => {
    // Same path, two hosts: if these ever collide, one PR is reviewing another's build.
    const a = handler(request("11.agency.example.com", "/index.html")) as { uri: string };
    const b = handler(request("22.agency.example.com", "/index.html")) as { uri: string };
    expect([a.uri, b.uri]).toEqual(["/11/index.html", "/22/index.html"]);
  });

  it("404s a host that isn't a PR number, without touching the origin", () => {
    // The wildcard DNS record answers for every unclaimed subdomain, and the distribution
    // also serves its own *.cloudfront.net name. Neither should reach S3.
    for (const host of ["", "www.agency.example.com", "12a.agency.example.com", "d111abc.cloudfront.net"]) {
      expect(handler(request(host, "/"))).toMatchObject({ statusCode: 404 });
    }
  });

  it("names the real host suffix in the 404, so the URL shape is discoverable", () => {
    const res = handler(request("www.agency.example.com", "/")) as { body: string };
    expect(res.body).toContain("agency.example.com");
  });
});

describe("AgencyWebPreview", () => {
  const template = Template.fromStack(
    new WebPreviewStack(new App(), "TestWebPreview", {
      env: ENV,
      domain: DOMAIN,
      certificateArn: `arn:aws:acm:us-east-1:${ENV.account}:certificate/00000000-0000-0000-0000-000000000000`,
    }),
  );

  it("serves every preview from ONE distribution on the wildcard alias", () => {
    // A distribution per PR would mean a stack, a certificate and a DNS record per PR.
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({ Aliases: [`*.${DOMAIN.siteDomain}`] }),
    });
  });

  it("runs the router on every viewer request", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: [Match.objectLike({ EventType: "viewer-request" })],
        }),
      }),
    });
  });

  it("keeps previews out of search results", () => {
    // A preview is a real console against the production API, on a guessable hostname.
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        CustomHeadersConfig: {
          Items: [Match.objectLike({ Header: "X-Robots-Tag", Value: "noindex, nofollow" })],
        },
      }),
    });
  });

  it("expires abandoned previews even if CI never tears them down", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 30, Status: "Enabled" })] },
    });
  });

  it("keeps the bucket private (CloudFront reads it, nobody else)", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it("points the wildcard at CloudFront in both address families", () => {
    for (const type of ["A", "AAAA"]) {
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: `*.${DOMAIN.siteDomain}.`,
        Type: type,
      });
    }
  });

  it("publishes what CI needs, so no workflow carries the domain", () => {
    // This repo is public: the deployment's hostname is read from the stack, never
    // written into a tracked workflow file.
    const outputs = Object.keys(template.toJSON().Outputs ?? {});
    expect(outputs).toEqual(
      expect.arrayContaining(["PreviewBucketName", "PreviewDistributionId", "PreviewHostSuffix"]),
    );
  });
});
