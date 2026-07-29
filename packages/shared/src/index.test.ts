import { describe, it, expect } from "vitest";
import {
  MODELS,
  MODEL_KEYS,
  MODEL_INFO,
  MODEL_PRICING,
  costFor,
  tokenTotal,
  normalizeUsage,
  inputIncludesCacheRead,
  isModelAllowedInNetworkMode,
} from "./index.js";

describe("MODELS map integrity", () => {
  it("every model key has a MODEL_INFO + MODEL_PRICING entry (no map drifts out of sync)", () => {
    // MODEL_KEYS is derived from MODELS, so asserting they match is tautological.
    // The real invariant: the three parallel maps stay in lockstep - adding a model
    // to MODELS without a label/pricing entry (or vice-versa) is the regression.
    expect(Object.keys(MODEL_INFO).sort()).toEqual([...MODEL_KEYS].sort());
    expect(Object.keys(MODEL_PRICING).sort()).toEqual([...MODEL_KEYS].sort());
  });

  it("every model has a known provider and a non-empty id", () => {
    for (const key of MODEL_KEYS) {
      const spec = MODELS[key];
      expect(["bedrock", "openai"]).toContain(spec.provider);
      expect(spec.modelId.length).toBeGreaterThan(0);
    }
  });

  it("every Anthropic (bedrock) model uses the eu. cross-region inference-profile prefix", () => {
    // Load-bearing for eu-north-1: a `us.`-prefixed profile is invalid from the
    // eu-north-1 runtime and broke invocation before (see the region-move fix).
    for (const key of MODEL_KEYS) {
      if (MODELS[key].provider === "bedrock") {
        expect(MODELS[key].modelId.startsWith("eu.")).toBe(true);
      }
    }
  });

  it("OpenAI (Mantle) ids omit the classic version suffix", () => {
    // The `-1:0` suffix 404s on the Mantle endpoint - guard against reintroducing it.
    for (const key of MODEL_KEYS) {
      if (MODELS[key].provider === "openai") {
        expect(MODELS[key].modelId).not.toMatch(/-\d+:\d+$/);
      }
    }
  });

  it("has at least one model per provider", () => {
    const providers = MODEL_KEYS.map((k) => MODELS[k].provider);
    expect(providers).toContain("bedrock");
    expect(providers).toContain("openai");
  });
});

describe("isModelAllowedInNetworkMode", () => {
  const anthropic = MODEL_KEYS.find((k) => MODELS[k].provider === "bedrock")!;
  const openai = MODEL_KEYS.find((k) => MODELS[k].provider === "openai")!;

  it("allows any model in public mode (or when unset → public)", () => {
    expect(isModelAllowedInNetworkMode(anthropic, "public")).toBe(true);
    expect(isModelAllowedInNetworkMode(openai, "public")).toBe(true);
    expect(isModelAllowedInNetworkMode(openai, undefined)).toBe(true);
  });

  it("blocks OpenAI in isolated mode but allows Anthropic (Mantle needs egress)", () => {
    expect(isModelAllowedInNetworkMode(openai, "isolated")).toBe(false);
    expect(isModelAllowedInNetworkMode(anthropic, "isolated")).toBe(true);
  });
});

describe("costFor", () => {
  const tokens = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const priced = MODEL_KEYS[0]!;

  it("prices a known model at its own input rate", () => {
    expect(costFor(priced, tokens)).toBeCloseTo(MODEL_PRICING[priced].inputPerMTok);
  });

  it("is 0 for an unknown or missing model, never NaN", () => {
    // A legacy session row carries no model, and cost is summed across a window - one
    // NaN would turn the whole dashboard's cost into NaN.
    expect(costFor("", tokens)).toBe(0);
    expect(costFor("no-such-model", tokens)).toBe(0);
  });

  it("is 0 for a non-numeric or partial token bundle, never NaN", () => {
    // The bundle comes from a self-reported session summary. NaN doesn't stay local: it
    // sums into the window total and every percentile, and JSON renders it as `null`, so
    // one bad row used to blank the whole dashboard's cost.
    const bad = { inputTokens: "abc" } as unknown as Parameters<typeof costFor>[1];
    expect(costFor(priced, bad)).toBe(0);
    expect(costFor(priced, {} as Parameters<typeof costFor>[1])).toBe(0);
    expect(costFor(priced, undefined)).toBe(0);
    // A partial bundle prices the fields it DOES carry.
    expect(costFor(priced, { inputTokens: 1_000_000 } as Parameters<typeof costFor>[1]))
      .toBeCloseTo(MODEL_PRICING[priced].inputPerMTok);
  });

  it("is 0 for an Object.prototype key, never NaN", () => {
    // `model` comes from a self-reported session summary, so a value like "constructor"
    // is reachable; a bare index lookup would resolve a prototype member.
    for (const key of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(costFor(key, tokens)).toBe(0);
    }
  });
});

describe("normalizeUsage - the two providers' cache conventions", () => {
  const openaiModel = MODEL_KEYS.find((k) => MODELS[k].provider === "openai")!;
  const bedrockModel = MODEL_KEYS.find((k) => MODELS[k].provider === "bedrock")!;

  it("subtracts cache reads from input for a provider that counts them inside it", () => {
    // Numbers are AWS's own documented Mantle/Responses cache-hit example (Bedrock
    // user guide, "Cache Management for Models from OpenAI"): `input_tokens: 2048,
    // output_tokens: 256, total_tokens: 2304, input_tokens_details.cached_tokens: 1920`.
    // The cached tokens are a SUBSET of input - the provider's own total is input +
    // output, with the 1920 already inside input. Strands maps `cached_tokens` onto the
    // same cacheRead field the Bedrock adapter uses, where the drivers are disjoint.
    // Un-normalized, this bundle used to be summed AND charged twice: once at the input
    // rate, again at the cache-read rate.
    const raw = { inputTokens: 2048, outputTokens: 256, cacheReadTokens: 1920, cacheWriteTokens: 0 };
    const t = normalizeUsage(openaiModel, raw);

    expect(inputIncludesCacheRead(openaiModel)).toBe(true);
    expect(t.inputTokens).toBe(128); // 2048 - 1920 served from cache
    expect(tokenTotal(t)).toBe(2304); // == the provider's own total_tokens
    const p = MODEL_PRICING[openaiModel];
    expect(costFor(openaiModel, t)).toBeCloseTo((128 * p.inputPerMTok + 256 * p.outputPerMTok + 1920 * p.cacheReadPerMTok) / 1e6);
  });

  it("leaves a Bedrock row alone - its drivers are already disjoint", () => {
    // Verified against the wire in eu-north-1: a Converse call with a cache point
    // returned `{ inputTokens: 13, cacheReadInputTokens: 6002, totalTokens: 6019 }`,
    // i.e. total = input + output + cache. Subtracting here would be the mirror-image
    // bug - cacheRead exceeds inputTokens on a real row, so it would zero the input.
    const raw = { inputTokens: 13, outputTokens: 4, cacheReadTokens: 6002, cacheWriteTokens: 0 };
    const t = normalizeUsage(bedrockModel, raw);

    expect(inputIncludesCacheRead(bedrockModel)).toBe(false);
    expect(t).toEqual(raw);
    expect(tokenTotal(t)).toBe(6019); // == the provider's own totalTokens
  });

  it("treats an unknown or legacy model as disjoint, and never returns a negative", () => {
    const raw = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 500, cacheWriteTokens: 0 };
    expect(inputIncludesCacheRead("no-such-model")).toBe(false);
    expect(normalizeUsage("", raw).inputTokens).toBe(10);
    // A self-reported OpenAI row could claim more cache reads than input tokens; the
    // window's input total must not go negative because of one bad row.
    expect(normalizeUsage(openaiModel, raw).inputTokens).toBe(0);
  });

  it("coerces a partial or non-numeric bundle to zeros, never NaN", () => {
    // Same guarantee the old inline coercion gave both read paths: one NaN propagates
    // into every total, percentile and bucket, and JSON renders it as `null`.
    const bad = { inputTokens: "abc", cacheReadTokens: null } as unknown as Parameters<typeof normalizeUsage>[1];
    expect(normalizeUsage(openaiModel, bad)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(tokenTotal(normalizeUsage(openaiModel, undefined))).toBe(0);
  });
});
