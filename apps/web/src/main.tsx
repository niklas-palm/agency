import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.js";
import { initTheme } from "./theme.js";

// index.html already set `data-theme` before first paint; this brings the rest of
// the theme's boot state (the theme-color meta) into line with it, and is the one
// place a saved theme still gets applied if that inline script couldn't run.
initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
