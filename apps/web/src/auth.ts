/**
 * In-app authentication against Cognito via SRP (Secure Remote Password) - our
 * OWN login UI, no hosted-UI redirect. We use `amazon-cognito-identity-js`, which
 * runs the SRP handshake in the browser so the password is never sent over the
 * wire, and returns the same Cognito JWTs the hosted flow did.
 *
 * The access token authenticates the control-plane API. Cognito's `InitiateAuth`
 * (SRP) does NOT put resource-server scopes on the access token the way the hosted
 * OAuth flow did, so the platform's pre-token-generation Lambda adds the
 * `agency/api` scope (and the `email` claim) to every access token - see
 * apps/control-plane/src/pre-token-lambda.ts. So an SRP token is accepted by the
 * API exactly like a hosted-flow one.
 *
 * Token storage mirrors the previous design: access + refresh tokens live in
 * localStorage so the session survives restarts and we silently refresh the short
 * access token. Same XSS exposure as before; acceptable for this admin console.
 *
 * Config comes from Vite env (VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID),
 * injected at build time.
 */
import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";

const USER_POOL_ID = import.meta.env.VITE_COGNITO_USER_POOL_ID as string;
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID as string;

const TOKEN_KEY = "ag_access_token";
const REFRESH_KEY = "ag_refresh_token";

const pool =
  USER_POOL_ID && CLIENT_ID
    ? new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID })
    : null;

/** The current access token, or null if not signed in. */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function store(session: CognitoUserSession): void {
  localStorage.setItem(TOKEN_KEY, session.getAccessToken().getJwtToken());
  localStorage.setItem(REFRESH_KEY, session.getRefreshToken().getToken());
}

function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  // amazon-cognito-identity-js caches its OWN copies (id/access/refresh tokens)
  // under `CognitoIdentityServiceProvider.<clientId>.*` on authenticate/refresh.
  // Our two keys above don't cover those, so a "clear" would leave the SDK's
  // 30-day refresh token (and an id token we never meant to keep) behind. signOut()
  // on the last-authenticated user runs the SDK's clearCachedTokens() for us.
  try {
    pool?.getCurrentUser()?.signOut();
  } catch {
    /* best-effort - the explicit removes above are the guarantee */
  }
}

/** A pending first-login password change: the caller must call completeNewPassword. */
export interface NewPasswordRequired {
  kind: "newPasswordRequired";
  /** Opaque handle the UI passes back to completeNewPassword. */
  user: CognitoUser;
}
export interface SignedIn {
  kind: "signedIn";
}
type SignInResult = SignedIn | NewPasswordRequired;

function requirePool(): CognitoUserPool {
  if (!pool) throw new Error("Auth is not configured (missing Cognito env).");
  return pool;
}

/**
 * Sign in with email + password (SRP). Resolves to `signedIn` (tokens stored) or
 * `newPasswordRequired` when the account is in FORCE_CHANGE_PASSWORD (admin-created
 * users on first sign-in) - the UI then collects a new password and calls
 * completeNewPassword. Rejects with a readable message on bad credentials.
 */
export function signIn(email: string, password: string): Promise<SignInResult> {
  const user = new CognitoUser({ Username: email, Pool: requirePool() });
  const details = new AuthenticationDetails({ Username: email, Password: password });
  return new Promise((resolve, reject) => {
    // The SDK calls a DIFFERENT callback per challenge type; any we don't provide
    // makes it throw inside the async network callback, which escapes the Promise
    // and leaves the caller's `busy` stuck forever. We only support password +
    // first-login-new-password, so reject the MFA/custom-auth challenges with a
    // readable message (only reachable if MFA is ever enabled on the pool).
    const unsupported = () => reject(new Error("This account needs a sign-in method we don't support yet."));
    user.authenticateUser(details, {
      onSuccess: (session) => {
        store(session);
        resolve({ kind: "signedIn" });
      },
      onFailure: (err) => reject(new Error(friendly(err))),
      newPasswordRequired: () => resolve({ kind: "newPasswordRequired", user }),
      mfaRequired: unsupported,
      totpRequired: unsupported,
      customChallenge: unsupported,
      selectMFAType: unsupported,
      mfaSetup: unsupported,
    });
  });
}

/**
 * Complete the first-login password change. `user` is the handle from a
 * `newPasswordRequired` result. On success the tokens are stored (the user is
 * signed in). Cognito requires the new password to meet the pool's policy.
 */
export function completeNewPassword(user: CognitoUser, newPassword: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Pass no extra attributes: email is already set + verified on the account.
    user.completeNewPasswordChallenge(
      newPassword,
      {},
      {
        onSuccess: (session) => {
          store(session);
          resolve();
        },
        onFailure: (err) => reject(new Error(friendly(err))),
      },
    );
  });
}

/** Start a forgot-password flow: Cognito emails a verification code. */
export function forgotPassword(email: string): Promise<void> {
  const user = new CognitoUser({ Username: email, Pool: requirePool() });
  return new Promise((resolve, reject) => {
    user.forgotPassword({
      onSuccess: () => resolve(),
      onFailure: (err) => reject(new Error(friendly(err))),
    });
  });
}

/** Finish forgot-password: submit the emailed code + the new password. */
export function confirmForgotPassword(email: string, code: string, newPassword: string): Promise<void> {
  const user = new CognitoUser({ Username: email, Pool: requirePool() });
  return new Promise((resolve, reject) => {
    user.confirmPassword(code, newPassword, {
      onSuccess: () => resolve(),
      onFailure: (err) => reject(new Error(friendly(err))),
    });
  });
}

/**
 * Silently mint a fresh access token from the stored refresh token. Returns true
 * on success. On failure (no/expired refresh token) it clears tokens and returns
 * false - the caller falls back to showing the login form. Single-flight so
 * concurrent 401s share one refresh.
 */
let inFlightRefresh: Promise<boolean> | null = null;
export function refreshAccessToken(): Promise<boolean> {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = doRefresh().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

function doRefresh(): Promise<boolean> {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  const email = currentUsername();
  if (!refreshToken || !email || !pool) {
    clearTokens();
    return Promise.resolve(false);
  }
  const user = new CognitoUser({ Username: email, Pool: pool });
  return new Promise((resolve) => {
    user.refreshSession({ getToken: () => refreshToken } as never, (err, session) => {
      if (err || !session) {
        clearTokens();
        resolve(false);
        return;
      }
      store(session as CognitoUserSession);
      resolve(true);
    });
  });
}

/**
 * The username (email) of the current session, read from the stored access token's
 * `username` claim. Needed to construct the CognitoUser for a refresh. Returns null
 * if there's no (parseable) token.
 */
function currentUsername(): string | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!)) as { username?: string; sub?: string };
    return payload.username ?? payload.sub ?? null;
  } catch {
    return null;
  }
}

/**
 * Session is unrecoverable (refresh failed): drop tokens and send the user to the
 * login view. Called by the API layer on a 401 that a silent refresh couldn't fix.
 * (Named `reauth` for the API layer; unlike the old hosted-UI version it navigates
 * to our own #/login rather than redirecting off-site.)
 */
export function reauth(): void {
  clearTokens();
  window.location.hash = "#/login";
  // Reload so the app re-boots signed-out and renders the login form. Without this
  // the SPA keeps its in-memory signedIn=true state and would fall through to a
  // broken authed shell (the old hosted-UI reauth navigated off-site, which
  // discarded state for free; our in-app #/login is a hash change that doesn't).
  window.location.reload();
}

/** Sign out: revoke the refresh token server-side (best-effort), clear local
 *  tokens (incl. the SDK cache, via clearTokens), and re-boot signed-out. */
export function logout(): void {
  // signOut(cb) fires an async RevokeToken fetch and only invokes cb once it
  // returns; we must finish (clear + reload) AFTER that, or the synchronous reload
  // aborts the non-keepalive request and the ~30-day refresh token is never
  // revoked. A once-guard + 2s timeout make sure we always finish exactly once
  // even if RevokeToken stalls or errors.
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTokens();
    window.location.hash = "#/";
    window.location.reload();
  };
  const user = pool?.getCurrentUser();
  if (!user) return finish();
  try {
    user.signOut(finish);
  } catch {
    finish();
  }
  setTimeout(finish, 2000); // don't hang the user if the revoke stalls
}

/** Map Cognito error codes to short, human messages for the login form. */
function friendly(err: unknown): string {
  const e = err as { code?: string; name?: string; message?: string };
  const code = e.code ?? e.name ?? "";
  // Cognito reuses NotAuthorizedException for both bad credentials AND an expired
  // challenge session (the new-password screen sat too long). Distinguish by the
  // message so the new-password form doesn't show a nonsensical "incorrect password".
  if (code === "NotAuthorizedException" && /session/i.test(e.message ?? "")) {
    return "Your session expired. Go back and sign in again.";
  }
  switch (code) {
    case "NotAuthorizedException":
      return "Incorrect email or password.";
    case "UserNotFoundException":
      return "Incorrect email or password."; // don't reveal which
    case "CodeMismatchException":
      return "That reset code isn't right. Check the email and try again.";
    case "ExpiredCodeException":
      return "That reset code has expired. Request a new one.";
    case "InvalidPasswordException":
      return "That password doesn't meet the requirements (8+ chars, upper, lower, number, symbol).";
    case "LimitExceededException":
      return "Too many attempts. Wait a bit and try again.";
    default:
      return e.message ?? "Something went wrong. Try again.";
  }
}
