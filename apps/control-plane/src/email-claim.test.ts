/**
 * The `email` claim is an AUTHORITY input, so it has to be canonical.
 *
 * Invites are keyed by a lowercased email, and accepting one writes a membership under
 * the CALLER's `sub`. So if a raw claim reached `getInvite`, anyone able to set their
 * own address to a case-variant of an invited one (`VICTIM@corp.com`) could accept an
 * invite addressed to someone else and land in that org at the invited role - admin,
 * for an admin invite - while the real invitee never sees the invite again.
 *
 * Two layers are tested here: the token-generation trigger only emits a VERIFIED
 * address, and `authorizePayload` canonicalizes whatever arrives. (The third layer is
 * in CDK: the pool requires re-verification to change `email` and the web client can't
 * write the attribute at all.)
 */
import { describe, it, expect } from "vitest";
import { authorizePayload } from "./auth.js";
import { handler as preToken } from "./pre-token-lambda.js";

const SCOPE = "agency/api";
const base = { token_use: "access", scope: SCOPE, sub: "user-1" };

describe("authorizePayload canonicalizes the email claim", () => {
  it("lowercases it, so a case-variant can't resolve someone else's invite", () => {
    const d = authorizePayload({ ...base, email: "VICTIM@Corp.com" }, SCOPE);
    expect(d.ok && d.email).toBe("victim@corp.com");
  });

  it("trims it", () => {
    const d = authorizePayload({ ...base, email: "  victim@corp.com \t" }, SCOPE);
    expect(d.ok && d.email).toBe("victim@corp.com");
  });

  it("treats a whitespace-only claim as absent, not as an empty-string email", () => {
    const d = authorizePayload({ ...base, email: "   " }, SCOPE);
    expect(d.ok && d.email).toBeUndefined();
  });

  it("leaves an absent or non-string claim undefined", () => {
    const absent = authorizePayload({ ...base }, SCOPE);
    expect(absent.ok && absent.email).toBeUndefined();
    const nonString = authorizePayload({ ...base, email: 42 }, SCOPE);
    expect(nonString.ok && nonString.email).toBeUndefined();
  });
});

describe("the pre-token trigger only emits a verified email", () => {
  const run = async (userAttributes: Record<string, string>) => {
    const ev = await preToken({ request: { userAttributes }, response: {} });
    const details = ev.response.claimsAndScopeOverrideDetails as {
      accessTokenGeneration: { claimsToAddOrOverride?: { email?: string }; scopesToAdd: string[] };
    };
    return details.accessTokenGeneration;
  };

  it("emits a verified address, lowercased", async () => {
    const gen = await run({ email: "VICTIM@corp.com", email_verified: "true" });
    expect(gen.claimsToAddOrOverride?.email).toBe("victim@corp.com");
  });

  it("emits NO email claim when the address isn't verified", async () => {
    // The escalation precondition: a self-assigned, unverified address must never
    // become the identity an invite is matched against.
    const gen = await run({ email: "victim@corp.com", email_verified: "false" });
    expect(gen.claimsToAddOrOverride).toBeUndefined();
  });

  it("emits no email claim when the flag is missing entirely", async () => {
    const gen = await run({ email: "victim@corp.com" });
    expect(gen.claimsToAddOrOverride).toBeUndefined();
  });

  it("still adds the API scope either way - sign-in must not break", async () => {
    expect((await run({ email: "x@y.com" })).scopesToAdd).toContain(SCOPE);
    expect((await run({})).scopesToAdd).toContain(SCOPE);
  });
});
