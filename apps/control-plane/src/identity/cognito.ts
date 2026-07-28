/**
 * Cognito IdentityProvider (prod). Two calls: AdminGetUser resolves a userId to an
 * email for the members roster, and AdminCreateUser provisions a login so an
 * invited email that has no account gets one - Cognito sends the temp-password
 * invite email (the custom template from the auth stack) and the user is in
 * FORCE_CHANGE_PASSWORD state, so their first sign-in makes them set a password.
 *
 * Idempotent by design: AdminCreateUser throws UsernameExistsException when the
 * email already has a login, which we swallow and report as "exists" (no second
 * email, no duplicate). So inviting a brand-new email creates + emails them;
 * inviting someone who already has an account just proceeds to the invite row.
 * The email is marked verified so the user can immediately use forgot-password
 * and so `GET /invites` (matched by the verified email claim) surfaces the invite.
 */
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import type { IdentityProvider } from "./identity.js";
import { REGION } from "../config.js";

export class CognitoIdentityProvider implements IdentityProvider {
  private readonly client: CognitoIdentityProviderClient;

  constructor(private readonly userPoolId: string) {
    this.client = new CognitoIdentityProviderClient({ region: REGION });
  }

  async ensureUser(email: string): Promise<"created" | "exists"> {
    try {
      await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
          ],
          DesiredDeliveryMediums: ["EMAIL"],
        }),
      );
      return "created";
    } catch (err) {
      // Already has a login - inviting them is fine, just don't re-send the email.
      if (err instanceof UsernameExistsException) return "exists";
      throw err;
    }
  }

  /** Swallows every failure to undefined (deleted user, throttling, missing IAM). */
  async emailFor(userId: string): Promise<string | undefined> {
    try {
      const res = await this.client.send(
        new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: userId }),
      );
      return res.UserAttributes?.find((a) => a.Name === "email")?.Value;
    } catch {
      return undefined;
    }
  }
}
