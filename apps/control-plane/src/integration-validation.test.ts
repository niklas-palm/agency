/**
 * Integration body validation: the trust boundary between the public API and a
 * stored integration. Covers baseUrl SSRF-anchoring (no creds/query/fragment,
 * http(s) only), the auth discriminated union, operation-manifest rules, and the
 * write-only secret. These invariants are what the proxy later relies on.
 */
import { describe, it, expect } from "vitest";
import { parseIntegrationBody, normalizeBaseUrl } from "./integration-validation.js";

const OK_OP = { operationId: "getThing", summary: "Get a thing", method: "GET", path: "/things/{id}" };
function body(overrides: Record<string, unknown> = {}) {
  return {
    name: "My API",
    description: "A downstream API",
    baseUrl: "https://api.example.com/v1",
    auth: { kind: "bearer" },
    operations: [OK_OP],
    ...overrides,
  };
}

describe("normalizeBaseUrl", () => {
  it("keeps origin + path and strips a trailing slash", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    expect(normalizeBaseUrl("https://api.example.com")).toBe("https://api.example.com");
  });
  it("rejects non-http(s) schemes", () => {
    expect(normalizeBaseUrl("ftp://x.com")).toBeNull();
    expect(normalizeBaseUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeBaseUrl("gopher://x")).toBeNull();
  });
  it("rejects credentials, query, and fragment (the call composes those)", () => {
    expect(normalizeBaseUrl("https://user:pass@api.example.com")).toBeNull();
    expect(normalizeBaseUrl("https://api.example.com?x=1")).toBeNull();
    expect(normalizeBaseUrl("https://api.example.com#frag")).toBeNull();
  });
  it("rejects garbage", () => {
    expect(normalizeBaseUrl("not a url")).toBeNull();
  });
  it("rejects localhost and literal private/loopback/metadata hosts (proxy runs in platform infra)", () => {
    expect(normalizeBaseUrl("http://localhost:8080/internal")).toBeNull();
    expect(normalizeBaseUrl("http://127.0.0.1/")).toBeNull();
    expect(normalizeBaseUrl("http://169.254.169.254/latest/meta-data")).toBeNull();
    expect(normalizeBaseUrl("http://10.0.0.5/admin")).toBeNull();
    expect(normalizeBaseUrl("http://192.168.1.1/")).toBeNull();
    expect(normalizeBaseUrl("http://172.16.0.1/")).toBeNull();
    expect(normalizeBaseUrl("http://[::1]/")).toBeNull();
    expect(normalizeBaseUrl("http://[fd00::1]/")).toBeNull();
  });
  it("rejects IPv4-mapped/NAT64 IPv6 and rooted localhost. (literal forms that skip the v4 branch)", () => {
    // The URL parser normalizes ::ffff:169.254.169.254 to the hex form ::ffff:a9fe:a9fe,
    // so the v6 branch (not the v4 one) must catch the embedded metadata/private/loopback IP.
    expect(normalizeBaseUrl("http://[::ffff:169.254.169.254]/latest/meta-data")).toBeNull();
    expect(normalizeBaseUrl("http://[::ffff:127.0.0.1]/")).toBeNull();
    expect(normalizeBaseUrl("http://[::ffff:10.0.0.5]/")).toBeNull();
    expect(normalizeBaseUrl("http://[64:ff9b::a9fe:a9fe]/")).toBeNull(); // NAT64 metadata
    expect(normalizeBaseUrl("http://localhost./internal")).toBeNull(); // rooted FQDN
  });
  it("still accepts public hosts and public literal IPs", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
    expect(normalizeBaseUrl("https://8.8.8.8/x")).toBe("https://8.8.8.8/x");
  });
});

describe("parseIntegrationBody", () => {
  it("accepts a valid body and normalizes the baseUrl", () => {
    const r = parseIntegrationBody(body({ baseUrl: "https://api.example.com/v1/" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.baseUrl).toBe("https://api.example.com/v1");
  });

  it("requires name and description", () => {
    expect(parseIntegrationBody(body({ name: "" })).ok).toBe(false);
    expect(parseIntegrationBody(body({ description: "  " })).ok).toBe(false);
  });

  it("rejects an unsafe baseUrl", () => {
    const r = parseIntegrationBody(body({ baseUrl: "http://user:pw@x.com" }));
    expect(r.ok).toBe(false);
  });

  describe("auth", () => {
    it("accepts none / bearer", () => {
      expect(parseIntegrationBody(body({ auth: { kind: "none" } })).ok).toBe(true);
      expect(parseIntegrationBody(body({ auth: { kind: "bearer" } })).ok).toBe(true);
    });
    it("requires a valid header for apiKey", () => {
      expect(parseIntegrationBody(body({ auth: { kind: "apiKey", header: "X-Api-Key" } })).ok).toBe(true);
      expect(parseIntegrationBody(body({ auth: { kind: "apiKey" } })).ok).toBe(false);
      expect(parseIntegrationBody(body({ auth: { kind: "apiKey", header: "bad header" } })).ok).toBe(false);
    });
    it("rejects an unknown kind", () => {
      expect(parseIntegrationBody(body({ auth: { kind: "oauth" } })).ok).toBe(false);
    });

    describe("oauth2Client", () => {
      const ok = { kind: "oauth2Client", tokenUrl: "https://auth.example.com/token", clientId: "cid", authStyle: "basic" };
      it("accepts a valid client-credentials config", () => {
        const r = parseIntegrationBody(body({ auth: ok }));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.auth).toMatchObject({ kind: "oauth2Client", tokenUrl: "https://auth.example.com/token" });
      });
      it("carries optional scope + audience through", () => {
        const r = parseIntegrationBody(body({ auth: { ...ok, scope: "read:x write:x", audience: "https://api.example.com" } }));
        expect(r.ok).toBe(true);
        if (r.ok && r.value.auth.kind === "oauth2Client") {
          expect(r.value.auth.scope).toBe("read:x write:x");
          expect(r.value.auth.audience).toBe("https://api.example.com");
        }
      });
      it("requires tokenUrl + clientId + a valid authStyle", () => {
        expect(parseIntegrationBody(body({ auth: { ...ok, tokenUrl: undefined } })).ok).toBe(false);
        expect(parseIntegrationBody(body({ auth: { ...ok, clientId: "" } })).ok).toBe(false);
        expect(parseIntegrationBody(body({ auth: { ...ok, authStyle: "querystring" } })).ok).toBe(false);
      });
      it("SSRF-guards the tokenUrl (no localhost / metadata)", () => {
        expect(parseIntegrationBody(body({ auth: { ...ok, tokenUrl: "http://169.254.169.254/token" } })).ok).toBe(false);
        expect(parseIntegrationBody(body({ auth: { ...ok, tokenUrl: "http://localhost/token" } })).ok).toBe(false);
      });
    });
  });

  describe("discovery", () => {
    it("accepts a discovery url INSTEAD of operations (server derives them)", () => {
      const r = parseIntegrationBody(body({ operations: undefined, discovery: { url: "https://api.example.com/openapi.json" } }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.discovery?.url).toBe("https://api.example.com/openapi.json");
        expect(r.value.operations).toBeUndefined();
      }
    });
    it("carries an explicit enabledOperationIds selection through (deduped)", () => {
      const r = parseIntegrationBody(
        body({ operations: undefined, discovery: { url: "https://api.example.com/s.json", enabledOperationIds: ["a", "b", "a"] } }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.discovery?.enabledOperationIds).toEqual(["a", "b"]);
    });
    it("still requires operations when NO discovery is given (manual mode)", () => {
      expect(parseIntegrationBody(body({ operations: undefined })).ok).toBe(false);
    });
    it("SSRF-guards the discovery url", () => {
      expect(parseIntegrationBody(body({ operations: undefined, discovery: { url: "http://127.0.0.1/s.json" } })).ok).toBe(false);
    });
    it("rejects a malformed discovery block", () => {
      expect(parseIntegrationBody(body({ operations: undefined, discovery: { url: 123 } })).ok).toBe(false);
      expect(parseIntegrationBody(body({ operations: undefined, discovery: "https://x.com" })).ok).toBe(false);
    });
  });

  describe("operations", () => {
    it("requires a non-empty array", () => {
      expect(parseIntegrationBody(body({ operations: [] })).ok).toBe(false);
      expect(parseIntegrationBody(body({ operations: "x" })).ok).toBe(false);
    });
    it("validates operationId shape and uniqueness", () => {
      expect(parseIntegrationBody(body({ operations: [{ ...OK_OP, operationId: "1bad" }] })).ok).toBe(false);
      expect(
        parseIntegrationBody(body({ operations: [OK_OP, { ...OK_OP, path: "/other" }] })).ok,
      ).toBe(false); // duplicate operationId
    });
    it("requires method in the allowed set", () => {
      expect(parseIntegrationBody(body({ operations: [{ ...OK_OP, method: "TRACE" }] })).ok).toBe(false);
    });
    it("requires a leading-slash path and rejects traversal / absolute URLs", () => {
      expect(parseIntegrationBody(body({ operations: [{ ...OK_OP, path: "things" }] })).ok).toBe(false);
      expect(parseIntegrationBody(body({ operations: [{ ...OK_OP, path: "/../etc" }] })).ok).toBe(false);
      expect(parseIntegrationBody(body({ operations: [{ ...OK_OP, path: "/x://y" }] })).ok).toBe(false);
    });

    it("rejects a PROTOCOL-RELATIVE path that would resolve off baseUrl", () => {
      // "//evil.com/x" starts with "/" and has no "://" or "..", but
      // new URL("//evil.com/x", "https://api.example.com") === "https://evil.com/x"
      // - a different origin, which would aim the proxy + its injected credential
      // off base. (The proxy's isUnderBase check also blocks the forward; this
      // refuses it at the trust boundary so it can't even be stored.)
      expect(parseIntegrationBody(body({ operations: [{ ...OK_OP, path: "//evil.com/x" }] })).ok).toBe(false);
      expect(parseIntegrationBody(body({ operations: [{ ...OK_OP, path: "/\\evil.com/x" }] })).ok).toBe(false);
      // A normal path with an internal double slash is still fine (same origin).
      expect(parseIntegrationBody(body({ operations: [{ ...OK_OP, path: "/a//b" }] })).ok).toBe(true);
    });
  });

  describe("secret", () => {
    it("is optional and carried through when present", () => {
      const r = parseIntegrationBody(body({ secret: "tok-123" }));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.secret).toBe("tok-123");
    });
    it("is absent when omitted or empty (update leaves stored secret unchanged)", () => {
      const r = parseIntegrationBody(body({ secret: "" }));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.secret).toBeUndefined();
      const r2 = parseIntegrationBody(body());
      if (r2.ok) expect(r2.value.secret).toBeUndefined();
    });
    it("rejects a non-string secret", () => {
      expect(parseIntegrationBody(body({ secret: 123 })).ok).toBe(false);
    });
  });
});
