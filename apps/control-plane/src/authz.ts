/**
 * Per-resource visibility + write authorization, in one place, so the rule is
 * uniform across agents/skills/integrations and can't drift per-route (the
 * open-coded `ownerId !== principal.id` checks that this replaces were a
 * cross-tenant-leak risk). See docs/auth.md + docs/org-model.md.
 *
 * The rules (locked decisions):
 *   - VISIBLE  = same org AND (shared OR createdBy === me). Admin does NOT pierce
 *     privacy (Q2): a co-member's private resource is invisible to everyone but
 *     its creator.
 *   - WRITABLE = visible AND (createdBy === me OR role === "admin" OR I'm in the
 *     resource's `managers` list) (Q3): a shared resource is editable by its
 *     creator, any org admin, or an explicitly-granted manager - a plain editor
 *     cannot edit a co-member's shared resource unless named a manager. The
 *     managers list only ever GRANTS; the creator + admins always retain control.
 *
 * A resource that fails VISIBLE returns 404 (never leak existence). A resource
 * that is visible but not WRITABLE returns 403 (you can see it, you just can't
 * change it - not a secrecy concern since you can already see it).
 */
import type { Principal } from "./auth.js";

/** The org-scoping fields every resource (agent/skill/integration) carries. */
export interface OrgOwned {
  orgId: string;
  createdBy: string;
  shared: boolean;
  /**
   * Extra org members (userIds) granted manage rights beyond creator + admins.
   * Optional; absent/empty means "creator + admins only". Only a manager of a
   * VISIBLE resource can write it (a private resource stays creator-only, since a
   * non-creator can't even see it to be listed here meaningfully).
   */
  managers?: string[];
}

/** Is a resource visible to a given creator? shared, or created by them. This is
 *  the principal-free core (used at invoke, where there's no principal - visibility
 *  is judged against the AGENT's creator). `canView` layers the org-match on top. */
export function visibleToCreator(r: OrgOwned, userId: string): boolean {
  return r.shared || r.createdBy === userId;
}

/** Can this principal SEE the resource? (Same org AND (shared OR their own).) */
export function canView(principal: Principal, r: OrgOwned): boolean {
  return r.orgId === principal.orgId && visibleToCreator(r, principal.userId);
}

/**
 * May this principal WRITE (edit/delete) the resource? Visible AND (creator OR
 * admin OR an explicitly-granted manager). The `managers` list only grants extra
 * people - the creator + admins always retain control.
 */
export function canWrite(principal: Principal, r: OrgOwned): boolean {
  return (
    canView(principal, r) &&
    (r.createdBy === principal.userId ||
      principal.role === "admin" ||
      (r.managers?.includes(principal.userId) ?? false))
  );
}

/**
 * Authorize a load: given a fetched (maybe-null) resource, return either the
 * NARROWED record or the HTTP status+message to return. Removes the load-then-
 * branch dance (and the `!` non-null assertions) every handler otherwise repeats.
 *   - `need: "view"`  → 404 if not visible.
 *   - `need: "write"` → 404 if not visible, 403 if visible-but-not-writable
 *     (deliberate: a co-member CAN see a shared resource, so hiding it as 404 would
 *     be misleading; but a private one they can't see stays 404 - no existence leak).
 */
export type Authorized<T> = { ok: true; record: T } | { ok: false; status: 404 | 403; error: string };

export function authorize<T extends OrgOwned>(
  principal: Principal,
  record: T | null,
  need: "view" | "write",
  forbiddenMsg = "you can't modify this shared resource",
): Authorized<T> {
  if (!record || !canView(principal, record)) return { ok: false, status: 404, error: "not found" };
  if (need === "write" && !canWrite(principal, record)) return { ok: false, status: 403, error: forbiddenMsg };
  return { ok: true, record };
}
