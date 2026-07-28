/**
 * Authentication + authorization for the management API, in the ORG model.
 *
 * Two credential kinds authenticate the same request context:
 *   1. A Cognito JWT (interactive user OR M2M client-credentials) - verified
 *      against the pool's JWKS with `jose`. The ACTIVE org rides the
 *      `X-Agency-Org` header and is VALIDATED against membership every request
 *      (a client-asserted org the user isn't in → 403 - the escalation guard).
 *      Absent header → the user's personal org.
 *   2. A Personal Access Token (`agpat_…`) - looked up by hash. It is bound to ONE
 *      org (chosen at mint). Its effective scopes are its stored scopes ∩ the
 *      owner's role in that org.
 *
 * Both resolve to a `Principal { userId, orgId, role, scopes, kind }`. A principal's
 * effective resource-scopes come from its ROLE (viewer→read; editor AND admin→
 * read+write+delete - they share a scope set), so a JWT no longer bypasses scopes -
 * it carries exactly its role's set. Routes declare a capability with
 * `requireScope("write")`; the editor-vs-admin distinction lives NOT in scopes but
 * in the per-resource `canWrite` (creator-or-admin, authz.ts) and in the org-mgmt
 * routes' `requireOrgRole("admin")` + `requireUser` (JWT-only). Enforcement is
 * centralized here. See docs/auth.md.
 *
 * Personal org bootstrap: a user's personal org id == their userId (deterministic,
 * so bootstrap is idempotent and lookup-free). The first time a user touches their
 * personal org, we create the org + an admin membership. Team orgs get minted ids.
 *
 * `AUTH_DISABLED` bypasses JWT verification for local dev only (fixed `local-dev`
 * user), but still runs org resolution so the local stack is a faithful replica.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import { scopesForRole, type Role, type Scope } from "@agency/shared";
import { COGNITO_ISSUER, API_SCOPE, AUTH_DISABLED } from "./config.js";
import { isAccessToken, hashAccessToken } from "./token.js";
import { getTokenByHash, touchToken } from "./repo/tokens.js";
import { getMembership, putMembership, setMembershipEmail } from "./repo/memberships.js";
import { getOrg, putOrg } from "./repo/orgs.js";

/** The authenticated principal we attach to the request context. */
export interface Principal {
  /** The human: JWT `sub` / M2M `client_id` / PAT owner. Drives `createdBy`. */
  userId: string;
  /** The ACTIVE org for this request. The tenant boundary for every resource. */
  orgId: string;
  /** The principal's role in `orgId`. */
  role: Role;
  /** Effective scopes = role's scopes ∩ (jwt ? role's scopes : token's scopes). */
  scopes: Scope[];
  /** How the caller authenticated - some routes are JWT-only (requireUser). */
  kind: "jwt" | "token";
  /** Verified email (JWT `email` claim), for matching email-keyed invites. */
  email?: string;
}

type Env = { Variables: { principal: Principal } };

/** The header carrying the client-asserted active org (validated vs membership). */
export const ORG_HEADER = "x-agency-org";

/** A personal org's id is deterministically the userId - so bootstrap is O(1). */
export function personalOrgId(userId: string): string {
  return userId;
}

/** Outcome of the pure JWT-identity check (before org resolution). */
export type IdentityDecision =
  | { ok: true; userId: string; email?: string }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Pure identity extraction from an already-signature-verified JWT payload: assert
 * it's an access token carrying the API scope, and pull the subject + email. Org +
 * role are resolved separately (they need a DB read). Extracted so it can be
 * unit-tested without jose/JWKS.
 */
export function authorizePayload(
  payload: Record<string, unknown>,
  requiredScope: string,
): IdentityDecision {
  // Defense in depth: require an access token specifically (an ID token carries
  // no `scope`, so it'd fail the next check anyway, but be explicit).
  if (payload.token_use !== undefined && payload.token_use !== "access") {
    return { ok: false, status: 403, error: "not an access token" };
  }
  const scopes = String(payload.scope ?? "").split(" ");
  if (!scopes.includes(requiredScope)) {
    return { ok: false, status: 403, error: "missing required scope" };
  }
  const userId = (payload.sub as string | undefined) ?? (payload.client_id as string | undefined);
  if (!userId) return { ok: false, status: 401, error: "token has no subject" };
  // NORMALIZE here, at the trust boundary. Invite rows are keyed by a lowercased
  // email, so a raw claim like `VICTIM@corp.com` would resolve the victim's invite
  // while membership is written under the CALLER's sub - an org takeover at the
  // invited role. Canonicalizing once means no downstream consumer can forget to.
  const raw = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : undefined;
  const email = raw || undefined;
  return { ok: true, userId, email };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(`${COGNITO_ISSUER}/.well-known/jwks.json`));
  return jwks;
}

/**
 * Resolve (and lazily bootstrap) the caller's membership in an org, returning the
 * role or null if they are not a member. When `requested` is the caller's personal
 * org (id == userId) and no membership exists yet, create the personal org + an
 * admin membership on the spot (idempotent) so a brand-new user "just works".
 */
async function resolveRole(
  userId: string,
  requested: string | undefined,
  email: string | undefined,
): Promise<{ orgId: string; role: Role } | null> {
  const orgId = requested && requested.length > 0 ? requested : personalOrgId(userId);
  const membership = await getMembership(orgId, userId);
  if (membership) {
    // Self-heal the email: back-fill it (or fix a stale one) whenever we learn it
    // from the token, so the members roster + managers picker show a readable name
    // even for memberships created before we captured email. Fire-and-forget, and a
    // narrow conditional write rather than a whole-item Put of the row read just
    // above: on THIS table a stale Put would revert a role change - or recreate a
    // membership a concurrent DELETE removed, restoring a removed member's access.
    // The window is short (no network call in it) but it isn't zero.
    if (email && membership.email !== email) {
      void setMembershipEmail(orgId, userId, email, "always").catch(() => {});
    }
    return { orgId, role: membership.role };
  }

  // No membership. Only auto-provision the caller's OWN personal org - never a
  // team org they merely asserted (that's the escalation guard: 403).
  if (orgId === personalOrgId(userId)) {
    const now = new Date().toISOString();
    // Create the org row if missing (idempotent - a racing request writes the same).
    if (!(await getOrg(orgId))) {
      const name = email ? email.split("@")[0]! : "Personal";
      await putOrg({ orgId, name: `${name} (personal)`, kind: "personal", createdBy: userId, createdAt: now });
    }
    await putMembership({ orgId, userId, role: "admin", joinedAt: now, ...(email ? { email } : {}) });
    return { orgId, role: "admin" };
  }
  return null; // asserted a team org they're not a member of
}

/**
 * Authenticate a Personal Access Token: look it up by hash, then resolve the
 * owner's role in the token's bound org. Returns null for an unknown/revoked token
 * OR an owner who has lost membership in the token's org (a dead token). Effective
 * scopes = the token's stored scopes ∩ the role's scopes. Bumps `lastUsedAt`.
 */
async function authenticateToken(presented: string): Promise<Principal | null> {
  const hash = hashAccessToken(presented);
  const record = await getTokenByHash(hash);
  if (!record) return null;
  const membership = await getMembership(record.orgId, record.ownerId);
  if (!membership) return null; // owner no longer in the token's org → token is dead
  void touchToken(hash).catch(() => {}); // fire-and-forget last-used telemetry
  const roleScopes = scopesForRole(membership.role);
  return {
    userId: record.ownerId,
    orgId: record.orgId,
    role: membership.role,
    // A PAT can only ever NARROW: the intersection of its scopes and the role's.
    scopes: roleScopes.filter((s) => record.scopes.includes(s)),
    kind: "token",
  };
}

/**
 * Hono middleware requiring a valid credential (JWT or PAT). Resolves the active
 * org + role and sets `c.var.principal`. Does NOT check scopes - chain
 * `requireScope(...)` / `requireUser` after it on routes that need them.
 */
export const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  if (AUTH_DISABLED) {
    // Local dev: fixed user, but still resolve/bootstrap the org so the local
    // stack behaves like prod (GET /me, org listing, etc. all work).
    const userId = "local-dev";
    const resolved = await resolveRole(userId, c.req.header(ORG_HEADER), "local-dev@example.com");
    if (!resolved) return c.json({ error: "not a member of that org" }, 403);
    c.set("principal", {
      userId,
      orgId: resolved.orgId,
      role: resolved.role,
      scopes: scopesForRole(resolved.role),
      kind: "jwt",
      email: "local-dev@example.com",
    });
    return next();
  }

  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return c.json({ error: "missing bearer token" }, 401);

  // A PAT is recognized by its prefix; anything else is treated as a JWT.
  if (isAccessToken(token)) {
    const principal = await authenticateToken(token);
    if (!principal) return c.json({ error: "invalid token" }, 401);
    c.set("principal", principal);
    return next();
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(), { issuer: COGNITO_ISSUER });
    const decision = authorizePayload(payload as Record<string, unknown>, API_SCOPE);
    if (!decision.ok) return c.json({ error: decision.error }, decision.status);
    const resolved = await resolveRole(decision.userId, c.req.header(ORG_HEADER), decision.email);
    if (!resolved) return c.json({ error: "not a member of that org" }, 403);
    c.set("principal", {
      userId: decision.userId,
      orgId: resolved.orgId,
      role: resolved.role,
      scopes: scopesForRole(resolved.role),
      kind: "jwt",
      email: decision.email,
    });
    return next();
  } catch {
    return c.json({ error: "invalid token" }, 401);
  }
};

/**
 * The one authority rule, in one place: does this principal hold `scope`? A JWT no
 * longer bypasses - every principal carries exactly its role's effective scope set
 * (a PAT further narrowed by its own scopes), so the check is a simple membership.
 */
export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.includes(scope);
}

/**
 * Middleware asserting the authenticated principal holds `scope`. Chains after
 * `requireAuth`. This is the resource-capability gate (viewer lacks write/delete).
 */
export function requireScope(scope: Scope): MiddlewareHandler<Env> {
  return async (c, next) => {
    // Fail CLOSED when there is no principal. `requireAuth` is attached per-path, so a route
    // added without its own `app.use` line reaches here with `principal` undefined - which used
    // to throw a TypeError and surface as a 500. A 500 is accidental safety: it depends on the
    // dereference, so any refactor of hasScope could silently turn it into an open route. This
    // makes the guard itself the boundary, and returns the answer that is actually true (401).
    if (!c.var.principal) return c.json({ error: "missing bearer token" }, 401);
    if (!hasScope(c.var.principal, scope)) {
      return c.json({ error: `your role lacks the required capability: ${scope}` }, 403);
    }
    return next();
  };
}

/**
 * Middleware requiring the principal authenticated via a JWT (not a PAT). Guards
 * token-management AND org-management routes: a leaked PAT must not be able to mint
 * more tokens, invite people, or delete an org.
 */
export const requireUser: MiddlewareHandler<Env> = async (c, next) => {
  if (c.var.principal.kind !== "jwt") {
    return c.json({ error: "this action requires an interactive login" }, 403);
  }
  return next();
};
