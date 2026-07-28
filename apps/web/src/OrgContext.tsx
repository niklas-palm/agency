/**
 * App-wide org state: the caller's org memberships, the active org, and their
 * ROLE in it - loaded once from `GET /me` on boot and exposed via context so every
 * view + the TopBar can gate on the role and show the org switcher. Switching org
 * persists the selection (org.ts), then reloads /me and bumps a nonce so views
 * re-fetch under the new org.
 *
 * Role gating: `can(action)` centralizes the UI-side checks that mirror the
 * server's authority rules (viewer read-only; editor/admin write; admin manages
 * the org). The server is the source of truth - this only hides affordances a
 * role can't use, so a viewer never sees a Create button that would 403.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Me, OrgMembership, Role } from "@agency/shared";
import { getMe } from "./api.js";
import { getActiveOrg, setActiveOrg } from "./org.js";

interface OrgState {
  me: Me | null;
  orgs: OrgMembership[];
  activeOrgId: string | null;
  /** The caller's role in the active org (null until /me loads). */
  role: Role | null;
  /** Re-fetch /me (after creating/joining an org, or a role change). */
  reload: () => Promise<void>;
  /** Switch the active org: persist, reload, and bump the nonce for re-fetch. */
  switchOrg: (orgId: string) => Promise<void>;
  /** Bumped on switch/reload so data views can key off it to re-fetch. */
  nonce: number;
  /**
   * Set when /me couldn't be loaded. Without this the failure is invisible AND
   * consequential: no `me` means no `role`, and `useCan` reads a null role as
   * "cannot write" - so a transient 500 renders a fully-drawn console with every
   * create/edit/share control missing and no hint why. The shell shows a retry.
   */
  loadError: string;
}

const Ctx = createContext<OrgState | null>(null);

export function OrgProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [nonce, setNonce] = useState(0);
  const [loadError, setLoadError] = useState("");

  async function load() {
    const m = await getMe();
    setMe(m);
    setLoadError("");
    // Keep the persisted selection in sync with what the server resolved (e.g. if
    // the stored org is one the user is no longer in, /me falls back to personal).
    setActiveOrg(m.activeOrgId);
  }

  // Re-fetch /me and bump the nonce so data views re-fetch under the (maybe new) org.
  async function reload() {
    await load();
    setNonce((n) => n + 1);
  }

  useEffect(() => {
    void load().catch((e) => {
      console.error("failed to load /me", e);
      setLoadError(String(e));
    });
  }, []);

  const role = me?.orgs.find((o) => o.orgId === me.activeOrgId)?.role ?? null;

  const value: OrgState = {
    me,
    orgs: me?.orgs ?? [],
    activeOrgId: me?.activeOrgId ?? null,
    role,
    reload,
    switchOrg: async (orgId: string) => {
      const prev = getActiveOrg();
      setActiveOrg(orgId);
      try {
        await reload();
      } catch (e) {
        // The target org rejected (e.g. removed between /me and the click): revert
        // the selection so we don't persist a wedging org, then re-throw.
        setActiveOrg(prev);
        throw e;
      }
    },
    nonce,
    loadError,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOrg(): OrgState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useOrg must be used within an OrgProvider");
  return ctx;
}

/**
 * UI capability checks derived from the active-org role (mirror the server; the
 * server is the source of truth - these only hide affordances a role can't use).
 */
export function useCan() {
  const { role, me } = useOrg();
  const write = role === "editor" || role === "admin";
  return {
    /** Create resources + run agents + rotate the API key (editor + admin; viewer is read-only). */
    write,
    /** Manage the org: invite/remove members, roles, org config. */
    manageOrg: role === "admin",
    /**
     * May the caller edit/delete THIS resource? Mirrors the server's `canWrite`:
     * write capability AND (they created it OR they're an admin OR they're a listed
     * manager). So a non-admin editor can't modify a co-member's shared resource
     * unless its creator named them a manager.
     */
    canManage: (resource: { createdBy: string; managers?: string[] }) =>
      write &&
      (resource.createdBy === me?.userId ||
        role === "admin" ||
        (me?.userId != null && (resource.managers?.includes(me.userId) ?? false))),
    /**
     * May the caller change THIS resource's managers list? Only its creator or an
     * admin (a granted manager can edit content but not re-delegate the grant -
     * mirrors the server's patchManagers gate). `undefined` createdBy = a not-yet-
     * created resource, where the caller IS the creator-to-be → true.
     */
    canEditManagers: (resource: { createdBy?: string }) =>
      write && (resource.createdBy === undefined || resource.createdBy === me?.userId || role === "admin"),
  };
}
