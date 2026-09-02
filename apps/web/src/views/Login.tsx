/**
 * Our own sign-in view (no Cognito hosted-UI redirect). Three modes in one card:
 *  - "signin"   - email + password (SRP; the password never leaves the browser).
 *  - "newpass"  - first sign-in for an admin-created user (FORCE_CHANGE_PASSWORD):
 *                 they set a permanent password.
 *  - "forgot"   - request a reset code by email, then submit code + new password.
 * On success the app's auth state flips (onSignedIn) and the roster loads.
 *
 * Studio chrome: the compass mark, warm card, one clear primary action per mode.
 */
import { useState } from "react";
import { AgencyMark } from "../components.js";
import { ErrorNote } from "../components.js";
import type { CognitoUser } from "amazon-cognito-identity-js";
import { signIn, completeNewPassword, forgotPassword, confirmForgotPassword } from "../auth.js";

type Mode = "signin" | "newpass" | "forgot";

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  // The pending challenge user handle from a newPasswordRequired result.
  const [challengeUser, setChallengeUser] = useState<CognitoUser | null>(null);

  function reset(next: Mode) {
    setErr("");
    setNotice("");
    setPassword("");
    setNewPassword("");
    setCode("");
    setCodeSent(false);
    setMode(next);
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const doSignIn = () =>
    run(async () => {
      const res = await signIn(email.trim(), password);
      if (res.kind === "newPasswordRequired") {
        setChallengeUser(res.user);
        setPassword("");
        setMode("newpass");
        setNotice("Choose a new password to finish setting up your account.");
      } else {
        onSignedIn();
      }
    });

  const doNewPassword = () =>
    run(async () => {
      if (!challengeUser) throw new Error("Session expired - sign in again.");
      await completeNewPassword(challengeUser, newPassword);
      onSignedIn();
    });

  const doSendCode = () =>
    run(async () => {
      await forgotPassword(email.trim());
      setCodeSent(true);
      setNotice("We emailed you a reset code. Enter it below with your new password.");
    });

  const doConfirmReset = () =>
    run(async () => {
      await confirmForgotPassword(email.trim(), code.trim(), newPassword);
      // Switch to sign-in FIRST (reset() clears fields + the notice), THEN set the
      // confirmation - else the reset's setNotice("") batches last and swallows it.
      reset("signin");
      setNotice("Password reset. Sign in with your new password.");
    });

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="mx-auto flex w-full max-w-6xl items-center px-5 py-5 sm:px-8">
        <a href="#/" className="focus-ring flex items-center gap-2.5 rounded-lg">
          <AgencyMark className="h-8 w-8" />
          <span className="font-display text-[19px] font-bold tracking-[-0.01em] text-ink">Agency</span>
        </a>
      </header>

      <main className="flex flex-1 items-center justify-center px-5 pb-20">
        <div className="w-full max-w-sm rise">
          <div className="mb-6 text-center">
            <p className="eyebrow">
              {mode === "forgot" ? "Reset your password" : mode === "newpass" ? "Set a password" : "Welcome back"}
            </p>
            <h1 className="mt-1.5 font-display text-[2rem] font-bold leading-tight tracking-[-0.03em] text-ink">
              {mode === "forgot" ? "Forgot password" : mode === "newpass" ? "Choose a password" : "Sign in"}
            </h1>
          </div>

          <div className="card p-6">
            {err && <ErrorNote message={err} className="mb-4" />}
            {notice && !err && (
              <p className="mb-4 rounded-lg border border-line bg-fill px-3.5 py-2.5 text-sm text-muted">{notice}</p>
            )}

            {mode === "signin" && (
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void doSignIn();
                }}
              >
                <Field label="Email">
                  <input type="email" autoComplete="username" className="field" value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label="Password">
                  <input type="password" autoComplete="current-password" className="field" value={password} onChange={(e) => setPassword(e.target.value)} />
                </Field>
                <button type="submit" className="btn w-full" disabled={busy || !email.trim() || !password}>
                  {busy ? "Signing in…" : "Sign in"}
                </button>
                <button type="button" disabled={busy} onClick={() => reset("forgot")} className="focus-ring w-full rounded-md text-center text-xs text-accent-ink hover:underline disabled:opacity-50">
                  Forgot your password?
                </button>
              </form>
            )}

            {mode === "newpass" && (
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void doNewPassword();
                }}
              >
                <Field label="New password">
                  <input type="password" autoComplete="new-password" className="field" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                </Field>
                <p className="text-xs text-muted">At least 8 characters, with upper + lower case, a number, and a symbol.</p>
                <button type="submit" className="btn w-full" disabled={busy || !newPassword}>
                  {busy ? "Saving…" : "Set password & sign in"}
                </button>
                {/* Escape hatch: the challenge session can expire while this form
                    sits open; without this the user would be stuck here. */}
                <button type="button" disabled={busy} onClick={() => reset("signin")} className="focus-ring w-full rounded-md text-center text-xs text-muted hover:text-ink disabled:opacity-50">
                  Back to sign in
                </button>
              </form>
            )}

            {mode === "forgot" && (
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void (codeSent ? doConfirmReset() : doSendCode());
                }}
              >
                <Field label="Email">
                  <input type="email" autoComplete="username" className="field" value={email} onChange={(e) => setEmail(e.target.value)} disabled={codeSent} />
                </Field>
                {codeSent && (
                  <>
                    <Field label="Reset code">
                      <input inputMode="numeric" className="field" value={code} onChange={(e) => setCode(e.target.value)} />
                    </Field>
                    <Field label="New password">
                      <input type="password" autoComplete="new-password" className="field" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                    </Field>
                  </>
                )}
                <button
                  type="submit"
                  className="btn w-full"
                  disabled={busy || !email.trim() || (codeSent && (!code.trim() || !newPassword))}
                >
                  {busy ? "Working…" : codeSent ? "Reset password" : "Email me a code"}
                </button>
                {/* Once a code's been sent, let the user request a fresh one in place
                    (a code can expire, or never arrive) without leaving the flow. */}
                {codeSent && (
                  <button type="button" disabled={busy} onClick={() => void doSendCode()} className="focus-ring w-full rounded-md text-center text-xs text-accent-ink hover:underline disabled:opacity-50">
                    Resend code
                  </button>
                )}
                <button type="button" disabled={busy} onClick={() => reset("signin")} className="focus-ring w-full rounded-md text-center text-xs text-muted hover:text-ink disabled:opacity-50">
                  Back to sign in
                </button>
              </form>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}
