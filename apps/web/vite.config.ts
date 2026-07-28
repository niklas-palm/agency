import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The API base is injected at build/dev time. Locally it points at the
// docker-compose control-plane; in prod it's the deployed API URL.
export default defineConfig(({ mode }) => {
  // A production build must never carry the auth opt-out. `.env.development` is
  // dev-only so it can't leak, but a `.env` (gitignored - easy to create by copying
  // that file) WOULD load here, silently shipping a console that skips login.
  if (mode === "production" && loadEnv(mode, process.cwd(), "VITE_").VITE_AUTH_DISABLED === "true") {
    throw new Error(
      "VITE_AUTH_DISABLED=true in a production build: that ships a login-free console. " +
        "Unset it (check for a stray apps/web/.env).",
    );
  }
  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Proxy /api to the local control-plane so the SPA and API share an origin
      // in dev (no CORS config needed).
      proxy: {
        "/api": {
          target: "http://localhost:8787",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ""),
        },
      },
    },
  };
});
