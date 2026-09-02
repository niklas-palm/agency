/**
 * Themes.
 *
 * A theme here is COLOR ONLY - one flat palette of ~20 tokens, defined as CSS
 * custom properties in `styles.css`. So switching is a single attribute write on
 * <html> and the whole console repaints: no per-theme classNames, no component
 * re-render, and adding a theme is one CSS block plus one entry in THEMES.
 *
 * The choice is per-BROWSER (localStorage), not per-account: it needs no endpoint,
 * no stored record and no round-trip before the first paint, and a console
 * preference doesn't have to follow you between machines. `index.html` applies the
 * saved key before first paint so a dark theme doesn't flash the cream default.
 */
import { useMemo, useSyncExternalStore } from "react";

/** The selectable themes. The key is what lands in localStorage + `data-theme`. */
export const THEMES = {
  agency: {
    label: "Agency",
    blurb: "The default: warm cream paper, marigold, pine.",
  },
  catppuccin: {
    label: "Catppuccin",
    blurb: "Mocha - soft dark mauve, lavender and peach.",
  },
  gruvbox: {
    label: "Gruvbox",
    blurb: "Dark medium - retro warm, high contrast.",
  },
} as const;

export type ThemeKey = keyof typeof THEMES;
export const THEME_KEYS = Object.keys(THEMES) as ThemeKey[];
export const DEFAULT_THEME: ThemeKey = "agency";

/** Shared by `index.html`'s pre-paint script - change both together. */
const STORAGE_KEY = "agency.theme";

/**
 * A stored/user-supplied value → a theme we actually have. Anything unknown (an
 * older key, a hand-edited value) resolves to the default rather than leaving the
 * console unstyled. Membership is checked against the key LIST, not with `in`:
 * `"__proto__" in THEMES` is true, and that would sail through as a theme.
 */
export function resolveTheme(raw: string | null | undefined): ThemeKey {
  return raw && (THEME_KEYS as string[]).includes(raw) ? (raw as ThemeKey) : DEFAULT_THEME;
}

/**
 * Paint a theme. Setting the attribute is the whole switch; the meta tag keeps
 * mobile browser chrome in step with the page color.
 */
export function applyTheme(theme: ThemeKey): void {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", readVar("canvas"));
}

// ── The store ───────────────────────────────────────────────────────────────────
// Deliberately not a React context: the theme is read by two components (the
// picker and the charts) but applied to the document, so a provider around the
// tree would buy nothing. `useSyncExternalStore` also keeps it available to the
// signed-out landing/login screens, which mount no providers.

let current: ThemeKey | undefined;
const listeners = new Set<() => void>();

function readStored(): ThemeKey {
  try {
    return resolveTheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_THEME; // storage disabled (private mode) - not worth failing over
  }
}

function getTheme(): ThemeKey {
  return (current ??= readStored());
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Switch theme: paint it, remember it, then wake the subscribers. */
export function setTheme(theme: ThemeKey): void {
  current = theme;
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Non-fatal: the theme still applies for this session.
  }
  for (const l of [...listeners]) l();
}

/** Apply the remembered theme. Called once at boot (`main.tsx`). */
export function initTheme(): void {
  applyTheme(getTheme());
}

export function useTheme(): { theme: ThemeKey; setTheme: (t: ThemeKey) => void } {
  const theme = useSyncExternalStore(subscribe, getTheme, () => DEFAULT_THEME);
  return { theme, setTheme };
}

// ── Palette tokens for JS ───────────────────────────────────────────────────────

/** Every palette token, as `camelName → CSS custom-property suffix`. */
const TOKENS = {
  canvas: "canvas",
  surface: "surface",
  raised: "raised",
  ink: "ink",
  muted: "muted",
  faint: "faint",
  line: "line",
  fill: "fill",
  accent: "accent",
  accentHover: "accent-hover",
  accentInk: "accent-ink",
  live: "live",
  liveInk: "live-ink",
  clay: "clay",
  clayInk: "clay-ink",
  warn: "warn",
  danger: "danger",
  dangerInk: "danger-ink",
  onAccent: "on-accent",
  onStrong: "on-strong",
} as const;

export type TintName = keyof typeof TOKENS;
export type Tints = Record<TintName, string>;

/**
 * The palette as CSS colors, for dynamic per-datum coloring Tailwind can't express
 * as a static class (trace rails, status dots, vendor marks). These are `var()`
 * references, so they follow the theme with no re-render - valid in a `style` prop
 * or any CSS property.
 */
export const TINT = Object.fromEntries(
  Object.entries(TOKENS).map(([name, token]) => [name, `rgb(var(--c-${token}))`]),
) as Tints;

/** A token at partial opacity - for tint fills and hairlines: `tintAlpha("danger", 0.08)`. */
export function tintAlpha(name: TintName, alpha: number): string {
  return `rgb(var(--c-${TOKENS[name]}) / ${alpha})`;
}

/**
 * The palette as RESOLVED color values, recomputed when the theme changes.
 *
 * Needed only where a color becomes an SVG *presentation attribute* rather than a
 * CSS declaration - `stroke`/`fill`/`stopColor` on the recharts primitives - since
 * `var()` is not substituted in attribute values, so `TINT` would render as no
 * color at all. Everything else should use `TINT`.
 */
export function useTint(): Tints {
  const { theme } = useTheme();
  return useMemo(
    () =>
      Object.fromEntries(
        Object.keys(TOKENS).map((name) => [name, readVar(TOKENS[name as TintName])]),
      ) as Tints,
    [theme],
  );
}

/** One palette token's resolved value, e.g. `rgb(250 248 244)`. */
function readVar(token: string): string {
  return `rgb(${getComputedStyle(document.documentElement).getPropertyValue(`--c-${token}`).trim()})`;
}
