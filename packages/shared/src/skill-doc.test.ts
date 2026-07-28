import { describe, it, expect } from "vitest";
import { parseSkillDoc, ensureSkillFrontmatter, SKILL_TEMPLATE } from "./skill-doc.js";

/** The example the product treats as the standard SKILL.md shape. */
const VALID = `---
name: review
description: Review a code change for real defects, then report or fix them.
---

# Skill - review a change

## Overview
Run disciplined multi-role passes.

## Steps
1. Get the diff.
2. Review it.
`;

describe("parseSkillDoc", () => {
  it("parses name + description from frontmatter and accepts a standard doc", () => {
    const p = parseSkillDoc(VALID);
    expect(p.errors).toEqual([]);
    expect(p.name).toBe("review");
    expect(p.description).toBe("Review a code change for real defects, then report or fix them.");
  });

  it("accepts the shipped template", () => {
    // The template must itself be a valid skill (minus the untouched-guard the UI adds).
    expect(parseSkillDoc(SKILL_TEMPLATE).errors).toEqual([]);
  });

  it("strips surrounding quotes on frontmatter values", () => {
    const p = parseSkillDoc(`---\nname: "my-skill"\ndescription: 'Does a thing'\n---\n# T\n## S\nx`);
    expect(p.name).toBe("my-skill");
    expect(p.description).toBe("Does a thing");
    expect(p.errors).toEqual([]);
  });

  it("flags a missing frontmatter block", () => {
    const p = parseSkillDoc(`# Title\n## Section\nbody`);
    expect(p.errors.some((e) => /frontmatter/i.test(e))).toBe(true);
  });

  it("flags missing name / description", () => {
    expect(parseSkillDoc(`---\ndescription: d\n---\n# T\n## S\nx`).errors.some((e) => /name/.test(e))).toBe(true);
    expect(parseSkillDoc(`---\nname: n\n---\n# T\n## S\nx`).errors.some((e) => /description/.test(e))).toBe(true);
  });

  it("rejects a non-slug name", () => {
    expect(parseSkillDoc(`---\nname: Bad Name\ndescription: d\n---\n# T\n## S\nx`).errors.some((e) => /name/.test(e))).toBe(true);
  });

  it("requires a title and at least one section in the body", () => {
    const noTitle = parseSkillDoc(`---\nname: n\ndescription: d\n---\n## S\nx`);
    expect(noTitle.errors.some((e) => /title/.test(e))).toBe(true);
    const noSection = parseSkillDoc(`---\nname: n\ndescription: d\n---\n# T\njust prose`);
    expect(noSection.errors.some((e) => /section/.test(e))).toBe(true);
  });

  it("does not treat a `#` inside the frontmatter or a false H1 lookalike as the body title", () => {
    // `#comment` (no space) is not a heading; must still fail the title check.
    const p = parseSkillDoc(`---\nname: n\ndescription: d\n---\n#notatitle\n## S\nx`);
    expect(p.errors.some((e) => /title/.test(e))).toBe(true);
  });
});

describe("ensureSkillFrontmatter (legacy body-only migration)", () => {
  it("prepends reconstructed frontmatter when content has none (legacy skill)", () => {
    const body = "# Skill - review a change\n\n## Overview\nStuff.";
    const out = ensureSkillFrontmatter(body, "review", "Review a change.");
    expect(out.startsWith("---\nname: review\ndescription: Review a change.\n---\n\n")).toBe(true);
    // The reconstructed doc parses back to the original fields.
    const parsed = parseSkillDoc(out);
    expect(parsed.name).toBe("review");
    expect(parsed.description).toBe("Review a change.");
    expect(parsed.errors).toEqual([]);
  });

  it("is a no-op when content already carries frontmatter", () => {
    expect(ensureSkillFrontmatter(SKILL_TEMPLATE, "x", "y")).toBe(SKILL_TEMPLATE);
  });

  it("quotes a description containing colons/hashes so the frontmatter stays parseable", () => {
    const out = ensureSkillFrontmatter("# T\n\n## S\nx", "n", "Use for: X, Y #1");
    const parsed = parseSkillDoc(out);
    expect(parsed.description).toBe("Use for: X, Y #1");
    expect(parsed.errors).toEqual([]);
  });
});
