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
 */
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
        // Warm paper spine — cream, never cold white.
        canvas: "#FAF8F4", // page
        surface: "#FFFDFA", // cards / panels (warm white)
        raised: "#F5F1E8", // recessed / lifted inner fills
        ink: "#1A1714", // primary text (warm near-black)
        muted: "#6E655A", // secondary text (AA on canvas)
        faint: "#A79E90", // tertiary / placeholders / hairline icons
        line: "#E6DFD2", // hairline borders (warm)
        fill: "#F1EBDF", // chips, skeletons, recessed fills
        // The signature — marigold. `amber` for fills/marks (dark ink sits on it);
        // `amber-deep` for hover/pressed and for small text/marks that need AA.
        amber: "#E8A33D",
        "amber-deep": "#B4741A",
        // Alive — pine green. Text-safe on cream; also a confident fill.
        pine: "#21584A",
        "pine-deep": "#163F34",
        // Warm status hues, used sparingly.
        danger: "#B23A2E",
        "danger-ink": "#9A2F26",
      },
      boxShadow: {
        // A soft warm lift for the primary surface — paper on paper, not a hard drop.
        card: "0 1px 2px rgba(26,23,20,0.04), 0 8px 24px -12px rgba(26,23,20,0.10)",
      },
    },
  },
  plugins: [],
};
