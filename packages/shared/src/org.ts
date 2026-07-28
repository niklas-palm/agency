/**
 * Organization model - the top ownership hierarchy.
 *
 * Every resource (agent, skill, integration) lives in exactly one organization.
 * Every user has a personal org (auto-created, exactly one, non-deletable) and may
 * create team orgs and invite others. Membership carries a ROLE; the role determines
 * the resource-scope set the principal effectively holds (see `scopesForRole`), which
 * plugs into the existing `read`/`write`/`delete` scope machinery (scopes.ts).
 *
 * A leaf module (imports only scopes.ts) so both `index.ts` and `openapi.ts` can read
 * it without an import cycle. See docs/auth.md + docs/org-model.md.
 */
import { type Scope } from "./scopes.js";

/**
 * The three fixed roles a membership can hold. Fixed (not custom) so they map
 * cleanly to scope sets and the UI can enumerate them.
 *   - viewer: read-only. No create/edit/delete, no console run, no key rotation.
 *   - editor: read + write + delete (subject to the per-resource ownership rule -
 *     may only edit/delete resources they created; a co-member's shared resource is
 *     read-only to them unless they're an admin OR the creator listed them in the
 *     resource's `managers`).
 *   - admin:  editor's resource powers over ANY shared resource, plus member
 *     management, org config, and org deletion (those are JWT-only, role-gated).
 */
export const ROLES = {
  admin: "Full control: manage resources, members, and org settings.",
  editor: "Create and manage resources; cannot manage members or the org.",
  viewer: "Read-only: view everything shared, but create/change nothing.",
} as const;

export type Role = keyof typeof ROLES;

/** All roles, as an array (for enum generation + the invite UI). */
export const ALL_ROLES = Object.keys(ROLES) as Role[];

/** Type guard: is a string one of our known roles? */
export function isRole(s: string): s is Role {
  return Object.prototype.hasOwnProperty.call(ROLES, s);
}

/**
 * The resource-scope set a role grants. This is where roles meet the existing
 * scope model: a principal's EFFECTIVE scopes are this set, intersected (for a
 * PAT) with the token's own scopes. A JWT no longer bypasses scopes - it carries
 * exactly its role's set.
 *
 * NOTE: editor and admin share the SAME scope set (read+write+delete) - the scope
 * axis only separates viewer (read-only) from the rest. The editor-vs-admin
 * distinction lives elsewhere: per-resource `canWrite` (creator, admin, or a listed manager) and the
 * org-management routes' admin gate. So scopes give the coarse read/write cut (and
 * the PAT-narrowing story); roles refine writes on top.
 */
export function scopesForRole(role: Role): Scope[] {
  switch (role) {
    case "viewer":
      return ["read"];
    case "editor":
    case "admin":
      return ["read", "write", "delete"];
    default:
      // `role` comes from a DynamoDB row that's cast, not validated, so a legacy or
      // hand-edited membership can carry a string outside the union. TypeScript makes
      // this branch unreachable from CODE (adding a Role without a case is a compile
      // error), but it's reachable from DATA - and returning undefined there put
      // `undefined` in principal.scopes, which crashed hasScope with a 500. Fail
      // closed instead: no scopes, so every guarded route 403s.
      return [];
  }
}

/** An organization. `personal` orgs are auto-created per user and non-deletable. */
export interface Org {
  orgId: string;
  name: string;
  kind: "personal" | "team";
  /** userId of the creator (the sole admin of a personal org). */
  createdBy: string;
  createdAt: string;
}

/** A user's membership in an org, carrying their role there. */
export interface Membership {
  orgId: string;
  userId: string;
  role: Role;
  joinedAt: string;
  /**
   * The member's email, captured when the membership is created (invite-accept,
   * team-org create, or personal-org bootstrap), self-healed on auth from their OWN token
   * claim, and - for a member who has never signed in, so none of those fired -
   * backfilled from the identity store on a roster read. Lets the members roster +
   * the resource "managers" picker show a readable name instead of the opaque
   * Cognito sub. Optional: absent while unresolved (see docs/auth.md).
   */
  email?: string;
}

/** An org as seen by a member, with their own role attached (the `GET /me` shape). */
export interface OrgMembership {
  orgId: string;
  name: string;
  kind: "personal" | "team";
  role: Role;
}

/** A member of an org, for the members list + the resource "managers" picker.
 *  `email` is present when known (see `Membership.email` for how it gets there); the
 *  UI falls back to the userId when it isn't. */
export interface Member {
  userId: string;
  role: Role;
  joinedAt: string;
  email?: string;
}

/**
 * A pending invitation to join an org, tied to an EMAIL (not a user id) so it works
 * whether or not the invitee already has an account - matched against the JWT email
 * on accept. Deleted on accept/decline/rescind.
 */
export interface Invite {
  /** Lowercased invitee email (the table partition key). */
  email: string;
  orgId: string;
  /** Org name, denormalized so the invitee's inbox needn't join the orgs table. */
  orgName: string;
  role: Role;
  /** userId of the admin who sent it. */
  invitedBy: string;
  createdAt: string;
}

/** The `GET /me` bootstrap response: identity + org memberships + the active org. */
export interface Me {
  userId: string;
  email?: string;
  orgs: OrgMembership[];
  /** The org the request resolved as active (header, else personal). */
  activeOrgId: string;
}

// Org/member/invite request bodies are small + validated inline in the routes and
// described directly in the OpenAPI spec, so we don't mint TS interfaces for them
// (they'd only be a drift risk - see the review notes). The wire shapes: create org
// `{ name }`, invite `{ email, role }`, change member `{ role }`.
