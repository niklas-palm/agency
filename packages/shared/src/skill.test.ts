import { describe, it, expect } from "vitest";
import { buildSkill, ALL_SCOPES, MODEL_KEYS, parseSkillDoc } from "./index.js";

const skill = buildSkill("https://api.example.com/");

describe("coding-agent skill", () => {
  it("opens with SKILL.md YAML frontmatter (name + description)", () => {
    // The frontmatter is what a skill runtime reads to decide when to load this;
    // it must be the very first thing in the document.
    expect(skill.startsWith("---\n")).toBe(true);
    const fm = skill.slice(4, skill.indexOf("\n---", 4));
    expect(fm).toMatch(/^name:\s*agency\s*$/m);
    expect(fm).toMatch(/^description:\s*\S/m);
  });

  it("bakes in the given origin (trailing slash trimmed) on the spec URL", () => {
    expect(skill).toContain("https://api.example.com/openapi.json");
    expect(skill).not.toContain("example.com//openapi"); // no double slash
  });

  it("documents every scope (derived from the source of truth)", () => {
    for (const s of ALL_SCOPES) expect(skill).toContain(`\`${s}\``);
  });

  it("lists every model key", () => {
    for (const m of MODEL_KEYS) expect(skill).toContain(`\`${m}\``);
  });

  it("covers the core flows and both credential kinds", () => {
    for (const marker of [
      "agpat_", // PAT
      "ag_", // agent API key
      "/agents", // create/list/update/delete
      "/invoke",
      "/sessions/",
      "sessionId",
      "204", // delete
      "/skills", // skills are attachable config - an agent needs the recipe
      "/integrations",
    ]) {
      expect(skill, marker).toContain(marker);
    }
  });

  // Skills are the one surface where a plausible-looking request fails: the body is a
  // whole SKILL.md whose frontmatter is parsed, not {name, description} fields. If the
  // recipe's own example doesn't satisfy parseSkillDoc, an agent following it gets a
  // 400 on its first attempt - so validate the example against the real parser.
  it("shows SKILL.md payloads that the server would actually accept", () => {
    const bodies = [...skill.matchAll(/-d '(\{[\s\S]*?\})'/g)].map((m) => m[1]!);
    const docs = bodies
      .map((raw) => {
        try {
          return JSON.parse(raw) as { content?: unknown };
        } catch {
          return null; // not a JSON body (or contains shell-quoted oddities)
        }
      })
      .filter((b): b is { content: string } => typeof b?.content === "string");

    expect(docs.length, "the skill should show at least one SKILL.md payload").toBeGreaterThan(0);
    for (const { content } of docs) {
      expect(parseSkillDoc(content).errors).toEqual([]);
    }
  });

  it("warns that a skill create can 409 on a duplicate name", () => {
    // Names are unique per org, so an agent that retries a create with the same name
    // needs to know the 409 is the server refusing a rename, not a transient failure.
    expect(skill).toContain("409");
  });

  it("emits shell snippets that a shell can actually parse", () => {
    // The skill is served verbatim to coding agents, so a quoting slip ships a recipe
    // that dies with "unexpected EOF". A backslash-escaped apostrophe inside single
    // quotes is the trap: `\'` doesn't escape in sh - the quote just closes early.
    const md = buildSkill("https://api.example.com");
    for (const block of md.split("```").filter((_, i) => i % 2 === 1)) {
      const [lang = "", ...rest] = block.split("\n");
      if (!lang.startsWith("bash")) continue;
      const body = rest.join("\n");
      expect(body, "a backslash-escaped apostrophe inside single quotes").not.toMatch(/\\'/);
      // Balanced single quotes across the runnable lines. Checked per-snippet, not
      // per-line (a quoted JSON body legitimately spans lines), and with `#` comment
      // lines dropped - those are prose and may contain an apostrophe.
      const runnable = body
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .join("\n");
      const quotes = (runnable.match(/'/g) ?? []).length;
      expect(quotes % 2, `unbalanced single quotes in:\n${runnable}`).toBe(0);
    }
  });
});
