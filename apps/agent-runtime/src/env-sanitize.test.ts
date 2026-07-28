import { describe, it, expect } from "vitest";
import { sanitizeEnv } from "./agent.js";

describe("sanitizeEnv", () => {
  it("keeps the agent's own vars", () => {
    expect(sanitizeEnv({ MY_API_KEY: "x", DB_URL: "y" })).toEqual({ MY_API_KEY: "x", DB_URL: "y" });
  });

  it("drops reserved platform keys a user config must never set", () => {
    const out = sanitizeEnv({
      RUNTIME_INGEST_KEY: "leak", INGEST_URL: "leak", TRAJECTORY_TABLE: "leak",
      SESSIONS_TABLE: "leak", WEB_SEARCH_GATEWAY_URL: "leak", WEB_SEARCH_REGION: "leak",
      AGENT_ID: "leak", PATH: "leak", HOME: "leak", KEEP: "ok",
    });
    expect(out).toEqual({ KEEP: "ok" });
  });

  it("drops AWS_/LD_/NODE_ prefixed keys", () => {
    expect(sanitizeEnv({ AWS_SECRET_ACCESS_KEY: "x", LD_PRELOAD: "y", NODE_OPTIONS: "z", OK: "1" })).toEqual({ OK: "1" });
  });

  it("handles undefined/empty", () => {
    expect(sanitizeEnv(undefined)).toEqual({});
    expect(sanitizeEnv({})).toEqual({});
  });
});
