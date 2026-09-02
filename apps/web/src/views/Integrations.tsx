/**
 * Integrations management: register a downstream API + its credential, then attach
 * it to agents (on create/configure). The agent NEVER sees the credential - it calls
 * the control-plane proxy, which holds the secret, checks the agent is allowed to use
 * this integration, and forwards ONLY to the stored base URL. Attaching stores just the
 * id, so editing an integration here flows to every agent using it on its next run.
 *
 * Unlike a skill (one Markdown doc), an integration is structured: name + description,
 * a base URL, an auth mechanism + write-only secret, and a list of operations (the
 * agent's discovery surface + the proxy's grant unit).
 */
import { useEffect, useMemo, useState } from "react";
import type {
  Integration,
  IntegrationInput,
  IntegrationAuth,
  IntegrationAuthKind,
  IntegrationOperation,
  IntegrationMethod,
  DiscoveredOperation,
} from "@agency/shared";
import { INTEGRATION_AUTH_KINDS, INTEGRATION_METHODS } from "@agency/shared";
import { Plus, Trash2, Pencil, Plug, X, RefreshCw, Search, Sparkles, Eye } from "lucide-react";
import {
  listIntegrations,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  refreshIntegration,
  discoverOperations,
} from "../api.js";
import { useCan, useOrg } from "../OrgContext.js";
import { ManagerPicker } from "../AgentExtras.js";
import { ErrorNote, Skeleton, ToggleRow } from "../components.js";

export function Integrations() {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [err, setErr] = useState("");
  // The integration being edited, `"new"` for the create form, or null (list only).
  const [editing, setEditing] = useState<Integration | "new" | null>(null);
  const { write, canManage } = useCan();
  const { nonce } = useOrg();

  // Bare reload, for after a mutation in the CURRENT org.
  const load = () => listIntegrations().then((r) => { setIntegrations(r); setErr(""); }).catch((e) => setErr(String(e)));
  useEffect(() => {
    // Guarded, because this also runs on an ORG SWITCH: clear first so the previous
    // org's rows can't read as the new org's while the fetch is in flight, and ignore
    // a late reply - the in-flight request carries the OLD org header, so resolving
    // after the new one would render another org's data here.
    let stop = false;
    setIntegrations(null);
    setErr("");
    listIntegrations()
      .then((r) => !stop && setIntegrations(r))
      .catch((e) => !stop && setErr(String(e)));
    return () => {
      stop = true;
    };
  }, [nonce]);

  return (
    <div className="space-y-6 rise">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Connected tools</p>
          <h1 className="mt-1.5 font-display text-[2.5rem] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Integrations</h1>
          <p className="mt-2.5 max-w-xl text-sm leading-relaxed text-muted">
            Downstream APIs your agents can call. The credential stays on the platform - agents reach
            the API through a proxy and never see the secret. Attach an integration to an agent to
            enable it.
          </p>
        </div>
        {editing === null && write && (
          <button className="btn shrink-0" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" />
            New integration
          </button>
        )}
      </header>

      {err && <ErrorNote message={err} />}

      {editing !== null && (
        <IntegrationEditor
          integration={editing === "new" ? null : editing}
          // Read-only when opened for an integration the caller can't manage (a
          // co-member's shared one) - they can inspect it, not save.
          readOnly={editing !== "new" && !canManage(editing)}
          onDone={() => {
            setEditing(null);
            void load();
          }}
          onCancel={() => setEditing(null)}
          onError={setErr}
        />
      )}

      {editing === null && (
        <>
          {!integrations && !err && <Skeleton className="h-32 rounded-xl" />}
          {integrations && integrations.length === 0 && (
            <EmptyState canCreate={write} onCreate={() => setEditing("new")} />
          )}
          {integrations && integrations.length > 0 && (
            <div className="card divide-y divide-line overflow-hidden">
              {integrations.map((i) => (
                <IntegrationRow
                  key={i.id}
                  integration={i}
                  // Editable only by a writer who owns it (or an org admin); a co-member's
                  // shared integration is read-only here.
                  canManage={canManage(i)}
                  onEdit={() => setEditing(i)}
                  onChanged={load}
                  onError={setErr}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function IntegrationRow({
  integration,
  canManage,
  onEdit,
  onChanged,
  onError,
}: {
  integration: Integration;
  canManage: boolean;
  onEdit: () => void;
  onChanged: () => void;
  onError: (e: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const used = integration.usedByAgentCount ?? 0;
  const ops = integration.operations.length;

  async function remove() {
    setBusy(true);
    onError("");
    try {
      await deleteIntegration(integration.id);
      onChanged();
    } catch (e) {
      onError(String(e));
      setBusy(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    onError("");
    try {
      await refreshIntegration(integration.id);
      onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex items-center gap-4 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm font-medium text-ink">{integration.name}</span>
          <span className="chip shrink-0 !px-1.5 !py-0">{ops} {ops === 1 ? "op" : "ops"}</span>
          <span className="chip shrink-0 !px-1.5 !py-0">{used} {used === 1 ? "agent" : "agents"}</span>
          {integration.discovery && (
            <span className="chip shrink-0 !px-1.5 !py-0 inline-flex items-center gap-1 text-accent-ink" title="Operations auto-discovered from a spec">
              <Sparkles className="h-3 w-3" />
              discovered
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted">{integration.description}</div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted">{integration.baseUrl}</div>
      </div>
      {/* An integration the caller can't manage (a co-member's shared one) is
          still openable read-only via View; managers get refresh/edit/delete. */}
      {!canManage ? (
        <button className="btn-ghost !min-h-0 !px-2.5 !py-2 text-muted" onClick={onEdit} title="View integration">
          <Eye className="h-4 w-4" />
        </button>
      ) : confirming ? (
        <div className="flex shrink-0 items-center gap-2">
          {used > 0 && <span className="hidden text-xs text-muted sm:inline">Used by {used}. Delete anyway?</span>}
          <button
            className="btn-ghost !min-h-0 !px-2.5 !py-2 border-danger/40 text-danger-ink hover:bg-danger/5"
            onClick={remove}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
          <button className="btn-ghost !min-h-0 !px-2.5 !py-2" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          {integration.discovery && (
            <button
              className="btn-ghost !min-h-0 !px-2.5 !py-2 text-muted"
              onClick={refresh}
              disabled={refreshing}
              title="Re-fetch the spec and reconcile operations"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          )}
          <button className="btn-ghost !min-h-0 !px-2.5 !py-2 text-muted" onClick={onEdit} title="Edit integration">
            <Pencil className="h-4 w-4" />
          </button>
          <button
            className="btn-ghost !min-h-0 !px-2.5 !py-2 text-muted hover:text-danger-ink"
            onClick={() => setConfirming(true)}
            title="Delete integration"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function IntegrationEditor({
  integration,
  readOnly = false,
  onDone,
  onCancel,
  onError,
}: {
  integration: Integration | null;
  readOnly?: boolean;
  onDone: () => void;
  onCancel: () => void;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState(integration?.name ?? "");
  const [description, setDescription] = useState(integration?.description ?? "");
  const [baseUrl, setBaseUrl] = useState(integration?.baseUrl ?? "");
  const [authKind, setAuthKind] = useState<IntegrationAuthKind>(integration?.auth.kind ?? "none");
  const [apiKeyHeader, setApiKeyHeader] = useState(
    integration?.auth.kind === "apiKey" ? integration.auth.header : "X-API-Key",
  );
  // OAuth2 client-credentials fields (only used when authKind === "oauth2Client").
  const initialOauth = integration?.auth.kind === "oauth2Client" ? integration.auth : null;
  const [tokenUrl, setTokenUrl] = useState(initialOauth?.tokenUrl ?? "");
  const [clientId, setClientId] = useState(initialOauth?.clientId ?? "");
  const [scope, setScope] = useState(initialOauth?.scope ?? "");
  const [audience, setAudience] = useState(initialOauth?.audience ?? "");
  const [authStyle, setAuthStyle] = useState<"basic" | "body">(initialOauth?.authStyle ?? "basic");
  // Write-only: blank means "leave the stored secret unchanged" on edit.
  const [secret, setSecret] = useState("");
  // Operations source: "manual" (hand-authored) or "discovery" (imported from a spec).
  // New integrations default to auto-discovery; editing an existing one opens in whichever
  // mode it actually uses (a hand-authored integration stays manual).
  const [mode, setMode] = useState<"manual" | "discovery">(
    integration ? (integration.discovery ? "discovery" : "manual") : "discovery",
  );
  const [operations, setOperations] = useState<IntegrationOperation[]>(
    integration && !integration.discovery ? integration.operations : [],
  );
  // The discovery catalog + selection (per-op enabled flags).
  const [discoveryUrl, setDiscoveryUrl] = useState(integration?.discovery?.url ?? "");
  const [catalog, setCatalog] = useState<DiscoveredOperation[]>(integration?.discovery?.operations ?? []);
  // New integrations default to shared with the org; editing keeps the stored flag.
  const [shared, setShared] = useState(integration?.shared ?? true);
  // Extra org members who may manage this integration (beyond creator + admins).
  const [managers, setManagers] = useState<string[]>(integration?.managers ?? []);
  const [busy, setBusy] = useState(false);
  const { canEditManagers } = useCan();
  // Only the creator/admin may edit the managers list (a granted manager edits
  // content but can't re-delegate) - mirrors the server's patchManagers gate.
  const showManagers = !readOnly && shared && canEditManagers({ createdBy: integration?.createdBy });

  const auth: IntegrationAuth =
    authKind === "apiKey"
      ? { kind: "apiKey", header: apiKeyHeader.trim() }
      : authKind === "oauth2Client"
        ? {
            kind: "oauth2Client",
            tokenUrl: tokenUrl.trim(),
            clientId: clientId.trim(),
            authStyle,
            ...(scope.trim() ? { scope: scope.trim() } : {}),
            ...(audience.trim() ? { audience: audience.trim() } : {}),
          }
        : { kind: authKind };

  const needsSecret = authKind !== "none";
  // On create, a credentialed integration needs its secret; on edit, a blank secret keeps the stored one.
  const secretMissing = needsSecret && !integration && !secret.trim();
  const headerMissing = authKind === "apiKey" && !apiKeyHeader.trim();
  const oauthMissing = authKind === "oauth2Client" && (!tokenUrl.trim() || !clientId.trim());
  const opsValid =
    mode === "discovery"
      ? catalog.length > 0
      : operations.length > 0 && operations.every((o) => o.operationId.trim() && o.path.trim());
  const canSave =
    !busy && Boolean(name.trim()) && Boolean(baseUrl.trim()) && opsValid && !secretMissing && !headerMissing && !oauthMissing;

  async function save() {
    setBusy(true);
    onError("");
    try {
      const input: IntegrationInput =
        mode === "discovery"
          ? {
              name: name.trim(),
              description: description.trim(),
              baseUrl: baseUrl.trim(),
              auth,
              // The selection: exactly the ops the user left enabled. On refresh the
              // server reconciles against the stored catalog, so this list is the
              // survivors, never a growing default.
              discovery: {
                url: discoveryUrl.trim(),
                enabledOperationIds: catalog.filter((o) => o.enabled).map((o) => o.operationId),
              },
              shared,
              managers,
              ...(secret.trim() ? { secret: secret.trim() } : {}),
            }
          : {
              name: name.trim(),
              description: description.trim(),
              baseUrl: baseUrl.trim(),
              auth,
              operations: operations.map((o) => ({
                operationId: o.operationId.trim(),
                summary: o.summary.trim(),
                method: o.method,
                path: o.path.trim(),
              })),
              shared,
              managers,
              ...(secret.trim() ? { secret: secret.trim() } : {}),
            };
      if (integration) await updateIntegration(integration.id, input);
      else await createIntegration(input);
      onDone();
    } catch (e) {
      onError(String(e));
      setBusy(false);
    }
  }

  return (
    <section className="card p-5 sm:p-6">
      <header className="mb-5">
        <h2 className="text-base font-semibold tracking-tight text-ink">
          {readOnly ? "View integration" : integration ? "Edit integration" : "New integration"}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          {readOnly
            ? "An integration shared with your organization. You can inspect its base URL and operations here; the credential is write-only (never shown), and only its creator or an org admin can edit it."
            : "Point at a downstream API and declare the operations agents may call. The credential is stored write-only and injected by the proxy - agents call operations by id and never see it."}
        </p>
      </header>

      <div className="space-y-5">
        {/* A disabled fieldset natively makes every input/button inside read-only,
            so viewing a co-member's shared integration needs no per-field guard. */}
        <fieldset disabled={readOnly} className="min-w-0 space-y-5 border-0 p-0">
        <Field label="Name">
          <input className="field font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="petstore" />
        </Field>

        <Field label="Description" hint="One line, shown to the agent so it knows what this API is for.">
          <input
            className="field"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Pet store inventory API"
            maxLength={280}
          />
        </Field>

        <Field label="Base URL" hint="Every operation path is relative to this. The proxy forwards ONLY here.">
          <input
            className="field font-mono"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Auth">
            <select className="field" value={authKind} onChange={(e) => setAuthKind(e.target.value as IntegrationAuthKind)}>
              {INTEGRATION_AUTH_KINDS.map((k) => (
                <option key={k} value={k}>
                  {AUTH_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          {authKind === "apiKey" && (
            <Field label="Header name">
              <input
                className="field font-mono"
                value={apiKeyHeader}
                onChange={(e) => setApiKeyHeader(e.target.value)}
                placeholder="X-API-Key"
              />
            </Field>
          )}
        </div>

        {authKind === "oauth2Client" && (
          <div className="rounded-lg border border-line bg-fill/40 p-4 space-y-4">
            <p className="text-[11px] leading-relaxed text-muted">
              Client-credentials (m2m): the proxy mints a short-lived access token from the token URL
              using the client id + secret, caches it, and injects it downstream. The agent never sees
              the client secret or the minted token.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Token URL">
                <input
                  className="field font-mono"
                  value={tokenUrl}
                  onChange={(e) => setTokenUrl(e.target.value)}
                  placeholder="https://auth.example.com/oauth/token"
                />
              </Field>
              <Field label="Client ID">
                <input
                  className="field font-mono"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="my-client-id"
                />
              </Field>
              <Field label="Scope" hint="Optional, space-delimited.">
                <input
                  className="field font-mono"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  placeholder="read:pets write:pets"
                />
              </Field>
              <Field label="Audience" hint="Optional (some providers require it).">
                <input
                  className="field font-mono"
                  value={audience}
                  onChange={(e) => setAudience(e.target.value)}
                  placeholder="https://api.example.com"
                />
              </Field>
            </div>
            <Field label="Client secret style" hint="How the client secret is sent to the token endpoint.">
              <select className="field" value={authStyle} onChange={(e) => setAuthStyle(e.target.value as "basic" | "body")}>
                <option value="basic">HTTP Basic header (default)</option>
                <option value="body">In the form body</option>
              </select>
            </Field>
          </div>
        )}

        {needsSecret && (
          <Field
            label={authKind === "oauth2Client" ? "Client secret" : "Credential"}
            hint={
              integration
                ? "Leave blank to keep the stored credential. Type a new value to rotate it."
                : "Stored write-only - injected by the proxy, never shown again."
            }
          >
            <input
              className="field font-mono"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={integration?.hasSecret ? "•••••••• (stored)" : "paste the secret"}
              autoComplete="off"
            />
          </Field>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="label !mb-0">Operations</div>
            <ModeToggle mode={mode} onChange={setMode} />
          </div>
          {mode === "manual" ? (
            <>
              <p className="mb-3 text-[11px] text-muted">
                What the agent can call. Each has a stable id, a summary the agent reads, an HTTP method,
                and a path relative to the base URL (use <span className="font-mono text-ink">{"{param}"}</span> for path
                parameters).
              </p>
              <OperationsEditor value={operations} onChange={setOperations} />
            </>
          ) : (
            <DiscoveryEditor
              url={discoveryUrl}
              onUrl={setDiscoveryUrl}
              catalog={catalog}
              onCatalog={setCatalog}
              initialSyncedAt={integration?.discovery?.syncedAt ?? ""}
              onError={onError}
              auth={auth}
              secret={secret}
              baseUrl={baseUrl}
              integrationId={integration?.id}
            />
          )}
        </div>

        <ToggleRow
          checked={shared}
          onChange={setShared}
          title="Shared with organization"
          desc="When on, every member of this organization can attach this integration to their agents. When off, only you can."
        />

        {/* Managers: extra members who may edit/delete this integration (creator +
            admins always can). Shown only to the creator/admin (who may change the grant). */}
        {showManagers && (
          <div>
            <div className="label mb-2">Managers</div>
            <p className="mb-2 text-xs text-muted">
              Members who can edit or delete this integration, in addition to you and org admins.
            </p>
            <ManagerPicker value={managers} onChange={setManagers} createdBy={integration?.createdBy} />
          </div>
        )}
        </fieldset>

        <div className="flex items-center gap-3">
          {readOnly ? (
            <button className="btn-ghost" onClick={onCancel}>
              Close
            </button>
          ) : (
            <>
              <button className="btn" disabled={!canSave} onClick={save}>
                {busy ? "Saving…" : integration ? "Save changes" : "Create integration"}
              </button>
              <button className="btn-ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

const AUTH_LABELS: Record<IntegrationAuthKind, string> = {
  none: "None (public API)",
  bearer: "Static token (Bearer)",
  apiKey: "Static token (custom header)",
  oauth2Client: "OAuth2 client credentials (m2m)",
};

/** Manual ⇄ Discovery segmented toggle for the operations source. */
function ModeToggle({ mode, onChange }: { mode: "manual" | "discovery"; onChange: (m: "manual" | "discovery") => void }) {
  return (
    <div className="inline-flex rounded-lg border border-line p-0.5 text-xs">
      {(["manual", "discovery"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`focus-ring rounded-md px-2.5 py-1 font-medium transition-colors ${
            mode === m ? "bg-fill text-ink" : "text-muted hover:text-ink"
          }`}
        >
          {m === "manual" ? "Manual" : "Auto-discover"}
        </button>
      ))}
    </div>
  );
}

function OperationsEditor({
  value,
  onChange,
}: {
  value: IntegrationOperation[];
  onChange: (ops: IntegrationOperation[]) => void;
}) {
  function update(i: number, patch: Partial<IntegrationOperation>) {
    onChange(value.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  }
  function add() {
    onChange([...value, { operationId: "", summary: "", method: "GET", path: "" }]);
  }
  function remove(i: number) {
    onChange(value.filter((_, j) => j !== i));
  }

  return (
    <div className="space-y-3">
      {value.map((op, i) => (
        <div key={i} className="rounded-lg border border-line p-3">
          <div className="flex items-center gap-2">
            <input
              className="field font-mono !py-2"
              value={op.operationId}
              onChange={(e) => update(i, { operationId: e.target.value })}
              placeholder="listPets"
              aria-label="Operation id"
            />
            <select
              className="field !w-auto !py-2"
              value={op.method}
              onChange={(e) => update(i, { method: e.target.value as IntegrationMethod })}
              aria-label="HTTP method"
            >
              {INTEGRATION_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => remove(i)}
              className="focus-ring shrink-0 rounded-md p-2 text-muted transition-colors hover:text-danger-ink"
              title="Remove operation"
              aria-label="Remove operation"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <input
            className="field font-mono !py-2 mt-2"
            value={op.path}
            onChange={(e) => update(i, { path: e.target.value })}
            placeholder="/pets/{id}"
            aria-label="Path"
          />
          <input
            className="field !py-2 mt-2"
            value={op.summary}
            onChange={(e) => update(i, { summary: e.target.value })}
            placeholder="List all pets in the store"
            aria-label="Summary"
          />
        </div>
      ))}
      <button type="button" onClick={add} className="btn-ghost !min-h-0 !px-2.5 !py-1.5 text-xs">
        <Plus className="h-3.5 w-3.5" />
        Add operation
      </button>
    </div>
  );
}

/**
 * Method chip colors, from the palette so a theme repaints them: read is the
 * accent, create the live hue, a mutation warns, a delete is danger. (These used
 * Tailwind's own `emerald`/`amber` scales, which sat outside the design system -
 * and the `amber-*` half rendered no color at all, since `amber` is a single
 * palette color here, not a scale.)
 */
const METHOD_COLORS: Record<IntegrationMethod, string> = {
  GET: "text-accent-ink bg-accent/10",
  POST: "text-live-ink bg-live/10",
  PUT: "text-warn bg-warn/10",
  PATCH: "text-warn bg-warn/10",
  DELETE: "text-danger-ink bg-danger/10",
};

/**
 * Auto-discovery editor: paste a spec URL, fetch the catalog, then pick the subset
 * to enable. All ops start enabled ("all selected, then deselect"); the search box,
 * select-all/none, and per-op checkboxes let the user narrow it. The saved selection
 * is remembered on refresh, so a later re-fetch never silently re-enables what was
 * turned off (new upstream ops arrive OFF).
 */
function DiscoveryEditor({
  url,
  onUrl,
  catalog,
  onCatalog,
  initialSyncedAt,
  onError,
  auth,
  secret,
  baseUrl,
  integrationId,
}: {
  url: string;
  onUrl: (u: string) => void;
  catalog: DiscoveredOperation[];
  onCatalog: (c: DiscoveredOperation[]) => void;
  initialSyncedAt: string;
  onError: (e: string) => void;
  auth: IntegrationAuth;
  secret: string;
  baseUrl: string;
  integrationId?: string;
}) {
  const [fetching, setFetching] = useState(false);
  const [filter, setFilter] = useState("");
  // Local: set after a fetch, read only in the footer - the parent never needs it
  // (the server stamps syncedAt on save).
  const [syncedAt, setSyncedAt] = useState(initialSyncedAt);

  async function fetchSpec() {
    if (!url.trim()) return;
    setFetching(true);
    onError("");
    try {
      // Send the entered credential so an auth-gated spec fetches (the spec is often
      // behind the same key as the API). The server only attaches it if the spec URL is
      // under baseUrl. integrationId lets an edit reuse the stored secret when untyped.
      const { operations } = await discoverOperations(url.trim(), {
        auth,
        secret: secret.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
        integrationId,
      });
      onCatalog(operations); // server returns all-enabled on a fresh preview
      setSyncedAt(new Date().toISOString());
    } catch (e) {
      onError(String(e));
    } finally {
      setFetching(false);
    }
  }

  function toggle(operationId: string) {
    onCatalog(catalog.map((o) => (o.operationId === operationId ? { ...o, enabled: !o.enabled } : o)));
  }
  function setAll(enabled: boolean, ids: Set<string>) {
    onCatalog(catalog.map((o) => (ids.has(o.operationId) ? { ...o, enabled } : o)));
  }

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (o) =>
        o.operationId.toLowerCase().includes(q) ||
        o.path.toLowerCase().includes(q) ||
        o.summary.toLowerCase().includes(q),
    );
  }, [catalog, filter]);
  const visibleIds = useMemo(() => new Set(visible.map((o) => o.operationId)), [visible]);
  const enabledCount = catalog.filter((o) => o.enabled).length;

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-muted">
        Import operations from an OpenAPI spec URL, then pick the subset agents may call. New
        operations added upstream later arrive disabled - your selection is remembered.
      </p>
      <div className="flex items-center gap-2">
        <input
          className="field font-mono !py-2"
          value={url}
          onChange={(e) => onUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void fetchSpec())}
          placeholder="https://api.example.com/openapi.json"
          aria-label="Discovery spec URL"
        />
        <button
          type="button"
          onClick={fetchSpec}
          disabled={fetching || !url.trim()}
          className="btn-ghost !min-h-0 shrink-0 !px-3 !py-2 text-xs"
        >
          {fetching ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {catalog.length ? "Re-fetch" : "Discover"}
        </button>
      </div>

      {catalog.length > 0 && (
        <div className="rounded-lg border border-line">
          <div className="flex items-center gap-2 border-b border-line p-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
              <input
                className="field !py-1.5 !pl-8 text-xs"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter operations…"
                aria-label="Filter operations"
              />
            </div>
            <button
              type="button"
              onClick={() => setAll(true, visibleIds)}
              className="focus-ring shrink-0 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:text-ink"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setAll(false, visibleIds)}
              className="focus-ring shrink-0 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:text-ink"
            >
              None
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-line">
            {visible.map((op) => (
              <label
                key={op.operationId}
                className="flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-fill/50"
              >
                <input
                  type="checkbox"
                  checked={op.enabled}
                  onChange={() => toggle(op.operationId)}
                  className="h-4 w-4 shrink-0 accent-accent"
                />
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${METHOD_COLORS[op.method]}`}
                >
                  {op.method}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-ink">{op.operationId}</div>
                  <div className="truncate text-[11px] text-muted">{op.summary || op.path}</div>
                </div>
              </label>
            ))}
            {visible.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-muted">No operations match “{filter}”.</div>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-line px-3 py-2 text-[11px] text-muted">
            <span>
              {enabledCount} of {catalog.length} enabled
            </span>
            {syncedAt && <span>Synced {new Date(syncedAt).toLocaleString()}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label mb-2">{label}</div>
      {children}
      {hint && <p className="mt-1.5 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

function EmptyState({ canCreate, onCreate }: { canCreate: boolean; onCreate: () => void }) {
  return (
    <div className="card flex flex-col items-center gap-4 px-6 py-16 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-fill text-accent-ink">
        <Plug className="h-5 w-5" />
      </span>
      <p className="max-w-xs text-sm leading-relaxed text-muted">
        {canCreate
          ? "No integrations yet. Register a downstream API and its credential to let your agents call it - without ever handling the secret."
          : "No integrations are shared with you in this organization yet."}
      </p>
      {canCreate && (
        <button className="btn mt-1" onClick={onCreate}>
          <Plus className="h-4 w-4" />
          New integration
        </button>
      )}
    </div>
  );
}
