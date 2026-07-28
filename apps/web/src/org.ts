/**
 * Active-org state for the SPA. A user can belong to several orgs; one is "active"
 * at a time, and every management call carries it as the `X-Agency-Org` header
 * (validated server-side against membership). Persisted in localStorage so a
 * refresh keeps the selection. Mirrors auth.ts's localStorage pattern.
 *
 * The active org + the caller's role in it are surfaced app-wide via a React
 * context (App.tsx) loaded from `GET /me` on boot; this module is just the
 * persisted selection the api client reads when building headers.
 */
const ACTIVE_ORG_KEY = "ag_active_org";

/** The currently-selected org id, or null (→ the server defaults to personal). */
export function getActiveOrg(): string | null {
  try {
    return localStorage.getItem(ACTIVE_ORG_KEY);
  } catch {
    return null;
  }
}

/** Select an org (or clear the selection with null). */
export function setActiveOrg(orgId: string | null): void {
  try {
    if (orgId) localStorage.setItem(ACTIVE_ORG_KEY, orgId);
    else localStorage.removeItem(ACTIVE_ORG_KEY);
  } catch {
    /* ignore storage failures (private mode etc.) */
  }
}
