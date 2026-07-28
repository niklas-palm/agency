/**
 * IdentityProvider seam: the identity store. Two operations, both of which need the
 * Cognito pool that only prod has - so the seam keeps that dependency out of the
 * routes (mirrors the AgentInvoker / ScheduleProvisioner seams).
 *
 * - `ensureUser(email)` lazily provisions a login, called from the invite path so
 *   inviting someone with no account creates one (and Cognito emails them a temp
 *   password), while inviting an existing user is a harmless no-op.
 * - `emailFor(userId)` resolves a userId back to an email, called from the members
 *   roster so it can show a readable name.
 *
 * Prod is Cognito (AdminCreateUser / AdminGetUser - see cognito.ts); local is a
 * no-op, since auth is disabled locally so there's no pool and invites are accepted
 * directly.
 */
export interface IdentityProvider {
  /**
   * Ensure a login exists for `email`. Returns "created" when a new user was
   * provisioned (Cognito sent the invite email), "exists" when one was already
   * there (nothing sent). Never throws for the already-exists case - inviting an
   * existing user must succeed.
   */
  ensureUser(email: string): Promise<"created" | "exists">;

  /**
   * The verified email for a userId, or undefined if unknown. Resolves rather than
   * throws: a name is cosmetic and must never fail a roster read. See docs/auth.md
   * for why a membership row's cached email can be absent.
   */
  emailFor(userId: string): Promise<string | undefined>;
}
