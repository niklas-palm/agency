/**
 * Local IdentityProvider: a no-op. Local dev runs against an AUTH_DISABLED API
 * with no Cognito pool, so there's no login to provision - the invite row alone
 * is enough. Always reports "exists" so the invite path proceeds without side effects.
 */
import type { IdentityProvider } from "./identity.js";

export class LocalIdentityProvider implements IdentityProvider {
  async ensureUser(): Promise<"created" | "exists"> {
    return "exists";
  }

  /** No identity store locally, so the roster falls back to the userId. */
  async emailFor(): Promise<string | undefined> {
    return undefined;
  }
}
