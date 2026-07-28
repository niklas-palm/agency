/**
 * SKILL.md parsing + validation (dependency-free leaf module).
 *
 * A skill is authored as a single Markdown document in the standard SKILL.md
 * shape: YAML frontmatter with `name` + `description`, then a body with a title
 * and sections. The name/description are the source of truth IN the markdown -
 * we parse them out rather than asking for them separately. This mirrors the
 * format Strands' `Skill.fromContent` consumes, so the same doc the user writes
 * is what the runtime loads.
 *
 *   ---
 *   name: review
 *   description: Review a code change for real defects...
 *   ---
 *
 *   # Skill - review a change
 *   ## Overview
 *   ...
 */

/** Skill name rule (Strands' too): 1-64 chars, lowercase alphanumeric + hyphens. */
export const SKILL_NAME_RE = /^[a-z0-9-]{1,64}$/;
export const MAX_SKILL_DESCRIPTION = 1024;
export const MAX_SKILL_DOC = 50_000;

/** The outcome of parsing a SKILL.md doc: extracted fields + structural errors. */
export interface ParsedSkillDoc {
  name: string;
  description: string;
  /** Empty when the doc is a valid, standard SKILL.md; otherwise what's wrong. */
  errors: string[];
}

/**
 * Parse + validate a SKILL.md document. Extracts `name`/`description` from the
 * frontmatter and checks the standard structure (frontmatter fields, a title,
 * and at least one section). `errors` is empty iff the doc is valid.
 */
export function parseSkillDoc(doc: string): ParsedSkillDoc {
  const errors: string[] = [];
  if (doc.length > MAX_SKILL_DOC) errors.push(`skill exceeds ${MAX_SKILL_DOC} characters`);

  // Frontmatter: a leading `---` block. Tolerate a leading BOM/blank lines.
  const fm = doc.replace(/^﻿/, "").match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fm) {
    return {
      name: "",
      description: "",
      errors: ["missing YAML frontmatter (a `---` block with name + description at the top)"],
    };
  }
  const [, frontmatter, body] = fm;

  const name = frontmatterField(frontmatter!, "name");
  const description = frontmatterField(frontmatter!, "description");

  if (!name) errors.push("frontmatter is missing `name`");
  else if (!SKILL_NAME_RE.test(name)) errors.push("`name` must be 1-64 chars: lowercase letters, digits, hyphens");
  if (!description) errors.push("frontmatter is missing `description`");
  else if (description.length > MAX_SKILL_DESCRIPTION) errors.push(`description exceeds ${MAX_SKILL_DESCRIPTION} characters`);

  // Body structure: a title (H1) and at least one section (H2), so a skill is
  // instructions with shape, not a blob.
  const b = (body ?? "").trim();
  if (!/^#\s+\S/m.test(b)) errors.push("body needs a title (a `# ` heading)");
  if (!/^##\s+\S/m.test(b)) errors.push("body needs at least one section (a `## ` heading)");

  return { name: name ?? "", description: description ?? "", errors };
}

/**
 * Read one scalar frontmatter field. Handles `key: value` with optional single/
 * double quotes; ignores indented (nested) keys. Minimal on purpose - skills only
 * need name + description, both plain scalars.
 */
function frontmatterField(frontmatter: string, key: string): string {
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m || m[1] !== key) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v.trim();
  }
  return "";
}

/**
 * Ensure a skill's `content` is a full SKILL.md (frontmatter + body). Legacy
 * skills (created before the single-document format) stored the body ONLY, with
 * name/description in separate fields - so their `content` has no frontmatter and
 * the editor would show a doc missing its name/description block. This
 * reconstructs the frontmatter from the stored fields when it's absent. A pure,
 * read-time up-migration (mirrors normalizeConfig for agents); a no-op once
 * content already carries frontmatter, so new skills are untouched.
 */
export function ensureSkillFrontmatter(content: string, name: string, description: string): string {
  // Already has a leading `---` frontmatter block (tolerate BOM/leading blanks).
  if (/^\s*(﻿)?\s*---\r?\n/.test(content)) return content;
  const esc = (v: string) => (/[:#"']/.test(v) ? JSON.stringify(v) : v);
  return `---\nname: ${esc(name)}\ndescription: ${esc(description)}\n---\n\n${content}`;
}

/**
 * A ready-to-edit SKILL.md template showing the standard shape. The web editor
 * seeds a new skill with this so authors start from the format, not a blank page.
 */
export const SKILL_TEMPLATE = `---
name: my-skill
description: One sentence on what this skill does and when to use it.
---

# My skill

## Overview

One or two sentences on what this skill does and the outcome it produces.

## When to use

Describe the situations that should trigger this skill.

## Steps

1. First step.
2. Second step.

## Guidelines

- Rules, conventions, or constraints to follow.
- What "good" looks like.
`;
