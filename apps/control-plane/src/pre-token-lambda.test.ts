import { describe, it, expect } from "vitest";
import { handler } from "./pre-token-lambda.js";

describe("pre-token-generation (V2)", () => {
  it("adds the email claim AND the agency/api scope to the access token", async () => {
    const event = {
      // email_verified is required now: the claim is an authority input (it decides
      // which pending invite a caller may accept), so an unverified address must not
      // become one. See email-claim.test.ts.
      request: { userAttributes: { email: "user@example.com", email_verified: "true", sub: "abc" } },
      response: {},
    };
    const out = await handler(event);
    expect(out.response.claimsAndScopeOverrideDetails).toEqual({
      accessTokenGeneration: {
        claimsToAddOrOverride: { email: "user@example.com" },
        scopesToAdd: ["agency/api"],
      },
    });
  });

  it("still adds the API scope when the user has no email (no claim override with undefined)", async () => {
    const event = { request: { userAttributes: { sub: "abc" } }, response: {} };
    const out = await handler(event);
    // The scope is unconditional (the API requires it); the email claim is omitted.
    expect(out.response.claimsAndScopeOverrideDetails).toEqual({
      accessTokenGeneration: { scopesToAdd: ["agency/api"] },
    });
  });
});
