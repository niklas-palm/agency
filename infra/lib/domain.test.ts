import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { resolveDomain } from "./domain.js";

const zoneId = "Z0000000000000EXAMPLE";

describe("resolveDomain", () => {
  it("is undefined when neither key is set (no custom domain)", () => {
    expect(resolveDomain(new App())).toBeUndefined();
  });

  it("derives the API host from the site domain", () => {
    const app = new App({ context: { domainName: "agency.example.com", hostedZoneId: zoneId } });
    expect(resolveDomain(app)).toEqual({
      siteDomain: "agency.example.com",
      apiDomain: "api.agency.example.com",
      hostedZoneId: zoneId,
    });
  });

  it("throws when only one half is set", () => {
    expect(() => resolveDomain(new App({ context: { domainName: "agency.example.com" } }))).toThrow(
      /must be set together/,
    );
    expect(() => resolveDomain(new App({ context: { hostedZoneId: zoneId } }))).toThrow(/must be set together/);
  });

  it("treats blank and non-string context as unset", () => {
    // `-c domainName=` yields an empty string, and cdk.context.json can hold anything.
    expect(resolveDomain(new App({ context: { domainName: "  ", hostedZoneId: "" } }))).toBeUndefined();
    expect(resolveDomain(new App({ context: { domainName: true, hostedZoneId: 7 } }))).toBeUndefined();
  });

  it("trims surrounding whitespace", () => {
    const app = new App({ context: { domainName: " agency.example.com ", hostedZoneId: ` ${zoneId} ` } });
    expect(resolveDomain(app)).toMatchObject({ siteDomain: "agency.example.com", hostedZoneId: zoneId });
  });
});
