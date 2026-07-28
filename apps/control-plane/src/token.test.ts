import { describe, it, expect } from "vitest";
import { generateAccessToken, hashAccessToken, isAccessToken } from "./token.js";
import { isScope, ALL_SCOPES } from "@agency/shared";

describe("access tokens", () => {
  it("mints an agpat_-prefixed token and a matching hash", () => {
    const { token, hash } = generateAccessToken();
    expect(token.startsWith("agpat_")).toBe(true);
    expect(isAccessToken(token)).toBe(true);
    expect(hash).toBe(hashAccessToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it("mints distinct tokens", () => {
    expect(generateAccessToken().token).not.toBe(generateAccessToken().token);
  });

  it("does not mistake a JWT or an agent key for a PAT", () => {
    expect(isAccessToken("eyJhbGciOi.jwt.token")).toBe(false);
    expect(isAccessToken("ag_someagentkey")).toBe(false);
  });
});

describe("scopes", () => {
  it("recognizes known scopes and rejects unknowns", () => {
    for (const s of ALL_SCOPES) expect(isScope(s)).toBe(true);
    expect(isScope("agents:admin")).toBe(false);
    expect(isScope("")).toBe(false);
  });

  it("does not accept Object prototype names as scopes", () => {
    // Guards against `in`-based checks letting "toString"/"__proto__" through.
    for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(isScope(name)).toBe(false);
    }
  });
});
