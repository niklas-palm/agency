/**
 * Settings → Access tokens + appearance. Where a user mints Personal Access Tokens
 * for programmatic access (a coding assistant calling the management API on their
 * behalf). Create with a name + chosen scopes; the plaintext is shown ONCE, then
 * only metadata is listable; revoke any token. Mirrors the create-once-reveal-once
 * pattern of the agent API key. Also holds the theme picker - a per-browser
 * preference, so it needs no endpoint.
 */
import { useEffect, useState } from "react";
import type { AccessToken, Scope } from "@agency/shared";
import { SCOPES, DEFAULT_SCOPES, scopesForRole } from "@agency/shared";
import { Check, Copy, KeyRound, Palette, Plus, Trash2 } from "lucide-react";
import { listAccessTokens, createAccessToken, deleteAccessToken } from "../api.js";
import { useOrg } from "../OrgContext.js";
import { ErrorNote, Skeleton, ToggleRow, relativeTime } from "../components.js";
import { THEMES, THEME_KEYS, tintAlpha, useTheme } from "../theme.js";

export function Settings() {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null);
  const [err, setErr] = useState("");
  // The just-created plaintext token, shown once until dismissed.
  const [fresh, setFresh] = useState<string | null>(null);
  const { nonce } = useOrg();

  // Bare reload, for after a mutation in the CURRENT org.
  const load = () => listAccessTokens().then((r) => { setTokens(r); setErr(""); }).catch((e) => setErr(String(e)));
  useEffect(() => {
    // Guarded, because this also runs on an ORG SWITCH: clear first so the previous
    // org's rows can't read as the new org's while the fetch is in flight, and ignore
    // a late reply - the in-flight request carries the OLD org header, so resolving
    // after the new one would render another org's data here.
    let stop = false;
    setTokens(null);
    setErr("");
    listAccessTokens()
      .then((r) => !stop && setTokens(r))
      .catch((e) => !stop && setErr(String(e)));
    return () => {
      stop = true;
    };
  }, [nonce]);

  return (
    <div className="space-y-8 rise">
      <header>
        <p className="eyebrow">Your account</p>
        <h1 className="mt-1.5 font-display text-[2.5rem] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Settings</h1>
        <p className="mt-2.5 text-sm leading-relaxed text-muted">
          Personal access tokens let a coding assistant or script call the management API on
          your behalf - no interactive login. Scope each token to only what it needs.
        </p>
      </header>

      {err && <ErrorNote message={err} />}
      {fresh && <FreshToken token={fresh} onDismiss={() => setFresh(null)} />}

      <CreateToken
        onCreated={(t) => {
          setFresh(t);
          void load();
        }}
        onError={setErr}
      />

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-ink">Your tokens</h2>
          <p className="mt-0.5 text-xs text-muted">
            To change a token's scopes, revoke it and create a new one - scopes are fixed at
            creation so a token can never widen its own access.
          </p>
        </div>
        {!tokens && !err && <Skeleton className="h-16 rounded-xl" />}
        {tokens && tokens.length === 0 && (
          <p className="text-sm text-muted">No tokens yet. Create one above.</p>
        )}
        {tokens && tokens.length > 0 && (
          <div className="card divide-y divide-line overflow-hidden">
            {tokens.map((t) => (
              <TokenRow key={t.id} token={t} onRevoked={load} onError={setErr} />
            ))}
          </div>
        )}
      </section>

      <Appearance />
    </div>
  );
}

/**
 * Theme picker. Each option renders INSIDE its own palette (`data-theme` scopes the
 * CSS variables to the card - see styles.css), so an option is its own preview and
 * no theme's colors have to be restated in TS.
 */
function Appearance() {
  const { theme, setTheme } = useTheme();
  return (
    <section className="space-y-3">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-ink">
          <Palette className="h-4 w-4 text-accent-ink" />
          Appearance
        </h2>
        <p className="mt-0.5 text-xs text-muted">
          Colors only - type and layout are the same in every theme. Remembered in this
          browser, not on your account.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
        {THEME_KEYS.map((key) => {
          const active = key === theme;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={active}
              data-theme={key}
              onClick={() => setTheme(key)}
              className={`focus-ring rounded-xl border bg-canvas p-3.5 text-left transition-colors ${
                active ? "border-accent" : "border-line hover:border-ink/25"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-ink">{THEMES[key].label}</span>
                {active && <Check className="h-4 w-4 shrink-0 text-accent-ink" />}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted">{THEMES[key].blurb}</p>
              {/* A miniature of the console: a card, two lines of type, the hues. */}
              <div className="mt-3 rounded-lg border border-line bg-surface p-2.5 shadow-card">
                <div className="h-1.5 w-14 rounded-full bg-ink" />
                <div className="mt-1.5 h-1.5 w-20 rounded-full" style={{ backgroundColor: tintAlpha("muted", 0.6) }} />
                <div className="mt-3 flex items-center gap-1.5">
                  <span className="h-3 w-3 rounded-full bg-accent" />
                  <span className="h-3 w-3 rounded-full bg-live" />
                  <span className="h-3 w-3 rounded-full bg-clay" />
                  <span className="h-3 w-3 rounded-full bg-danger" />
                  <span className="ml-auto rounded bg-accent px-1.5 py-0.5 font-mono text-[9px] font-semibold text-on-accent">
                    Aa
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** The one-time reveal of a newly created token, with copy-to-clipboard. */
function FreshToken({ token, onDismiss }: { token: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="rounded-xl border p-4"
      style={{ borderColor: tintAlpha("live", 0.2), backgroundColor: tintAlpha("live", 0.05) }}
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Check className="h-4 w-4 text-live-ink" />
        Token created - copy it now
      </div>
      <p className="mt-1 text-xs text-muted">
        This is the only time it's shown. Store it somewhere safe; you can't retrieve it again.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-ink">
          {token}
        </code>
        <button
          className="btn-ghost !min-h-0 shrink-0 !px-2.5 !py-2"
          onClick={() => {
            void navigator.clipboard.writeText(token);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-4 w-4 text-live-ink" /> : <Copy className="h-4 w-4" />}
        </button>
        <button className="btn-ghost !min-h-0 shrink-0 !px-3 !py-2" onClick={onDismiss}>
          Done
        </button>
      </div>
    </div>
  );
}

function CreateToken({
  onCreated,
  onError,
}: {
  onCreated: (token: string) => void;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState("");
  // Default to the safe set (read + write, NOT delete) so an agentic token can
  // author but can't destroy ANYTHING - agent, skill, or integration - unless the
  // user explicitly opts in.
  const [scopes, setScopes] = useState<Set<Scope>>(new Set(DEFAULT_SCOPES));
  const [busy, setBusy] = useState(false);
  // The token is minted bound to the caller's active org - surface which one so
  // it's clear where the token will act.
  const { orgs, activeOrgId, role } = useOrg();
  // Only offer what the role can grant - the server 403s the rest, and it checks against
  // this same scopesForRole. Null role = /me hasn't resolved, so offer nothing.
  const grantable: Scope[] = role ? scopesForRole(role) : [];
  // `scopes` is seeded from DEFAULT_SCOPES before the role is known, so for a viewer it
  // can hold `write` while that toggle isn't rendered - mint the visible subset, not the
  // raw state, or we'd POST a scope the picker never showed and hit that 403.
  const selected = [...scopes].filter((s) => grantable.includes(s));
  const activeOrgName = orgs.find((o) => o.orgId === activeOrgId)?.name;

  const canCreate = name.trim().length > 0 && selected.length > 0 && !busy;

  async function create() {
    setBusy(true);
    onError("");
    try {
      const res = await createAccessToken({ name: name.trim(), scopes: selected });
      onCreated(res.token);
      setName("");
      setScopes(new Set(DEFAULT_SCOPES));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-5 sm:p-6">
      <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-ink">
        <KeyRound className="h-4 w-4 text-accent-ink" />
        New access token
      </h2>
      <div className="mt-4 space-y-5">
        <div>
          <div className="label mb-2">Name</div>
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. my-coding-assistant"
            maxLength={100}
          />
        </div>
        <div>
          <div className="label mb-2">Scopes</div>
          {/* No role yet = /me hasn't resolved (and OrgProvider swallows a failure, so
              it may never). Say so, rather than rendering an empty list above a
              permanently disabled button with no explanation. */}
          {!role && <p className="text-sm text-muted">Loading your permissions…</p>}
          <div className="space-y-3">
            {grantable.map((s) => (
              <ToggleRow
                key={s}
                checked={scopes.has(s)}
                onChange={(on) =>
                  setScopes((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(s);
                    else next.delete(s);
                    return next;
                  })
                }
                title={s}
                desc={SCOPES[s]}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button className="btn" disabled={!canCreate} onClick={create}>
            <Plus className="h-4 w-4" />
            {busy ? "Creating…" : "Create token"}
          </button>
          {activeOrgName && (
            <p className="text-xs text-muted">
              This token will act in: <span className="font-medium text-ink">{activeOrgName}</span>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function TokenRow({
  token,
  onRevoked,
  onError,
}: {
  token: AccessToken;
  onRevoked: () => void;
  onError: (e: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function revoke() {
    setBusy(true);
    onError("");
    try {
      await deleteAccessToken(token.id);
      onRevoked();
    } catch (e) {
      onError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">{token.name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {token.scopes.map((s) => (
            <span key={s} className="chip">
              {s}
            </span>
          ))}
        </div>
        <div className="mt-1.5 font-mono text-[11px] text-faint">
          created {relativeTime(token.createdAt)} ·{" "}
          {token.lastUsedAt ? `last used ${relativeTime(token.lastUsedAt)}` : "never used"}
        </div>
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-2">
          <button
            className="btn-ghost !min-h-0 !px-2.5 !py-2 border-danger/40 text-danger-ink hover:bg-danger/5"
            onClick={revoke}
            disabled={busy}
          >
            {busy ? "Revoking…" : "Revoke"}
          </button>
          <button className="btn-ghost !min-h-0 !px-2.5 !py-2" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="btn-ghost !min-h-0 shrink-0 !px-2.5 !py-2 text-muted hover:text-danger-ink"
          onClick={() => setConfirming(true)}
          title="Revoke token"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
