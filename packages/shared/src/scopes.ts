/**
 * Authorization scopes - the single source of truth for what a credential is
 * allowed to do. A leaf module (no imports) so both `index.ts` and `openapi.ts`
 * can read it without an import cycle.
 *
 * ## The model
 *
 * Every authenticated request carries a set of granted scopes (on
 * `principal.scopes`). A route declares the scope it needs; the auth layer checks
 * membership. Scopes come from the caller's ORG ROLE, not the credential kind:
 *   - A JWT (interactive user or M2M) carries exactly `scopesForRole(role)`
 *     (org.ts) - a `viewer` JWT genuinely lacks `write`/`delete`. A JWT does NOT
 *     bypass scopes (that was the pre-org model, since removed).
 *   - A Personal Access Token carries (its minted scopes ∩ its role's scopes), so
 *     a token handed to a coding assistant can be least-privilege AND can never
 *     exceed the owner's role.
 * Scopes answer "can this caller write at all?"; the per-resource `canView`/
 * `canWrite` rules (authz.ts) answer "which resources?". See docs/auth.md.
 *
 * ## Extending
 *
 * To add a capability: add a scope here, then guard the relevant route with
 * `requireScope("<new>")` in the control-plane, and add it to the right arm of
 * `scopesForRole` (org.ts) so the intended roles carry it. If it's destructive/
 * privileged, leave it OUT of DEFAULT_SCOPES so a PAT must opt into it. Enforcement
 * is centralized. See docs/auth.md.
 */

/**
 * Every scope the platform understands. Add new capabilities here.
 *
 * These are resource-NEUTRAL capability TIERS, not per-resource scopes: each one
 * spans everything you own - agents, skills, integrations - because they're one
 * interdependent workspace (a token managing integrations manages the agents that
 * use them). Three tiers keep the PAT picker legible; only split out a new scope
 * when a real "these must be separable" need appears.
 *
 * The tiers are cumulative in destructiveness: read < write (author) < delete
 * (destroy), and each spans ALL THREE resources. The split is on that axis and
 * nothing else, so `delete` is the one scope left out of DEFAULT_SCOPES - a
 * day-to-day agentic token can author freely and destroy nothing. Why `delete`
 * isn't agent-specific (an integration's write-only `secret` makes it the least
 * recoverable delete we have): see docs/auth.md.
 */
export const SCOPES = {
  read: "Read your agents, skills, and integrations (config, metrics, trajectories).",
  write: "Create and update agents, skills, and integrations; rotate agent keys.",
  delete: "Permanently delete agents, skills, and integrations.",
} as const;

export type Scope = keyof typeof SCOPES;

/** All scopes, as an array. */
export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

/** Keep this the "safe to paste into a coding assistant" set - never add `delete`. */
export const DEFAULT_SCOPES: Scope[] = ["read", "write"];

/** Type guard: is a string one of our known scopes? Uses hasOwnProperty (not
 *  `in`) so prototype-chain names like "toString" or "__proto__" don't slip
 *  through the "reject unknown scopes" check. */
export function isScope(s: string): s is Scope {
  return Object.prototype.hasOwnProperty.call(SCOPES, s);
}
