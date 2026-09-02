/**
 * The palette is defined in CSS (`styles.css`) and consumed from three places -
 * Tailwind's color map, `TINT`, and `useTint()`. Nothing in the type system ties
 * those together, and a token missing from a theme block does NOT fail loudly: it
 * silently inherits `:root`'s value, which for a dark theme means near-black text
 * on a near-black card. So assert the palettes are complete, and that the default
 * carries every token the app can ask for.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, THEME_KEYS, resolveTheme } from "./theme.js";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

/** The tokens declared in a `:root {…}` / `[data-theme="x"] {…}` block. */
function tokensOf(selector: string): string[] {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} has no palette block in styles.css`).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf("\n  }", start));
  return [...block.matchAll(/--c-([a-z-]+):/g)].map((m) => m[1]!).sort();
}

describe("theme palettes", () => {
  const base = tokensOf(":root");

  it("the default palette defines every token the app reads", () => {
    // Kept as a literal list rather than derived from styles.css: this is the
    // contract tailwind.config.js + theme.ts rely on, so it should fail when a
    // token is REMOVED as loudly as when one is added.
    expect(base).toEqual(
      [
        "accent",
        "accent-hover",
        "accent-ink",
        "canvas",
        "clay",
        "clay-ink",
        "danger",
        "danger-ink",
        "faint",
        "fill",
        "ink",
        "line",
        "live",
        "live-ink",
        "muted",
        "on-accent",
        "on-strong",
        "raised",
        "surface",
        "warn",
      ].sort(),
    );
  });

  for (const theme of THEME_KEYS.filter((t) => t !== DEFAULT_THEME)) {
    it(`${theme} overrides every token (no silent fallback to the default)`, () => {
      expect(tokensOf(`[data-theme="${theme}"]`)).toEqual(base);
    });

    it(`${theme} declares a color-scheme and its own card shadow`, () => {
      const start = css.indexOf(`[data-theme="${theme}"] {`);
      const block = css.slice(start, css.indexOf("\n  }", start));
      expect(block).toMatch(/color-scheme:/);
      expect(block).toMatch(/--shadow-card:/);
    });
  }

  it("every selectable theme has a palette block", () => {
    // A THEMES entry with no CSS block would be offered in Settings and do nothing.
    for (const theme of THEME_KEYS) {
      if (theme === DEFAULT_THEME) continue;
      expect(css).toContain(`[data-theme="${theme}"] {`);
    }
  });
});

describe("resolveTheme", () => {
  it("keeps a known key", () => {
    for (const theme of THEME_KEYS) expect(resolveTheme(theme)).toBe(theme);
  });

  it("falls back to the default for anything else", () => {
    for (const raw of [null, undefined, "", "dracula", "AGENCY", "__proto__", "toString"]) {
      expect(resolveTheme(raw)).toBe(DEFAULT_THEME);
    }
  });
});
