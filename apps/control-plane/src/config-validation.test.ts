import { describe, it, expect } from "vitest";
import {
  parseConfigDetailed,
  parseTriggers,
  parseEnv,
  parseSkillIds,
  validScheduleExpression,
  withDefaults,
} from "./config-validation.js";

const valid = {
  name: "bot",
  systemPrompt: "do things",
  model: "haiku-4.5",
};

/**
 * The old `parseConfig` contract (config or null), over `parseConfigDetailed`. These
 * cases assert WHETHER a body validates; the error TEXT is covered separately below.
 */
const cfg = (body: unknown, partial: boolean) => {
  const r = parseConfigDetailed(body, partial);
  return r.ok ? r.config : null;
};

describe("parseConfig - create (partial=false)", () => {
  it("accepts a minimal valid body", () => {
    expect(cfg(valid, false)).toEqual(valid);
  });

  it("accepts a full valid body and preserves all fields", () => {
    const full = {
      ...valid,
      baseTools: false,
      webSearch: true,
      networkAccess: false,
      triggers: [{ type: "api" }, { type: "schedule", expression: "rate(1 hour)", prompt: "tick" }],
    };
    expect(cfg(full, false)).toEqual(full);
  });

  it("trims the name", () => {
    expect(cfg({ ...valid, name: "  bot  " }, false)?.name).toBe("bot");
  });

  it("rejects a missing required field", () => {
    expect(cfg({ name: "x", systemPrompt: "y" }, false)).toBeNull();
    expect(cfg({ name: "x", model: "haiku-4.5" }, false)).toBeNull();
  });

  it("rejects an unknown model", () => {
    expect(cfg({ ...valid, model: "gpt-9" }, false)).toBeNull();
  });

  it("accepts a valid networkMode and rejects an unknown one", () => {
    expect(cfg({ ...valid, networkMode: "isolated" }, false)?.networkMode).toBe("isolated");
    expect(cfg({ ...valid, networkMode: "public" }, false)?.networkMode).toBe("public");
    expect(cfg({ ...valid, networkMode: "vpc" }, false)).toBeNull();
    expect(cfg({ ...valid, networkMode: true }, false)).toBeNull();
  });

  it("rejects a blank/whitespace name", () => {
    expect(cfg({ ...valid, name: "   " }, false)).toBeNull();
    expect(cfg({ ...valid, name: "" }, false)).toBeNull();
  });

  it("allows an empty system prompt (empty string is valid)", () => {
    expect(cfg({ ...valid, systemPrompt: "" }, false)?.systemPrompt).toBe("");
  });

  it("rejects wrong types for flags", () => {
    expect(cfg({ ...valid, baseTools: "yes" }, false)).toBeNull();
    expect(cfg({ ...valid, webSearch: 1 }, false)).toBeNull();
    expect(cfg({ ...valid, networkAccess: null }, false)).toBeNull();
  });

  it("rejects an over-long name or system prompt (DoS/cost bound)", () => {
    expect(cfg({ ...valid, name: "x".repeat(201) }, false)).toBeNull();
    expect(cfg({ ...valid, systemPrompt: "x".repeat(20_001) }, false)).toBeNull();
    // At the bound is fine.
    expect(cfg({ ...valid, name: "x".repeat(200) }, false)).not.toBeNull();
    expect(cfg({ ...valid, systemPrompt: "x".repeat(20_000) }, false)).not.toBeNull();
  });

  it("rejects malformed triggers", () => {
    expect(cfg({ ...valid, triggers: "api" }, false)).toBeNull();
    expect(cfg({ ...valid, triggers: [{ type: "cron" }] }, false)).toBeNull();
  });

  it("rejects non-object bodies", () => {
    expect(cfg(null, false)).toBeNull();
    expect(cfg("string", false)).toBeNull();
    expect(cfg(42, false)).toBeNull();
    expect(cfg([valid], false)).toBeNull();
  });

  it("rejects a non-string name/systemPrompt", () => {
    expect(cfg({ ...valid, name: 5 }, false)).toBeNull();
    expect(cfg({ ...valid, systemPrompt: {} }, false)).toBeNull();
  });
});

describe("parseConfig - update (partial=true)", () => {
  it("accepts a single-field patch", () => {
    expect(cfg({ systemPrompt: "new" }, true)).toEqual({ systemPrompt: "new" });
  });

  it("accepts an empty patch", () => {
    expect(cfg({}, true)).toEqual({});
  });

  it("still validates present fields", () => {
    expect(cfg({ model: "nope" }, true)).toBeNull();
    expect(cfg({ baseTools: "true" }, true)).toBeNull();
  });

  it("does not require name/systemPrompt/model", () => {
    expect(cfg({ baseTools: true }, true)).toEqual({ baseTools: true });
  });
});

describe("validScheduleExpression", () => {
  it("accepts valid rates at/above the 5-minute floor", () => {
    expect(validScheduleExpression("rate(5 minutes)")).toBe(true);
    expect(validScheduleExpression("rate(1 hour)")).toBe(true);
    expect(validScheduleExpression("rate(1 day)")).toBe(true);
  });

  it("enforces AWS singular/plural (1 vs >1)", () => {
    expect(validScheduleExpression("rate(1 minute)")).toBe(false); // below floor anyway
    expect(validScheduleExpression("rate(5 minute)")).toBe(false); // must be plural
    expect(validScheduleExpression("rate(1 hours)")).toBe(false); // must be singular
  });

  it("rejects sub-floor and malformed rates", () => {
    expect(validScheduleExpression("rate(2 minutes)")).toBe(false); // below 5-min floor
    expect(validScheduleExpression("rate( )")).toBe(false);
    expect(validScheduleExpression("rate(0 minutes)")).toBe(false);
    expect(validScheduleExpression("hourly")).toBe(false);
  });

  it("accepts 6-field cron at/above the floor", () => {
    expect(validScheduleExpression("cron(0 9 * * ? *)")).toBe(true); // once/day
    expect(validScheduleExpression("cron(*/10 * * * ? *)")).toBe(true); // every 10 min
    expect(validScheduleExpression("cron(0,30 * * * ? *)")).toBe(true); // :00 and :30 → 30-min gap
    expect(validScheduleExpression("cron(0-55/5 * * * ? *)")).toBe(true); // every 5 min
  });

  it("rejects every sub-floor cron cadence, however expressed", () => {
    expect(validScheduleExpression("cron(* * * * ? *)")).toBe(false); // wildcard
    expect(validScheduleExpression("cron(*/2 * * * ? *)")).toBe(false); // sub-floor step
    expect(validScheduleExpression("cron(0-59 * * * ? *)")).toBe(false); // range → every min
    expect(validScheduleExpression("cron(0/1 * * * ? *)")).toBe(false); // increment → every min
    expect(validScheduleExpression("cron(0-59/1 * * * ? *)")).toBe(false); // range+step every min
    expect(validScheduleExpression("cron(0,1,2,3 9 * * ? *)")).toBe(false); // list → 1-min gaps
    expect(validScheduleExpression("cron(0,3 * * * ? *)")).toBe(false); // 3-min gap < floor
  });

  it("rejects malformed cron and wrong field counts", () => {
    expect(validScheduleExpression("cron(0 9 * * *)")).toBe(false); // 5 fields
    expect(validScheduleExpression("cron(bogus * * * ? *)")).toBe(false);
    expect(validScheduleExpression("cron(99 * * * ? *)")).toBe(false); // minute out of range
  });
});

describe("parseTriggers", () => {
  it("always includes exactly one api trigger", () => {
    expect(parseTriggers([])).toEqual([{ type: "api" }]);
    expect(parseTriggers([{ type: "api" }, { type: "api" }])).toEqual([{ type: "api" }]);
  });

  it("accepts a valid schedule and normalizes it", () => {
    expect(parseTriggers([{ type: "schedule", expression: " rate(1 hour) ", prompt: "go" }])).toEqual([
      { type: "api" },
      { type: "schedule", expression: "rate(1 hour)", prompt: "go" },
    ]);
  });

  it("carries an optional timezone", () => {
    const out = parseTriggers([
      { type: "schedule", expression: "cron(0 9 * * ? *)", prompt: "go", timezone: "Europe/Stockholm" },
    ]);
    expect(out?.[1]).toMatchObject({ timezone: "Europe/Stockholm" });
  });

  it("rejects a bad expression, missing prompt, or a second schedule", () => {
    expect(parseTriggers([{ type: "schedule", expression: "hourly", prompt: "go" }])).toBeNull();
    expect(parseTriggers([{ type: "schedule", expression: "rate(1 hour)", prompt: "" }])).toBeNull();
    expect(
      parseTriggers([
        { type: "schedule", expression: "rate(1 hour)", prompt: "a" },
        { type: "schedule", expression: "rate(2 hours)", prompt: "b" },
      ]),
    ).toBeNull();
  });

  it("rejects a non-array or unknown type", () => {
    expect(parseTriggers("api")).toBeNull();
    expect(parseTriggers([{ type: "slack" }])).toBeNull();
  });
});

describe("withDefaults", () => {
  it("fills defaults for optional fields", () => {
    expect(withDefaults(valid as never)).toEqual({
      ...valid,
      baseTools: true,
      webSearch: false,
      networkAccess: true,
      triggers: [{ type: "api" }],
    });
  });

  it("preserves explicitly-set false flags (not overwritten by defaults)", () => {
    const c = { ...valid, baseTools: false, networkAccess: false };
    const out = withDefaults(c as never);
    expect(out.baseTools).toBe(false);
    expect(out.networkAccess).toBe(false);
  });

  it("carries skillIds and env through when present (regression: dropped on create)", () => {
    const out = withDefaults({ ...valid, skillIds: ["s1"], env: { K: "v" } } as never);
    expect(out.skillIds).toEqual(["s1"]);
    expect(out.env).toEqual({ K: "v" });
  });

  it("omits skillIds/env when empty (keeps the stored config lean)", () => {
    const out = withDefaults({ ...valid, skillIds: [], env: {} } as never);
    expect(out.skillIds).toBeUndefined();
    expect(out.env).toBeUndefined();
  });
});

describe("parseSkillIds", () => {
  it("accepts a de-duped string array", () => {
    expect(parseSkillIds(["a", "b", "a"])).toEqual(["a", "b"]);
    expect(parseSkillIds([])).toEqual([]);
  });
  it("rejects non-arrays, non-string members, and over-cap arrays", () => {
    expect(parseSkillIds("a")).toBeNull();
    expect(parseSkillIds([1])).toBeNull();
    expect(parseSkillIds(Array.from({ length: 26 }, (_, i) => `s${i}`))).toBeNull();
  });
});

describe("parseEnv", () => {
  it("accepts a string→string map with POSIX-ish keys", () => {
    expect(parseEnv({ STRIPE_KEY: "sk_1", DB_URL: "postgres://x" })).toEqual({
      STRIPE_KEY: "sk_1",
      DB_URL: "postgres://x",
    });
    expect(parseEnv({})).toEqual({});
  });
  it("rejects bad keys, non-string values, arrays, and over-cap maps", () => {
    expect(parseEnv({ "1BAD": "x" })).toBeNull(); // leading digit
    expect(parseEnv({ "has-dash": "x" })).toBeNull(); // invalid char
    expect(parseEnv({ OK: 5 })).toBeNull(); // non-string value
    expect(parseEnv(["x"])).toBeNull();
    const big = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`K${i}`, "v"]));
    expect(parseEnv(big)).toBeNull();
  });
  it("rejects an over-long value", () => {
    expect(parseEnv({ K: "x".repeat(4097) })).toBeNull();
  });
});

describe("parseConfig - skills + env", () => {
  it("accepts and normalizes skillIds and env", () => {
    const out = cfg({ ...valid, skillIds: ["s1", "s1"], env: { API_KEY: "v" } }, false);
    expect(out?.skillIds).toEqual(["s1"]);
    expect(out?.env).toEqual({ API_KEY: "v" });
  });
  it("rejects a config with an invalid env key", () => {
    expect(cfg({ ...valid, env: { "bad key": "v" } }, false)).toBeNull();
  });
});

/**
 * A 400 has to be self-debuggable: `parseConfig` used to collapse ~15 distinct causes
 * into one bare `null`, so the route could only answer "invalid config" and the caller
 * was left guessing which field was wrong. Every message must name the field.
 */
describe("parseConfigDetailed reports WHICH field is wrong", () => {
  const errs = (body: unknown, partial = false) => {
    const r = parseConfigDetailed(body, partial);
    return r.ok ? [] : r.errors;
  };

  it("names each missing required field on create", () => {
    expect(errs({})).toEqual(
      expect.arrayContaining(["`name` is required", "`systemPrompt` is required", "`model` is required"]),
    );
  });

  it("lists the valid models when the model is wrong", () => {
    const [msg] = errs({ ...valid, model: "gpt-9" });
    expect(msg).toContain("`model`");
    expect(msg).toContain("haiku-4.5"); // the caller can see the real options
  });

  it("names the offending field for each type error", () => {
    expect(errs({ ...valid, baseTools: "yes" })).toEqual(["`baseTools` must be a boolean"]);
    expect(errs({ ...valid, networkMode: "vpc" })[0]).toContain("`networkMode`");
    expect(errs({ ...valid, skillIds: "abc" })[0]).toContain("`skillIds`");
    expect(errs({ ...valid, integrationIds: {} })[0]).toContain("`integrationIds`");
    expect(errs({ ...valid, env: [] })[0]).toContain("`env`");
  });

  it("explains the schedule rule, including the cadence floor", () => {
    const [msg] = errs({ ...valid, triggers: [{ type: "schedule", expression: "rate(1 minute)", prompt: "x" }] });
    expect(msg).toContain("`triggers`");
    expect(msg).toContain("5 minutes"); // the floor, not just "invalid"
  });

  it("reports EVERY problem at once, not just the first", () => {
    // One round-trip should be enough to fix the whole body.
    const e = errs({ name: "", model: "nope", baseTools: 1 });
    expect(e.length).toBeGreaterThanOrEqual(3);
  });

  it("says so plainly when the body isn't an object", () => {
    expect(errs(null)).toEqual(["body must be a JSON object"]);
    expect(errs("{}")).toEqual(["body must be a JSON object"]);
    expect(errs([])).toEqual(["body must be a JSON object"]);
  });

  it("reports a bad required field once, as invalid rather than missing", () => {
    // Sending `name: 123` is a type error, not an omission - saying both would confuse.
    const e = errs({ ...valid, name: 123 });
    expect(e).toEqual(["`name` must be a non-empty string"]);
  });
});
