/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Deployed control-plane API base URL. Unset locally (uses the /api proxy). */
  readonly VITE_API_URL?: string;
  /**
   * Set to "true" ONLY for a local-dev build talking to an AUTH_DISABLED API. Absent
   * means auth is required - the safe default, so a forgotten variable can't ship a
   * login-free console.
   */
  readonly VITE_AUTH_DISABLED?: string;
  /** Cognito user pool id (for in-app SRP auth). */
  readonly VITE_COGNITO_USER_POOL_ID?: string;
  /** Cognito web app-client id. */
  readonly VITE_COGNITO_CLIENT_ID?: string;
  /**
   * Set ONLY by the PR-preview build (e.g. "PR #123"). Its presence is what makes the
   * console show the preview chip - a preview runs against the REAL API, so it must never
   * be mistakable for production. Never set for a production build.
   */
  readonly VITE_PREVIEW_LABEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
