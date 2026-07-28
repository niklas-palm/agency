import { describe, it, expect } from "vitest";
import { buildOpenApiSpec, MODEL_KEYS, TRAJECTORY_EVENT_TYPES } from "./index.js";

const spec = buildOpenApiSpec("https://api.example.com");

describe("OpenAPI spec", () => {
  it("is a 3.1 document with the server URL applied", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0]!.url).toBe("https://api.example.com");
  });

  it("documents every public endpoint (all resource families, not just agents)", () => {
    const paths = Object.keys(spec.paths);
    // Cover one path per family so dropping a whole surface (skills/integrations/
    // orgs/tokens/versions/metrics) from the spec is caught, not just agents.
    expect(paths).toEqual(
      expect.arrayContaining([
        "/agents",
        "/agents/{id}",
        "/agents/{id}/rotate-key",
        "/agents/{id}/invoke",
        "/agents/{id}/sessions/{sessionId}",
        "/agents/{id}/versions",
        "/agents/{id}/metrics",
        "/skills",
        "/skills/{id}",
        "/integrations",
        "/integrations/{id}",
        "/tokens",
        "/orgs",
        "/orgs/{id}/members",
        "/orgs/{id}/invites",
        "/me",
      ]),
    );
  });

  it("lists every model key in the config schema (kept in sync with MODELS)", () => {
    const modelEnum = spec.components.schemas.AgentConfigInput.properties.model.enum;
    expect([...modelEnum].sort()).toEqual([...MODEL_KEYS].sort());
  });

  it("every $ref resolves to a defined schema", () => {
    const schemas = spec.components.schemas as Record<string, unknown>;
    const refs = [...JSON.stringify(spec).matchAll(/"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]!);
    for (const name of refs) expect(schemas).toHaveProperty(name);
  });

  it("declares both auth schemes", () => {
    expect(spec.components.securitySchemes).toHaveProperty("accountToken");
    expect(spec.components.securitySchemes).toHaveProperty("agentKey");
  });

  it("requires model on create (the server has no default for it)", () => {
    expect(spec.components.schemas.AgentConfigInput.required).toContain("model");
  });

  it("marks all config fields required on the returned AgentConfig", () => {
    // The server fills defaults on create, so a returned config is always full -
    // a generated client shouldn't treat agent.config.model as possibly-undefined.
    expect([...spec.components.schemas.AgentConfig.required].sort()).toEqual(
      ["baseTools", "model", "name", "networkAccess", "systemPrompt", "triggers", "webSearch"].sort(),
    );
  });
});

// The spec is hand-authored, so it drifts from the server silently. These check the
// shapes of that drift rather than individual fields, so a NEW omission is caught too.
describe("OpenAPI spec does not drift from the server", () => {
  type Op = { security?: Record<string, unknown>[]; responses?: Record<string, unknown> };
  type PathItem = { parameters?: { name?: string }[] } & Record<string, unknown>;
  const paths = Object.entries(spec.paths as unknown as Record<string, PathItem>);
  const operations = paths.flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => method !== "parameters")
      .map(([method, op]) => ({ path, method, op: op as Op, item })),
  );

  it("never types a success response as the Error schema", () => {
    for (const { path, method, op } of operations) {
      for (const [code, res] of Object.entries(op.responses ?? {})) {
        if (!code.startsWith("2")) continue;
        const schema = (res as { content?: Record<string, { schema?: { $ref?: string } }> }).content?.[
          "application/json"
        ]?.schema;
        expect(schema?.$ref ?? "", `${method.toUpperCase()} ${path} ${code}`).not.toMatch(/\/Error$/);
      }
    }
  });

  it("declares every required field among its own properties", () => {
    // A `required` entry with no matching property makes a generated client demand a
    // field it can't describe - the symptom of a half-applied schema edit.
    type Schema = { type?: string; properties?: object; required?: readonly string[] };
    for (const [name, schema] of Object.entries(
      spec.components.schemas as unknown as Record<string, Schema>,
    )) {
      if (schema.type !== "object" || !schema.properties || !schema.required) continue;
      const declared = Object.keys(schema.properties);
      for (const field of schema.required) expect(declared, `${name}.${field}`).toContain(field);
    }
  });

  it("declares the X-Agency-Org header on every management path, and only there", () => {
    // It was prose-only, so a generated SDK had no way to select an org at all.
    for (const { path, method, op, item } of operations) {
      const usesAccountToken = (op.security ?? []).some((s) => "accountToken" in s);
      const declares = (item.parameters ?? []).some((p) => p.name === "X-Agency-Org");
      // An agent key already implies one agent in one org, so invoke/poll must not take it.
      expect(declares, `${method.toUpperCase()} ${path}`).toBe(usesAccountToken);
    }
  });

  it("derives the trajectory event enum from the runtime catalog", () => {
    // Restating the list is how `prompt` went missing from the spec for a while.
    expect([...spec.components.schemas.TrajectoryEvent.properties.type.enum]).toEqual([...TRAJECTORY_EVENT_TYPES]);
  });

  it("accepts the resource metadata the agent routes actually read", () => {
    // description/shared/managers are top-level body fields alongside the config, not
    // part of it - the spec described only the config, so clients couldn't set them.
    for (const schema of [spec.components.schemas.AgentConfigInput, spec.components.schemas.AgentConfigPatch]) {
      for (const field of ["description", "shared", "managers"]) {
        expect(Object.keys(schema.properties)).toContain(field);
      }
    }
    // ...but they are NOT versioned config, so they stay off the returned AgentConfig.
    for (const field of ["description", "shared", "managers"]) {
      expect(Object.keys(spec.components.schemas.AgentConfig.properties)).not.toContain(field);
    }
  });

  it("tells clients that every delete needs the `delete` scope", () => {
    // `delete` is the one scope a default token lacks, and it now covers all three
    // resources - so a client generated from the spec must not think a read+write
    // token can destroy a skill or an integration.
    for (const path of ["/agents/{id}", "/skills/{id}", "/integrations/{id}"]) {
      const op = (spec.paths as unknown as Record<string, { delete?: { description?: string } }>)[path]!.delete!;
      expect(op.description, path).toMatch(/`delete` scope/);
    }
  });

  it("documents the metrics fields the dashboard depends on", () => {
    for (const field of ["invocations", "toolBreakdown"]) {
      expect(spec.components.schemas.MetricsBucket.required).toContain(field);
    }
    expect(spec.components.schemas.MetricsSummary.required).toContain("invocations");
  });

  it("documents the managers cap on EVERY schema that carries the field", () => {
    // `managers` was defined verbatim in six places, so when the 50-id cap landed only
    // two schemas learned about it - and silent truncation is invisible to a generated
    // client. One shared definition now, and this asserts nothing drifts back.
    const schemas = (spec.components as { schemas: Record<string, {
      properties?: Record<string, { maxItems?: number; description?: string }>;
    }> }).schemas;
    const carriers = Object.entries(schemas).filter(([, s]) => s.properties?.managers);
    expect(carriers.length).toBeGreaterThan(4); // agents + skills + integrations, in/out
    for (const [name, schema] of carriers) {
      const m = schema.properties!.managers!;
      expect(m.maxItems, `${name}.managers must declare the cap`).toBe(50);
      expect(m.description, `${name}.managers must say the excess is dropped`).toMatch(/DROPPED/);
    }
  });
});
