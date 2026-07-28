/**
 * Cognito Pre-Token-Generation trigger (V2_0). Two jobs, both on the ACCESS token
 * the SPA sends to the API:
 *
 *  1. Copy the user's VERIFIED `email` attribute in as an `email` claim (lowercased;
 *     skipped entirely when `email_verified` isn't "true" - the claim is an authority
 *     input for invite acceptance, so an unverified address must not become one). A stock
 *     access token has `sub` + `scope` but no `email` (that's an ID-token claim),
 *     yet the org model matches pending invites by the caller's verified email
 *     (`GET /invites`, accept/decline) and names the personal org from it.
 *
 *  2. Add the `agency/api` scope. The API requires this scope (auth.ts
 *     authorizePayload). The hosted OAuth flow granted it from the client's
 *     allowed scopes, but our own in-app login uses `InitiateAuth` (SRP), whose
 *     access token carries only default scopes - NOT resource-server scopes. So
 *     without this, a self-hosted-login token would 403 on every call. Adding it
 *     here means a token minted by ANY flow (hosted or SRP) carries the scope.
 *
 * V2_0 is required to customize the access token (V1_0 only reaches the ID token);
 * both custom claims and `scopesToAdd` are V2 features on the Essentials plan.
 */
const API_SCOPE = "agency/api";

interface PreTokenV2Event {
  request: { userAttributes: Record<string, string> };
  response: Record<string, unknown>;
}

export async function handler(event: PreTokenV2Event): Promise<PreTokenV2Event> {
  // VERIFIED only, and lowercased. The claim decides which pending invite a caller can
  // accept, so an unverified (self-set) address would let anyone claim an invite
  // addressed to someone else - and since invite rows are keyed by a lowercased email,
  // a case-variant would match while membership is written under the caller's own sub.
  const attrs = event.request.userAttributes ?? {};
  const email = attrs.email_verified === "true" ? attrs.email?.trim().toLowerCase() : undefined;
  event.response.claimsAndScopeOverrideDetails = {
    accessTokenGeneration: {
      // Only add the email claim when we actually have one (never override with undefined).
      ...(email ? { claimsToAddOrOverride: { email } } : {}),
      // Every access token gets the API scope, so both the hosted flow and our own
      // SRP login produce a token the control-plane accepts.
      scopesToAdd: [API_SCOPE],
    },
  };
  return event;
}
