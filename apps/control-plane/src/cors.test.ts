import { describe, it, expect } from "vitest";
import { buildApp } from "./app.js";
import type { Deps } from "./app.js";

// Minimal fake deps - CORS is resolved before any handler, so these are unused.
const deps: Deps = {
  scheduler: { reconcile: async () => {}, remove: async () => {} },
  invoker: { invoke: async () => ({ status: "triggered", sessionId: "s" }) },
  identity: { ensureUser: async () => "exists", emailFor: async () => undefined },
};

describe("CORS preflight", () => {
  it("answers OPTIONS preflight with 2xx + CORS headers, NOT a 401 auth rejection", async () => {
    const app = buildApp(deps);
    const res = await app.request("/agents", {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.cloudfront.net",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    // The bug was: ANY /{proxy+} routed OPTIONS to requireAuth → 401. A preflight
    // must succeed (2xx) so the browser proceeds with the real request.
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect((res.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("authorization");
  });

  it("allows the X-Agency-Org header through preflight (it rides every authed request)", async () => {
    const app = buildApp(deps);
    const res = await app.request("/orgs", {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.cloudfront.net",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,x-agency-org",
      },
    });
    // Regression: the SPA sends X-Agency-Org on every authed call to select the
    // active org; if it's not in allow-headers the browser blocks the request
    // ("field x-agency-org is not allowed by Access-Control-Allow-Headers").
    expect(res.status).toBeLessThan(300);
    expect((res.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("x-agency-org");
  });

  it("attaches the allow-origin header to a normal response too", async () => {
    const app = buildApp(deps);
    const res = await app.request("/health", { headers: { Origin: "https://example.cloudfront.net" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
