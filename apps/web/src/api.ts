/**
 * Typed client for the control-plane API.
 *
 * Base URL: `VITE_API_URL` when set (deployed SPA → the deployed API origin: the custom
 * domain when one is configured, else the API Gateway URL), else
 * the Vite dev `/api` proxy (local). Management calls (agents + access tokens:
 * list/get/create/update/delete) attach the signed-in user's Cognito access
 * token; invoke/poll are authed by the agent's own API key instead.
 */
import type {
  AccessToken,
  Agent,
  AgentConfig,
  AgentVersion,
  CreateAgentResponse,
  CreateAccessTokenRequest,
  CreateAccessTokenResponse,
  InvokeResponse,
  MetricsSummary,
  AgentRunsResponse,
  AgentRunTrace,
  PollResponse,
  RotateKeyResponse,
  Skill,
  SkillInput,
  Integration,
  IntegrationInput,
  IntegrationAuth,
  DiscoveredOperation,
  UpdateAgentRequest,
  Me,
  Org,
  Member,
  Invite,
  Role,
} from "@agency/shared";
import { getToken, reauth, refreshAccessToken } from "./auth.js";
import { getActiveOrg, setActiveOrg } from "./org.js";

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

/**
 * Headers for a management call: the user's Cognito bearer token (if signed in)
 * plus the active-org header (validated server-side against membership; absent →
 * the server uses the personal org).
 */
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getToken();
  const org = getActiveOrg();
  return {
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(org ? { "X-Agency-Org": org } : {}),
  };
}

/**
 * Send an authed management request, transparently recovering from two failure
 * modes so neither surfaces as a raw error the user can't escape:
 *  - **401 (expired token)**: try ONE silent refresh (via the refresh token) and
 *    replay; only if that fails do we bounce the user to sign in.
 *  - **403 with a stale active org**: the persisted `X-Agency-Org` names an org the
 *    user is no longer in (removed / org deleted). Clear the selection and replay
 *    once - the header-less retry resolves to the always-provisionable personal
 *    org, so the app un-wedges itself instead of 403-ing every route forever.
 * `send` builds a fresh Response each call so the replay re-reads current headers
 * (via authHeaders → getToken / getActiveOrg).
 */
async function sendWithRefresh(send: () => Promise<Response>): Promise<Response> {
  let res = await send();
  if (res.status === 401 && (await refreshAccessToken())) {
    res = await send();
  }
  if (res.status === 401) {
    reauth();
    throw new Error("Session expired - signing you in again.");
  }
  // A "not a member of that org" 403 (only requireAuth emits it, when the asserted
  // active org has no membership) = stale selection: drop it and retry once,
  // header-less, falling back to the personal org rather than wedging. We match the
  // specific message so a legitimate role/permission 403 in a VALID org isn't
  // misread as a stale-org one (that would silently dump the user into personal).
  if (res.status === 403 && getActiveOrg()) {
    const body = await res.clone().text().catch(() => "");
    if (body.includes("not a member of that org")) {
      setActiveOrg(null);
      res = await send();
    }
  }
  return res;
}

/** As `sendWithRefresh`, then parse the JSON body. */
async function managed<T>(send: () => Promise<Response>): Promise<T> {
  return json<T>(await sendWithRefresh(send));
}

/** As `sendWithRefresh`, for endpoints that return no body: throw on non-2xx. */
async function managedVoid(send: () => Promise<Response>): Promise<void> {
  const res = await sendWithRefresh(send);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
}

export async function listAgents(): Promise<Agent[]> {
  const { agents } = await managed<{ agents: Agent[] }>(() => fetch(`${BASE}/agents`, { headers: authHeaders() }));
  return agents;
}

export async function getAgent(id: string): Promise<Agent> {
  const { agent } = await managed<{ agent: Agent }>(() =>
    fetch(`${BASE}/agents/${id}`, { headers: authHeaders() }),
  );
  return agent;
}

// Create accepts the config plus the optional non-versioned metadata
// (`description`, `shared`) - read off the raw body server-side, not the config.
export async function createAgent(
  config: AgentConfig & { description?: string; shared?: boolean; managers?: string[] },
): Promise<CreateAgentResponse> {
  return managed<CreateAgentResponse>(() =>
    fetch(`${BASE}/agents`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(config),
    }),
  );
}

// The patch body is a partial config plus the non-versioned `description`
// (which lives on the agent record, not in config, so it never bumps a version).
export async function updateAgent(
  id: string,
  patch: UpdateAgentRequest & { description?: string },
): Promise<Agent> {
  const { agent } = await managed<{ agent: Agent }>(() =>
    fetch(`${BASE}/agents/${id}`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(patch),
    }),
  );
  return agent;
}

/** Everything the Slack setup panel needs: the derived state + the manifest to paste. */
export interface SlackSetup {
  state: "manifest_ready" | "url_verified" | "needs_bot_token" | "verified" | "live";
  manifest: Record<string, unknown>;
  requestUrl: string;
  requestedScopes: string[];
  hasBotToken: boolean;
  appId?: string;
  teamId?: string;
  teamName?: string;
  botUserId?: string;
  grantedScopes?: string[];
  urlVerified: boolean;
  channels: string[];
  allChannels: boolean;
}

export async function getSlackSetup(id: string): Promise<SlackSetup> {
  return managed<SlackSetup>(() => fetch(`${BASE}/agents/${id}/slack`, { headers: authHeaders() }));
}

/** Store + verify the two Slack credentials. Returns the workspace we actually connected to. */
export async function putSlackCredentials(
  id: string,
  body: { botToken: string; signingSecret: string },
): Promise<{ teamId: string; teamName: string; botUserId: string; grantedScopes: string[] }> {
  return managed(() =>
    fetch(`${BASE}/agents/${id}/slack/credentials`, {
      method: "PATCH",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** Set the channel allowlist. Each id is validated against the connected workspace. */
/** Forget the Slack app entirely: clears the credentials and everything it taught us. */
export async function disconnectSlack(id: string): Promise<void> {
  await managedVoid(() =>
    fetch(`${BASE}/agents/${id}/slack`, { method: "DELETE", headers: authHeaders() }),
  );
}

/** The channels the bot can see, for the picker. Needs no extra Slack scope. */
export async function listSlackChannels(
  id: string,
): Promise<{ channels: { id: string; name: string; isPrivate: boolean; isMember?: boolean }[]; truncated: boolean }> {
  return managed(() => fetch(`${BASE}/agents/${id}/slack/channels`, { headers: authHeaders() }));
}

export async function putSlackChannels(
  id: string,
  channels: string[],
  allChannels = false,
): Promise<{ channels: string[]; allChannels: boolean }> {
  return managed(() =>
    fetch(`${BASE}/agents/${id}/slack/channels`, {
      method: "PATCH",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ channels, allChannels }),
    }),
  );
}

export async function listVersions(id: string): Promise<AgentVersion[]> {
  const { versions } = await managed<{ versions: AgentVersion[] }>(() =>
    fetch(`${BASE}/agents/${id}/versions`, { headers: authHeaders() }),
  );
  return versions;
}

export async function restoreVersion(id: string, version: number): Promise<Agent> {
  const { agent } = await managed<{ agent: Agent }>(() =>
    fetch(`${BASE}/agents/${id}/versions/${version}/restore`, {
      method: "POST",
      headers: authHeaders(),
    }),
  );
  return agent;
}

/** Operational metrics for an agent over a window in `hours`, optionally scoped to one version. */
export async function getMetrics(id: string, hours = 24, version?: number): Promise<MetricsSummary> {
  const q = new URLSearchParams({ hours: String(hours) });
  if (version !== undefined) q.set("version", String(version));
  return managed<MetricsSummary>(() =>
    fetch(`${BASE}/agents/${id}/metrics?${q}`, { headers: authHeaders() }),
  );
}

/** Past runs for an agent, newest first (the Monitor run list). */
export async function listRuns(id: string, limit?: number): Promise<AgentRunsResponse> {
  const q = limit === undefined ? "" : `?limit=${limit}`;
  return managed<AgentRunsResponse>(() => fetch(`${BASE}/agents/${id}/runs${q}`, { headers: authHeaders() }));
}

/** One past run's trajectory (live rows while fresh, the S3 archive after). */
export async function getRunTrace(id: string, runId: string): Promise<AgentRunTrace> {
  return managed<AgentRunTrace>(() =>
    fetch(`${BASE}/agents/${id}/runs/${encodeURIComponent(runId)}`, { headers: authHeaders() }),
  );
}

/**
 * Mint a new agent key, invalidating the old one. The plaintext comes back ONCE
 * here, and also stored - so rotation is how you INVALIDATE a leaked key, not how you recover a
 * lost one (a lost key is prefilled on the Run tab).
 */
export async function rotateAgentKey(id: string): Promise<string> {
  const { apiKey } = await managed<RotateKeyResponse>(() =>
    fetch(`${BASE}/agents/${id}/rotate-key`, { method: "POST", headers: authHeaders() }),
  );
  return apiKey;
}

export async function deleteAgent(id: string): Promise<void> {
  await managedVoid(() => fetch(`${BASE}/agents/${id}`, { method: "DELETE", headers: authHeaders() }));
}

export async function listAccessTokens(): Promise<AccessToken[]> {
  const { tokens } = await managed<{ tokens: AccessToken[] }>(() =>
    fetch(`${BASE}/tokens`, { headers: authHeaders() }),
  );
  return tokens;
}

export async function createAccessToken(body: CreateAccessTokenRequest): Promise<CreateAccessTokenResponse> {
  return managed<CreateAccessTokenResponse>(() =>
    fetch(`${BASE}/tokens`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    }),
  );
}

export async function deleteAccessToken(id: string): Promise<void> {
  await managedVoid(() => fetch(`${BASE}/tokens/${id}`, { method: "DELETE", headers: authHeaders() }));
}

export async function listSkills(): Promise<Skill[]> {
  const { skills } = await managed<{ skills: Skill[] }>(() =>
    fetch(`${BASE}/skills`, { headers: authHeaders() }),
  );
  return skills;
}

export async function createSkill(input: SkillInput): Promise<Skill> {
  const { skill } = await managed<{ skill: Skill }>(() =>
    fetch(`${BASE}/skills`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(input),
    }),
  );
  return skill;
}

export async function updateSkill(id: string, input: SkillInput): Promise<Skill> {
  const { skill } = await managed<{ skill: Skill }>(() =>
    fetch(`${BASE}/skills/${id}`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(input),
    }),
  );
  return skill;
}

export async function deleteSkill(id: string): Promise<void> {
  await managedVoid(() => fetch(`${BASE}/skills/${id}`, { method: "DELETE", headers: authHeaders() }));
}

export async function listIntegrations(): Promise<Integration[]> {
  const { integrations } = await managed<{ integrations: Integration[] }>(() =>
    fetch(`${BASE}/integrations`, { headers: authHeaders() }),
  );
  return integrations;
}

export async function createIntegration(input: IntegrationInput): Promise<Integration> {
  const { integration } = await managed<{ integration: Integration }>(() =>
    fetch(`${BASE}/integrations`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(input),
    }),
  );
  return integration;
}

export async function updateIntegration(id: string, input: IntegrationInput): Promise<Integration> {
  const { integration } = await managed<{ integration: Integration }>(() =>
    fetch(`${BASE}/integrations/${id}`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(input),
    }),
  );
  return integration;
}

export async function deleteIntegration(id: string): Promise<void> {
  await managedVoid(() => fetch(`${BASE}/integrations/${id}`, { method: "DELETE", headers: authHeaders() }));
}

/** Re-fetch a discovered integration's spec and reconcile (server keeps the stored selection). */
export async function refreshIntegration(id: string): Promise<Integration> {
  const { integration } = await managed<{ integration: Integration }>(() =>
    fetch(`${BASE}/integrations/${id}/refresh`, { method: "POST", headers: authHeaders() }),
  );
  return integration;
}

/**
 * Preview a discovery URL without saving: returns the full catalog (all enabled) for
 * the picker. Sends the entered `auth` + `secret` so an auth-gated spec fetches (the
 * spec is often behind the same credential as the API); `integrationId` lets an edit
 * fall back to the stored secret when it isn't re-entered.
 */
export async function discoverOperations(
  url: string,
  opts: { auth?: IntegrationAuth; secret?: string; integrationId?: string; baseUrl?: string } = {},
): Promise<{ provider: string; operations: DiscoveredOperation[] }> {
  return managed<{ provider: string; operations: DiscoveredOperation[] }>(() =>
    fetch(`${BASE}/integrations/discover`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        url,
        ...(opts.auth ? { auth: opts.auth } : {}),
        ...(opts.secret ? { secret: opts.secret } : {}),
        ...(opts.integrationId ? { integrationId: opts.integrationId } : {}),
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      }),
    }),
  );
}

export async function invokeAgent(
  id: string,
  apiKey: string,
  prompt: string,
  sessionId?: string,
): Promise<InvokeResponse> {
  const r = await fetch(`${BASE}/agents/${id}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ prompt, sessionId }),
  });
  return json<InvokeResponse>(r);
}

export async function pollSession(
  id: string,
  apiKey: string,
  sessionId: string,
  after?: string,
): Promise<PollResponse> {
  const url = new URL(`${BASE}/agents/${id}/sessions/${sessionId}`, window.location.origin);
  if (after) url.searchParams.set("after", after);
  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${apiKey}` } });
  return json<PollResponse>(r);
}

// ---- Org model ------------------------------------------------------------

/** Bootstrap: who am I, my orgs + roles, and the active org (per the header). */
export async function getMe(): Promise<Me> {
  return managed<Me>(() => fetch(`${BASE}/me`, { headers: authHeaders() }));
}

export async function createOrg(name: string): Promise<Org> {
  const { org } = await managed<{ org: Org }>(() =>
    fetch(`${BASE}/orgs`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name }),
    }),
  );
  return org;
}

// Note: org rename + delete routes exist server-side but have no UI yet, so no
// client wrappers here (added when an org-settings page lands - no dead code).

export async function listMembers(orgId: string): Promise<Member[]> {
  const { members } = await managed<{ members: Member[] }>(() =>
    fetch(`${BASE}/orgs/${orgId}/members`, { headers: authHeaders() }),
  );
  return members;
}

export async function updateMemberRole(orgId: string, userId: string, role: Role): Promise<void> {
  await managedVoid(() =>
    fetch(`${BASE}/orgs/${orgId}/members/${userId}`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ role }),
    }),
  );
}

export async function removeMember(orgId: string, userId: string): Promise<void> {
  await managedVoid(() =>
    fetch(`${BASE}/orgs/${orgId}/members/${userId}`, { method: "DELETE", headers: authHeaders() }),
  );
}

export async function listOrgInvites(orgId: string): Promise<Invite[]> {
  const { invites } = await managed<{ invites: Invite[] }>(() =>
    fetch(`${BASE}/orgs/${orgId}/invites`, { headers: authHeaders() }),
  );
  return invites;
}

export async function inviteMember(orgId: string, email: string, role: Role): Promise<Invite> {
  const { invite } = await managed<{ invite: Invite }>(() =>
    fetch(`${BASE}/orgs/${orgId}/invites`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ email, role }),
    }),
  );
  return invite;
}

export async function rescindInvite(orgId: string, email: string): Promise<void> {
  await managedVoid(() =>
    fetch(`${BASE}/orgs/${orgId}/invites/${encodeURIComponent(email)}`, {
      method: "DELETE",
      headers: authHeaders(),
    }),
  );
}

/** My pending invites (matched to my login email). */
export async function listMyInvites(): Promise<Invite[]> {
  const { invites } = await managed<{ invites: Invite[] }>(() =>
    fetch(`${BASE}/invites`, { headers: authHeaders() }),
  );
  return invites;
}

export async function acceptInvite(orgId: string): Promise<void> {
  await managedVoid(() => fetch(`${BASE}/invites/${orgId}/accept`, { method: "POST", headers: authHeaders() }));
}

export async function declineInvite(orgId: string): Promise<void> {
  await managedVoid(() => fetch(`${BASE}/invites/${orgId}/decline`, { method: "POST", headers: authHeaders() }));
}
