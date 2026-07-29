/**
 * The Slack setup panel: a resumable state machine, not a wizard.
 *
 * The user has to leave to click Install in Slack, and may come back much later. So every step
 * is derived from server state, shows where they are, and is safe to re-run. The steps behind
 * the current one collapse to a one-line receipt; the current one is the only thing expanded.
 *
 * The whole design goal: the user pastes a manifest, clicks twice in Slack, and pastes one
 * token. Everything else - scopes, event subscriptions, the request URL, the signing-secret
 * handshake - is ours.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import {
  disconnectSlack,
  getSlackSetup,
  listSlackChannels,
  putSlackChannels,
  putSlackCredentials,
  type SlackSetup as Setup,
} from "./api.js";

/** One channel as the picker shows it. */
interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  /** Slack delivers a mention only to an app that's IN the channel, so this drives a warning. */
  isMember?: boolean;
}

/**
 * The server sends `{error, hint}`; `api.ts` throws it as `"<status>: <body>"`, so recover the
 * structured payload. Extracted because both forms in this file did it, and the hints are the
 * most useful text on the page (they name the fix, e.g. "invite the app first").
 */
function parseApiError(e: unknown, fallback: string): { error: string; hint?: string } {
  const raw = e instanceof Error ? e.message : "";
  const json = raw.match(/\{.*\}/)?.[0];
  if (json) {
    try {
      return JSON.parse(json) as { error: string; hint?: string };
    } catch {
      // fall through to the raw text
    }
  }
  return { error: raw || fallback };
}

/** Slack's "create from manifest" entry point. Opens the paste box directly. */
const CREATE_APP_URL = "https://api.slack.com/apps?new_app=1";

const STEPS = ["Create the app", "Install it", "Pick channels"] as const;

/**
 * Which step index a state sits at, so the tracker and the panels agree.
 *
 * `url_verified` belongs to step 1, not 0: it means Slack has reached us, so the app exists and
 * the user's next act is to install it and paste the token. Mapping it to 0 made the flow
 * UNCOMPLETABLE - the credential form renders only from step 1, so the one state a user actually
 * arrives at showed a spinner with nothing to fill in. `needs_bot_token` (a token stored without
 * a verified workspace) is only reachable if the version bump fails after the secrets were
 * written; it lands on the same step, which is the one the user can act on either way.
 *
 * Exported for the test that pins this: the mapping is pure, and getting it wrong is invisible
 * to typecheck and to every server-side test.
 */
export function stepOf(state: Setup["state"]): number {
  if (state === "manifest_ready") return 0;
  if (state === "url_verified" || state === "needs_bot_token") return 1;
  return 2;
}

export function SlackSetup({ agentId, canWrite }: { agentId: string; canWrite: boolean }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setSetup(await getSlackSetup(agentId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load the Slack setup");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * While the user is off in Slack pasting the manifest, poll so `url_verified` appears on its
   * own. That unprompted tick is what makes the setup feel managed rather than hopeful - and it
   * doubles as the diagnostic if it never arrives. Stops as soon as the handshake lands.
   */
  const waitingForSlack = setup?.state === "manifest_ready";
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  useEffect(() => {
    if (!waitingForSlack) {
      setWaitedTooLong(false);
      return;
    }
    const timer = setInterval(() => void load(), 4000);
    // Stop after a couple of minutes and show the diagnostic instead: an abandoned tab shouldn't
    // poll forever, and by this point the silence itself is the information.
    const giveUp = setTimeout(() => {
      setWaitedTooLong(true);
      clearInterval(timer);
    }, 120_000);
    return () => {
      clearInterval(timer);
      clearTimeout(giveUp);
    };
  }, [waitingForSlack, load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface p-4 text-xs text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading Slack setup…
      </div>
    );
  }
  if (error || !setup) {
    // Say what to DO, not just what the server returned. A raw `404: {"error":…}` reads as a bug
    // in the product even when it's an ordinary state - and two of these aren't retryable, so
    // offering "Try again" for them is actively misleading.
    const status = /^(\d{3})/.exec(error ?? "")?.[1];
    const message =
      status === "404"
        ? "This agent has no saved Slack trigger yet. Enable Slack and save the agent, then come back."
        : status === "403"
          ? "You need write access to this agent to set up Slack."
          : (error ?? "No Slack setup available.");
    const retryable = status !== "404" && status !== "403";
    return (
      <div className="rounded-lg border border-line bg-surface p-4">
        <p className="text-xs text-danger">{message}</p>
        {retryable && (
          <button className="btn btn-ghost mt-3" type="button" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> Try again
          </button>
        )}
      </div>
    );
  }

  const current = stepOf(setup.state);

  return (
    <div className="space-y-3">
      <StepTracker current={current} live={setup.state === "live"} />

      {setup.state === "live" ? (
        <LivePanel setup={setup} canWrite={canWrite} agentId={agentId} onChange={load} />
      ) : (
        <>
          <CreateAppStep setup={setup} done={current > 0} stalled={waitedTooLong} onRecheck={load} />
          {current >= 1 && (
            <InstallStep setup={setup} agentId={agentId} canWrite={canWrite} onDone={load} done={current > 1} />
          )}
          {current >= 2 && <ChannelStep setup={setup} agentId={agentId} canWrite={canWrite} onDone={load} />}
        </>
      )}

      {!canWrite && (
        <p className="text-[11px] text-muted">
          You can see this setup but not change it - you need write access to this agent.
        </p>
      )}
    </div>
  );
}

/** A compact progress line. No animation: it changes rarely and only as a side effect. */
function StepTracker({ current, live }: { current: number; live: boolean }) {
  return (
    <ol className="flex items-center gap-2 text-[11px]">
      {STEPS.map((label, i) => {
        const done = live || i < current;
        const active = !live && i === current;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={`flex h-4 w-4 items-center justify-center rounded-full border text-[9px] ${
                done
                  ? "border-pine bg-pine text-canvas"
                  : active
                    ? "border-pine text-pine-deep"
                    : "border-line text-muted"
              }`}
            >
              {done ? <Check className="h-2.5 w-2.5" /> : i + 1}
            </span>
            <span className={done || active ? "text-ink" : "text-muted"}>{label}</span>
            {i < STEPS.length - 1 && <span className="text-line">→</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Panel({
  title,
  children,
  receipt,
}: {
  title: string;
  children?: React.ReactNode;
  receipt?: string;
}) {
  if (receipt) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-4 py-2.5 text-xs">
        <Check className="h-3.5 w-3.5 shrink-0 text-pine-deep" />
        <span className="text-muted">{receipt}</span>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-3 text-sm font-medium text-ink">{title}</div>
      {children}
    </div>
  );
}

function CreateAppStep({
  setup,
  done,
  stalled,
  onRecheck,
}: {
  setup: Setup;
  done: boolean;
  stalled: boolean;
  onRecheck: () => void;
}) {
  if (done) return <Panel title="" receipt="Slack app created, and Slack has reached this agent's webhook." />;
  if (setup.nameProblem) {
    return (
      <Panel title="1. Create the Slack app">
        <div className="rounded-md border border-line bg-canvas px-3 py-2.5">
          <p className="text-xs text-danger">Rename the agent first.</p>
          <p className="mt-1 text-[11px] text-muted">{setup.nameProblem}</p>
          <p className="mt-1.5 text-[11px] text-muted">
            The agent's name becomes the bot's handle, so it has to be one Slack accepts. Change it
            on the <strong className="text-ink">Configure</strong> tab and come back - this step
            will unblock itself.
          </p>
        </div>
      </Panel>
    );
  }
  return (
    <Panel title="1. Create the Slack app">
      <p className="mb-3 text-xs text-muted">
        Copy this manifest, then open Slack's <em>From a manifest</em> flow and paste it. It already
        contains the permissions, the events to subscribe to, and this agent's webhook URL - there's
        nothing to configure afterwards.
      </p>
      <CopyBlock label="App manifest" value={JSON.stringify(setup.manifest, null, 2)} multiline />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a className="btn" href={CREATE_APP_URL} target="_blank" rel="noreferrer">
          Open Slack <ExternalLink className="h-3.5 w-3.5" />
        </a>
        {stalled ? (
          <button className="btn btn-ghost" type="button" onClick={onRecheck}>
            <RefreshCw className="h-3.5 w-3.5" /> Check again
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
            <Loader2 className="h-3 w-3 animate-spin" />
            Waiting for Slack to reach us…
          </span>
        )}
      </div>
      <p className="mt-3 text-[11px] text-muted">
        In Slack: <strong className="text-ink">Create an app</strong> →{" "}
        <strong className="text-ink">From a manifest</strong> → pick your workspace →{" "}
        <strong className="text-ink">Next</strong> → paste →{" "}
        <strong className="text-ink">Next</strong> → <strong className="text-ink">Create</strong>.
        This line updates by itself once Slack calls our URL.
      </p>
      {stalled && (
        <div className="mt-3 rounded-md border border-line bg-canvas px-3 py-2">
          <p className="text-xs text-ink">Slack hasn't called us yet.</p>
          <p className="mt-1 text-[11px] text-muted">
            Check you clicked <strong className="text-ink">Create</strong> at the end of the
            manifest flow, and that you created a NEW app rather than pasting into an existing
            app's manifest editor (that doesn't re-trigger the check). The URL Slack has to reach
            is below - it must be reachable from the internet, so this step can't complete against
            a local dev server.
          </p>
          <code className="mt-2 block overflow-x-auto rounded border border-line bg-raised px-2 py-1 font-mono text-[10px] text-ink">
            {setup.requestUrl}
          </code>
        </div>
      )}
    </Panel>
  );
}

function InstallStep({
  setup,
  agentId,
  canWrite,
  onDone,
  done,
}: {
  setup: Setup;
  agentId: string;
  canWrite: boolean;
  onDone: () => void;
  done: boolean;
}) {
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ error: string; hint?: string } | null>(null);

  if (done) {
    return (
      <Panel
        title=""
        receipt={`Installed in ${setup.teamName ?? "your workspace"}${
          setup.grantedScopes?.length ? ` · ${setup.grantedScopes.length} scopes granted` : ""
        }.`}
      />
    );
  }

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await putSlackCredentials(agentId, { botToken: botToken.trim(), signingSecret: signingSecret.trim() });
      setBotToken("");
      setSigningSecret("");
      onDone();
    } catch (e) {
      setErr(parseApiError(e, "could not save the credentials"));
    } finally {
      setBusy(false);
    }
  };

  const appUrl = setup.appId ? `https://api.slack.com/apps/${setup.appId}` : "https://api.slack.com/apps";
  return (
    <Panel title="2. Install it and paste the two values">
      <p className="mb-3 text-xs text-muted">
        Installing needs your consent in Slack - there's no API for it, so this is the one step we
        can't do for you. Then copy two values from the app's settings. If your workspace requires
        admin approval for apps, Slack asks you to request it instead of installing; this page
        waits here, so you can come back once it's approved.
      </p>
      <ol className="mb-3 space-y-1.5 text-xs text-muted">
        <li>
          1. Open <strong className="text-ink">OAuth &amp; Permissions</strong> →{" "}
          <strong className="text-ink">Install to Workspace</strong> → Allow. (Some workspaces
          show this under <strong className="text-ink">Install App</strong> instead.)
        </li>
        <li>
          2. Copy the <strong className="text-ink">Bot User OAuth Token</strong> (starts{" "}
          <code className="font-mono text-[11px]">xoxb-</code>) from{" "}
          <strong className="text-ink">OAuth &amp; Permissions</strong>.
        </li>
        <li>
          3. Copy the <strong className="text-ink">Signing Secret</strong> from{" "}
          <strong className="text-ink">Basic Information</strong>.
        </li>
      </ol>
      <a className="btn btn-ghost mb-4" href={appUrl} target="_blank" rel="noreferrer">
        Open the app's settings <ExternalLink className="h-3.5 w-3.5" />
      </a>
      <div className="space-y-3">
        <Field
          label="Bot User OAuth Token"
          value={botToken}
          onChange={setBotToken}
          placeholder="xoxb-…"
          disabled={!canWrite || busy}
        />
        <Field
          label="Signing Secret"
          value={signingSecret}
          onChange={setSigningSecret}
          placeholder="0123456789abcdef…"
          disabled={!canWrite || busy}
        />
      </div>
      {err && (
        <div className="mt-3 rounded-md border border-line bg-canvas px-3 py-2">
          <p className="text-xs text-danger">{err.error}</p>
          {err.hint && <p className="mt-1 text-[11px] text-muted">{err.hint}</p>}
        </div>
      )}
      <button
        className="btn mt-3"
        disabled={!canWrite || busy || !botToken.trim() || !signingSecret.trim()}
        onClick={() => void submit()}
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {busy ? "Verifying with Slack…" : "Connect"}
      </button>
      <p className="mt-2 text-[11px] text-muted">
        Both values are write-only: they're stored on the platform, never returned by the API, and
        never shown here again. The agent itself never receives them - it replies through us, so a
        compromised agent has no Slack credential to steal.
      </p>
    </Panel>
  );
}

/**
 * Where the agent may answer: a picker over the channels the bot can actually see, plus the
 * escape hatch for people who don't want to curate a list.
 *
 * The picker matters for correctness, not just convenience. It shows whether the bot is IN each
 * channel - Slack delivers a mention only to an app that's in the conversation, so a channel it
 * hasn't joined is the one thing that looks configured here and silently ignores every mention.
 * Typing an id can't tell you that; the list can.
 */
function ChannelStep({
  setup,
  agentId,
  canWrite,
  onDone,
}: {
  setup: Setup;
  agentId: string;
  canWrite: boolean;
  onDone: () => void;
}) {
  const [available, setAvailable] = useState<SlackChannel[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ error: string; hint?: string } | null>(null);

  // Load once. A failure is not fatal - the id field below still works, which is why the picker
  // is an enhancement rather than the only route.
  useEffect(() => {
    let stop = false;
    listSlackChannels(agentId)
      .then((r) => {
        if (stop) return;
        setAvailable(r.channels);
        setTruncated(r.truncated);
      })
      .catch((e) => !stop && setListErr(e instanceof Error ? e.message : "could not list channels"));
    return () => {
      stop = true;
    };
  }, [agentId]);

  const save = async (channels: string[], allChannels = setup.allChannels) => {
    setBusy(true);
    setErr(null);
    try {
      await putSlackChannels(agentId, channels, allChannels);
      onDone();
    } catch (e) {
      setErr(parseApiError(e, "could not save the channels"));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    void save(
      setup.channels.includes(id) ? setup.channels.filter((c) => c !== id) : [...setup.channels, id],
    );

  return (
    <Panel title="3. Choose where it can answer">
      <p className="mb-3 text-xs text-muted">
        This is a real limit, not a filter: anyone who can invite the bot to a channel can direct
        the agent, so keep it to channels you're happy with that.
      </p>

      <label className="mb-3 flex items-start gap-2.5 rounded-md border border-line bg-canvas px-3 py-2.5">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={setup.allChannels}
          disabled={!canWrite || busy}
          onChange={(e) => void save(setup.channels, e.target.checked)}
        />
        <span className="text-xs">
          <span className="font-medium text-ink">Answer anywhere the bot is invited</span>
          <span className="block text-[11px] text-muted">
            Skips the list below. Convenient for a private workspace; think twice for an agent with
            powerful integrations, since inviting the bot then becomes the only gate.
          </span>
        </span>
      </label>

      <div className={setup.allChannels ? "pointer-events-none opacity-45" : undefined}>
        {available === null && !listErr ? (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading channels…
          </p>
        ) : available && available.length ? (
          <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-line bg-canvas p-1.5">
            {available.map((ch) => (
              <label
                key={ch.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-raised"
              >
                <input
                  type="checkbox"
                  checked={setup.channels.includes(ch.id)}
                  disabled={!canWrite || busy}
                  onChange={() => toggle(ch.id)}
                />
                <span className="text-ink">
                  {ch.isPrivate ? "🔒" : "#"}
                  {ch.name}
                </span>
                {ch.isMember === false && (
                  <span className="ml-auto text-[10px] text-muted" title="Slack won't deliver mentions until the bot joins">
                    not joined - /invite it
                  </span>
                )}
              </label>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">
            {listErr ? "Couldn't list channels - paste an id below instead." : "No channels found."}
          </p>
        )}
        {truncated && (
          <p className="mt-1.5 text-[11px] text-muted">
            Showing the first 200 channels. Paste an id below for one that isn't listed.
          </p>
        )}
        <ChannelIdInput onAdd={(id) => void save([...setup.channels, id])} disabled={!canWrite || busy} />
      </div>

      {err && (
        <div className="mt-3 rounded-md border border-line bg-canvas px-3 py-2">
          <p className="text-xs text-danger">{err.error}</p>
          {err.hint && <p className="mt-1 text-[11px] text-muted">{err.hint}</p>}
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted">
        Whichever way you choose a channel, invite the agent to it with{" "}
        <code className="font-mono">/invite</code> - <strong className="text-ink">in public
        channels too</strong>. Slack only delivers a mention to an app that's in the conversation.
      </p>
    </Panel>
  );
}

/** The manual escape hatch: an id the picker didn't list (another workspace's, or beyond 200). */
function ChannelIdInput({ onAdd, disabled }: { onAdd: (id: string) => void; disabled: boolean }) {
  const [input, setInput] = useState("");
  const submit = () => {
    const id = input.trim();
    if (!id) return;
    onAdd(id);
    setInput("");
  };
  return (
    <div className="mt-2 flex gap-2">
      <input
        className="field flex-1 font-mono text-[11px]"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="…or paste a channel id (C0123456789)"
        disabled={disabled}
      />
      <button className="btn btn-ghost" type="button" disabled={disabled || !input.trim()} onClick={submit}>
        Add
      </button>
    </div>
  );
}

function LivePanel({
  setup,
  agentId,
  canWrite,
  onChange,
}: {
  setup: Setup;
  agentId: string;
  canWrite: boolean;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const remove = async (id: string) => {
    setBusy(true);
    setErr(null);
    try {
      await putSlackChannels(agentId, setup.channels.filter((c) => c !== id), setup.allChannels);
      onChange();
    } catch (e) {
      // Surfaced, not swallowed: the allowlist is the security control, so a removal that
      // silently failed would leave the user believing they'd revoked access they still grant.
      setErr(parseApiError(e, "could not remove the channel").error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {setup.missingScopes?.length ? (
        <div className="rounded-lg border border-danger/40 bg-surface p-4">
          <div className="text-sm font-medium text-danger">
            This app can't answer - {setup.missingScopes.join(", ")} {setup.missingScopes.length === 1 ? "is" : "are"} missing
          </div>
          <p className="mt-2 text-xs text-muted">
            Slack grants whatever scopes the app had when it was <strong className="text-ink">installed</strong>,
            so a token from an older app - or one installed before the permissions changed - carries
            the old set.{" "}
            {setup.missingScopes.includes("app_mentions:read") &&
              "Without app_mentions:read Slack never delivers a mention at all, which is why nothing happens and there's nothing in any log. "}
            Reinstall the app (<strong className="text-ink">OAuth &amp; Permissions → Reinstall</strong>),
            then paste the new token below. If you have several apps of the same name, take the token
            from the one whose Request URL matches this agent.
          </p>
        </div>
      ) : null}

      <div className="rounded-lg border border-pine/40 bg-surface p-4">
        <div className="flex items-center gap-2">
          <Check className="h-4 w-4 text-pine-deep" />
          <span className="text-sm font-medium text-ink">Live in {setup.teamName ?? "your workspace"}</span>
        </div>
        <p className="mt-2 text-xs text-muted">
          Mention the bot in an allowed channel and it runs. Reply in the same thread to add to a
          run that's still going - your message is injected into the turn in progress rather than
          starting a new one.
        </p>
      </div>

      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="label mb-2">Answers in</div>
        {setup.allChannels ? (
          <p className="text-xs text-ink">
            Any channel the bot is invited to.{" "}
            {canWrite && (
              <button
                type="button"
                className="underline text-muted transition-colors hover:text-ink"
                disabled={busy}
                onClick={() => void putSlackChannels(agentId, setup.channels, false).then(onChange)}
              >
                Restrict to a list
              </button>
            )}
          </p>
        ) : (
          <>
            <ChannelList channels={setup.channels} onRemove={canWrite && !busy ? remove : undefined} />
            {canWrite && (
              <ChannelIdInput
                onAdd={(id) =>
                  void putSlackChannels(agentId, [...setup.channels, id], false)
                    .then(onChange)
                    .catch((e) => setErr(parseApiError(e, "could not add the channel").error))
                }
                disabled={busy}
              />
            )}
          </>
        )}
        {err && <p className="mt-2 text-xs text-danger">{err}</p>}
      </div>

      {canWrite && (
        <div className="rounded-lg border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">Disconnect Slack</div>
              <p className="mt-0.5 text-xs text-muted">
                Forgets the app, its credentials and the channel list, and restarts setup at step 1.
                Use this if the Slack app was renamed, deleted, or installed in the wrong workspace.
                Deleting the app in Slack itself is separate - we can't do that for you.
              </p>
            </div>
            <Disconnect agentId={agentId} onDone={onChange} />
          </div>
        </div>
      )}

      {setup.grantedScopes?.length ? (
        <details className="rounded-lg border border-line bg-surface p-4">
          <summary className="cursor-pointer text-xs text-muted">
            Permissions Slack granted ({setup.grantedScopes.length})
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {setup.grantedScopes.map((s) => (
              <code key={s} className="chip font-mono text-[10px]">
                {s}
              </code>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Read back from Slack, so this is what the app can actually do - not just what we asked
            for.
          </p>
        </details>
      ) : null}
    </div>
  );
}

function ChannelList({
  channels,
  onRemove,
}: {
  channels: string[];
  onRemove?: (id: string) => Promise<void>;
}) {
  if (!channels.length) {
    return (
      <p className="text-xs text-muted">
        No channels yet - the agent won't answer anywhere until you add one.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {channels.map((c) => (
        <span key={c} className="chip inline-flex items-center gap-1.5 font-mono text-[11px]">
          {c}
          {onRemove && (
            <button
              className="text-muted transition-colors hover:text-danger"
              onClick={() => void onRemove(c)}
              aria-label={`Remove ${c}`}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="label mb-1.5">{label}</div>
      <input
        className="field w-full font-mono text-[11px]"
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
    </div>
  );
}

/** A copyable value. The button confirms in place - the one place a tiny animation earns its keep. */
function CopyBlock({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the value is selectable, so this is not worth an error state.
    }
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <div className="label">{label}</div>
        <button className="btn btn-ghost" onClick={() => void copy()}>
          {copied ? <Check className="h-3.5 w-3.5 text-pine-deep" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        className={`overflow-x-auto rounded-md border border-line bg-raised px-3 py-2 font-mono text-[10px] leading-relaxed text-ink ${
          multiline ? "max-h-52 overflow-y-auto" : ""
        }`}
      >
        {value}
      </pre>
    </div>
  );
}

/** Confirm-gated, because it throws away credentials the user had to fetch from Slack by hand. */
function Disconnect({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!confirming) {
    return (
      <button className="btn btn-ghost shrink-0" type="button" onClick={() => setConfirming(true)}>
        Disconnect
      </button>
    );
  }
  return (
    <div className="shrink-0 text-right">
      <div className="flex items-center gap-2">
        <button
          className="btn btn-ghost"
          type="button"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setErr(null);
            disconnectSlack(agentId)
              .then(onDone)
              .catch((e) => setErr(parseApiError(e, "could not disconnect").error))
              .finally(() => setBusy(false));
          }}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Yes, disconnect
        </button>
      </div>
      {err && <p className="mt-1.5 text-xs text-danger">{err}</p>}
    </div>
  );
}
