/**
 * Agency design system — "Studio".
 *
 * A premium instrument that happens to run a fleet of agents. The old console was
 * correct but timid and read as generated (Inter + one indigo, tidy grey rows).
 * Studio keeps the calm, precise bones but earns novelty the warm way: a confident
 * cream/marigold/pine palette and generous whitespace as structure. Type is kept
 * SIMPLE — Hanken Grotesk (a clean, warm humanist sans) for both headings and body;
 * IBM Plex Mono for machine data; and a restrained serif (Fraunces) reserved ONLY
 * for the small editorial eyebrows — one quiet wink, never headlines. Color always
 * means something.
 *
 * Every color here resolves to a CSS custom property, so a THEME can repaint the
 * whole console by redefining ~20 variables (`src/styles.css` holds the palettes,
 * `src/theme.ts` the switcher). Hence the SEMANTIC names — `accent`, not `amber`:
 * the default theme's accent is marigold, Catppuccin's is mauve. Values are
 * space-separated channels so Tailwind's `/opacity` modifiers keep working.
 */
/** A palette token: `bg-accent`, `text-muted/60`, … all read from `--c-<token>`. */
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Headings + body share one clean sans; `display` aliases it so existing
        // `font-display` usages stay simple (no serif in headlines).
        display: ["Hanken Grotesk", "ui-sans-serif", "system-ui", "sans-serif"],
        sans: ["Hanken Grotesk", "ui-sans-serif", "system-ui", "sans-serif"],
        // The lone editorial flourish — used only on eyebrows/labels.
        serif: ["Fraunces", "ui-serif", "Georgia", "serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        // Paper spine — page, panels, recessed fills.
        canvas: token("canvas"), // page
        surface: token("surface"), // cards / panels
        raised: token("raised"), // recessed / lifted inner fills
        ink: token("ink"), // primary text
        muted: token("muted"), // secondary text (AA on canvas)
        faint: token("faint"), // tertiary / placeholders / hairline icons
        line: token("line"), // hairline borders
        fill: token("fill"), // chips, skeletons, recessed fills
        // The signature. `accent` for fills and marks; `accent-hover` for the
        // hover/pressed fill; `accent-ink` for small text/marks that need AA.
        accent: token("accent"),
        "accent-hover": token("accent-hover"),
        "accent-ink": token("accent-ink"),
        // Alive — the "running / healthy / shared" hue. `-ink` is the text-safe tone.
        live: token("live"),
        "live-ink": token("live-ink"),
        // A second warm hue, for the two vendor marks and code-sample numbers.
        clay: token("clay"),
        "clay-ink": token("clay-ink"),
        // Status hues, used sparingly.
        warn: token("warn"),
        danger: token("danger"),
        "danger-ink": token("danger-ink"),
        // Text/iconography ON a filled surface: `on-accent` sits on `accent`,
        // `on-strong` on a deep `*-ink` fill. (In a dark theme every saturated
        // tone is light, so both resolve to the same near-black.)
        "on-accent": token("on-accent"),
        "on-strong": token("on-strong"),
      },
      boxShadow: {
        // A soft lift for the primary surface — paper on paper, not a hard drop.
        // Per-theme: a dark palette needs a heavier, blacker shadow to read at all.
        card: "var(--shadow-card)",
      },
    },
  },
  plugins: [],
};
