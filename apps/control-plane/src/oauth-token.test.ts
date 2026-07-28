/**
 * OAuth2 client-credentials minting + caching: the proxy mints a short-lived token
 * from the provider, caches it until near expiry, re-mints when stale, and never
 * throws (a failed mint is returned as data). basic vs body auth styles differ in
 * how the client secret is sent.
 */
import { describe, it, expect, vi } from "vitest";
import { getAccessToken } from "./oauth-token.js";

type OAuth = Parameters<typeof getAccessToken>[0];
const AUTH_BASIC: OAuth = {
  kind: "oauth2Client",
  tokenUrl: "https://auth.example.com/token",
  clientId: "cid-basic",
  authStyle: "basic",
};

function tokenFetch(token: string, expiresIn = 3600, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("getAccessToken", () => {
  it("mints a token via HTTP Basic and returns it", async () => {
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from("cid-basic:the-secret").toString("base64")}`,
      );
      expect(init.body).toContain("grant_type=client_credentials");
      return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const t = await getAccessToken(AUTH_BASIC, "the-secret", { now: 1_000, doFetch });
    expect(t).toBe("tok-1");
  });

  it("sends client_id + client_secret in the body for authStyle body", async () => {
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      const body = String(init.body);
      expect(body).toContain("client_id=cid-body");
      expect(body).toContain("client_secret=sekret");
      return new Response(JSON.stringify({ access_token: "tok-body" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const auth: OAuth = { ...AUTH_BASIC, clientId: "cid-body", authStyle: "body" };
    const t = await getAccessToken(auth, "sekret", { now: 1_000, doFetch });
    expect(t).toBe("tok-body");
  });

  it("caches the token and does not re-mint before expiry", async () => {
    const doFetch = tokenFetch("cached-tok", 3600);
    const auth: OAuth = { ...AUTH_BASIC, clientId: "cid-cache" };
    const t1 = await getAccessToken(auth, "s", { now: 10_000, doFetch });
    const t2 = await getAccessToken(auth, "s", { now: 20_000, doFetch }); // 10s later, well within 1h
    expect(t1).toBe("cached-tok");
    expect(t2).toBe("cached-tok");
    expect(doFetch).toHaveBeenCalledOnce(); // served from cache the second time
  });

  it("re-mints once the cached token is near expiry", async () => {
    let n = 0;
    const doFetch = vi.fn(async () => {
      n++;
      return new Response(JSON.stringify({ access_token: `tok-${n}`, expires_in: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const auth: OAuth = { ...AUTH_BASIC, clientId: "cid-expire" };
    const t1 = await getAccessToken(auth, "s", { now: 0, doFetch }); // expires ~100s - 60s skew = 40s
    const t2 = await getAccessToken(auth, "s", { now: 50_000, doFetch }); // past the skew-adjusted expiry
    expect(t1).toBe("tok-1");
    expect(t2).toBe("tok-2");
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("busts the cache when the secret is rotated", async () => {
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const which = String(init.headers && (init.headers as Record<string, string>).Authorization).includes(
        Buffer.from("cid-rot:new").toString("base64"),
      )
        ? "new"
        : "old";
      return new Response(JSON.stringify({ access_token: `tok-${which}`, expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const auth: OAuth = { ...AUTH_BASIC, clientId: "cid-rot" };
    const t1 = await getAccessToken(auth, "old", { now: 0, doFetch });
    const t2 = await getAccessToken(auth, "new", { now: 100, doFetch }); // rotated secret → new fingerprint
    expect(t1).toBe("tok-old");
    expect(t2).toBe("tok-new");
  });

  it("still caches a SHORT-lived token (expires_in <= skew) instead of re-minting every call", async () => {
    // expires_in:30 → skew-adjusted expiry would be in the past; the floor keeps it
    // cached for ~half the TTL so back-to-back calls don't hammer the token endpoint.
    let n = 0;
    const doFetch = vi.fn(async () => {
      n++;
      return new Response(JSON.stringify({ access_token: `t${n}`, expires_in: 30 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const auth: OAuth = { ...AUTH_BASIC, clientId: "cid-short" };
    const t1 = await getAccessToken(auth, "s", { now: 0, doFetch });
    const t2 = await getAccessToken(auth, "s", { now: 5_000, doFetch }); // 5s later, within the 15s floor
    expect(t1).toBe("t1");
    expect(t2).toBe("t1"); // served from cache, not re-minted
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it("returns a MintError (never throws) when the token endpoint fails", async () => {
    const doFetch = tokenFetch("x", 3600, 500);
    const auth: OAuth = { ...AUTH_BASIC, clientId: "cid-500" };
    const res = await getAccessToken(auth, "s", { now: 0, doFetch });
    expect(res).toMatchObject({ error: expect.stringContaining("HTTP 500") });
  });

  it("errors when the response has no access_token", async () => {
    const doFetch = vi.fn(async () =>
      new Response(JSON.stringify({ nope: true }), { status: 200, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
    const auth: OAuth = { ...AUTH_BASIC, clientId: "cid-noatk" };
    const res = await getAccessToken(auth, "s", { now: 0, doFetch });
    expect(res).toMatchObject({ error: expect.stringContaining("access_token") });
  });
});
