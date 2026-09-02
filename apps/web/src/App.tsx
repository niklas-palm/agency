import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { AgentList } from "./views/AgentList.js";
import { CreateAgent } from "./views/CreateAgent.js";
import { AgentDetail } from "./views/AgentDetail.js";
import { Docs } from "./views/Docs.js";
import { Settings } from "./views/Settings.js";
import { Skills } from "./views/Skills.js";
import { Integrations } from "./views/Integrations.js";
import { Members } from "./views/Members.js";
import { AgencyMark, ErrorNote } from "./components.js";
import { OrgSwitcher } from "./OrgSwitcher.js";
import { OrgProvider, useCan, useOrg } from "./OrgContext.js";
import { Landing } from "./views/Landing.js";
import { Login } from "./views/Login.js";
import { getToken, logout } from "./auth.js";

/**
 * Whether the SPA requires a login. Defaults to TRUE - a build must opt OUT explicitly
 * with `VITE_AUTH_DISABLED=true`, which `apps/web/.env.development` sets for local dev
 * against an AUTH_DISABLED API. Vite loads `.env.development` for `vite dev` only, never
 * for `vite build`, so the opt-out cannot reach a deployed bundle.
 *
 * It used to be INFERRED from `VITE_API_URL` being set, which failed in the unsafe
 * direction: a deploy that forgot the env var (easy - Vite bakes these at build time)
 * shipped a console that rendered fully signed-in with no login screen at all. Now a
 * forgotten variable produces a login prompt, which is a visible mistake rather than a
 * silent one.
 */
const AUTH_REQUIRED = import.meta.env.VITE_AUTH_DISABLED !== "true";

/** Tiny hash router: #/ (roster), #/new (create), #/agent/:id (detail). */
function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const on = () => {
      setHash(window.location.hash || "#/");
      window.scrollTo(0, 0); // start every page at the top, not wherever the last one was scrolled
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

/**
 * Set only by the PR-preview build (see .github/workflows/preview.yml). A preview is served
 * from `<pr>.<domain>` but talks to the REAL API and user pool, so it has to be impossible
 * to mistake for production - hence a permanent marker rather than a dismissible banner.
 */
const PREVIEW_LABEL = import.meta.env.VITE_PREVIEW_LABEL;

export function App() {
  return (
    <>
      <PreviewBadge />
      <AppRoutes />
    </>
  );
}

/** "Preview · PR #123", pinned bottom-right. Absent from every production build. */
function PreviewBadge() {
  if (!PREVIEW_LABEL) return null;
  return (
    <div
      // Deliberately styled from `ink`/`canvas` only - the two tokens every palette has,
      // whichever way round - so this chip can't stop rendering because a color was renamed.
      // pointer-events-none so it can never sit on top of a control the reviewer is trying
      // to click: it's a label, not a UI.
      className="pointer-events-none fixed bottom-3 right-3 z-50 rounded-full bg-ink px-3 py-1 font-mono text-[11px] font-semibold text-canvas shadow-card"
      role="status"
    >
      Preview · {PREVIEW_LABEL} · live data
    </div>
  );
}

function AppRoutes() {
  const route = useHashRoute();
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    // Boot: signed-in if we hold an access token (local dev has auth off → always
    // in). A returning user whose short-lived access token has EXPIRED still has it
    // stored, so they render the app; the first API call 401s and sendWithRefresh
    // (api.ts) silently mints a fresh token from the refresh token and replays - so
    // a long-lived login "just works" with no login flash. (store/clearTokens always
    // move both tokens together, so there's no "access gone but refresh present"
    // boot state to pre-handle here.)
    setSignedIn(!AUTH_REQUIRED || Boolean(getToken()));
    setReady(true);
  }, []);

  // Until boot settles, render nothing.
  if (!ready) return null;

  // Signed-out (deployed) visitors: #/login shows our own sign-in form, #/docs is
  // public (the landing links to it), everything else is the landing page. No
  // off-site redirect. Local dev (auth off) always shows the full app.
  if (AUTH_REQUIRED && !signedIn) {
    if (route.startsWith("#/login")) return <Login onSignedIn={() => { setSignedIn(true); window.location.hash = "#/"; }} />;
    if (route.startsWith("#/docs")) return <PublicDocs />;
    return <Landing />;
  }

  let view: JSX.Element;
  if (route.startsWith("#/new")) view = <CreateAgent />;
  // Keyed by agent id: the detail view seeds its Configure form and the Run tab's API
  // key from mount-only state, so React reusing one instance across two agent URLs
  // (back/forward, or pasting the second URL) would leave agent A's form values in
  // place while `agent` became B - and Save would then PATCH A's config onto B.
  else if (route.startsWith("#/agent/")) {
    const agentId = route.replace("#/agent/", "");
    view = <AgentDetail key={agentId} id={agentId} />;
  }
  else if (route.startsWith("#/docs")) view = <Docs />;
  else if (route.startsWith("#/settings")) view = <Settings />;
  else if (route.startsWith("#/skills")) view = <Skills />;
  else if (route.startsWith("#/integrations")) view = <Integrations />;
  else if (route.startsWith("#/members")) view = <Members />;
  else view = <AgentList />;

  // Wrap the whole authed app in the org context so the TopBar switcher + every
  // view can read the active org + role. (Only mounted once signed in, so /me is
  // always called with a credential.)
  return (
    <OrgProvider>
      <div className="min-h-screen">
        <TopBar route={route} showSignOut={AUTH_REQUIRED} />
        <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
          <PermissionsNotice />
          {view}
        </main>
      </div>
    </OrgProvider>
  );
}

/**
 * Shown when `/me` couldn't be loaded.
 *
 * Without it the failure is both invisible and consequential: no role means
 * `useCan` denies every write, so the console renders fully but with all
 * create/edit/share controls gone - looking like a permissions change rather than a
 * transient error. Say so, and offer the retry.
 */
function PermissionsNotice() {
  const { loadError, reload } = useOrg();
  if (!loadError) return null;
  return (
    <div className="mb-6">
      <ErrorNote message={`Couldn't load your organizations or permissions, so editing is disabled. ${loadError}`} />
      <button className="btn-ghost mt-2 !min-h-0 !px-3.5 !py-2 text-sm" onClick={() => void reload().catch(() => {})}>
        Retry
      </button>
    </div>
  );
}

/** Docs for a signed-out visitor: the same Docs page, wrapped in a slim public
 *  header (mark + home + sign-in) since the app TopBar isn't mounted yet. */
function PublicDocs() {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
        <a href="#/" className="focus-ring flex items-center gap-2.5 rounded-lg">
          <AgencyMark className="h-8 w-8" />
          <span className="font-display text-[19px] font-bold tracking-[-0.01em] text-ink">Agency</span>
        </a>
        <a href="#/login" className="btn-ghost !min-h-0 !px-3.5 !py-2 text-sm">
          Sign in
        </a>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
        <Docs />
      </main>
    </div>
  );
}

function TopBar({ route, showSignOut }: { route: string; showSignOut: boolean }) {
  // "Agents" covers the roster + all agent routes (list, new, detail); Docs and
  // Settings are the other destinations. Settings (access tokens) only makes
  // sense with real auth, so it's shown alongside Sign out. Members is admin-only.
  const onDocs = route.startsWith("#/docs");
  const onSettings = route.startsWith("#/settings");
  const onSkills = route.startsWith("#/skills");
  const onIntegrations = route.startsWith("#/integrations");
  const onMembers = route.startsWith("#/members");
  const onAgents = !onDocs && !onSettings && !onSkills && !onIntegrations && !onMembers;
  const { manageOrg } = useCan();
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <a href="#/" className="focus-ring flex shrink-0 items-center gap-2.5 rounded-lg">
            <AgencyMark className="h-8 w-8" />
            {/* The wordmark is set in the display serif — the editorial signature.
                Hidden on the narrowest screens so the nav never overflows. */}
            <span className="hidden font-display text-[19px] font-semibold tracking-[-0.01em] text-ink min-[420px]:inline">
              Agency
            </span>
          </a>
          {showSignOut && <OrgSwitcher />}
        </div>
        <nav className="flex items-center gap-0.5 sm:gap-1">
          <NavLink href="#/" label="Agents" active={onAgents} />
          <NavLink href="#/skills" label="Skills" active={onSkills} />
          <NavLink href="#/integrations" label="Integrations" active={onIntegrations} />
          <NavLink href="#/docs" label="Docs" active={onDocs} />
          {showSignOut && manageOrg && <NavLink href="#/members" label="Members" active={onMembers} />}
          {showSignOut && <NavLink href="#/settings" label="Settings" active={onSettings} />}
          {showSignOut && (
            <button className="btn-ghost !min-h-0 !px-2.5 !py-1.5 text-muted" onClick={logout} title="Sign out">
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          )}
        </nav>
      </div>
    </header>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <a
      href={href}
      className={`focus-ring rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors ${
        active ? "text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {label}
    </a>
  );
}

