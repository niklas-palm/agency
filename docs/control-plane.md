# Control plane

`apps/control-plane` is one Hono app that runs identically locally (Node HTTP server,
`server.ts`) and in prod (Lambda via `hono/aws-lambda`, `lambda.ts`). The composition root
`app.ts` picks the scheduler + invoker implementations from `MODE`. A small shared-runtime
pool (one public, one isolated - picked per agent by `config.networkMode`) backs every agent,
so there's no per-agent provisioner.

## Endpoints

Every management request acts within one **organization**, selected by the
`X-Agency-Org: <orgId>` header (validated against membership; absent → the caller's
personal org; a PAT is pinned to its bound org and ignores the header). The **Scope**
column is the capability the route requires - the caller holds it if their **role**
grants it (`viewer → read`; `editor`/`admin` → `read`/`write`/`delete`), a PAT further
narrowed by its own scopes. Per-resource visibility/writability then applies via
`canView`/`authorize` (see docs/auth.md).

| Method + path                                   | Auth            | Scope / role   | Purpose                              |
|-------------------------------------------------|-----------------|----------------|--------------------------------------|
| `POST /agents`                                  | JWT or PAT      | `write` | Create agent; returns one-time key   |
| `GET /agents`                                   | JWT or PAT      | `read`  | List the org's visible agents        |
| `GET /agents/:id`                               | JWT or PAT      | `read`  | Agent detail (config + metrics)      |
| `PATCH /agents/:id`                             | JWT or PAT      | `write` | Update config (applies next session) |
| `DELETE /agents/:id`                            | JWT or PAT      | `delete`| Delete agent (schedule + record; no per-agent runtime to tear down) |
| `POST /agents/:id/rotate-key`                   | JWT or PAT      | `write` | Rotate the API key                   |
| `GET /agents/:id/versions`                      | JWT or PAT      | `read`  | List config versions (newest first)  |
| `POST /agents/:id/versions/:v/restore`          | JWT or PAT      | `write` | Restore a version (appends a new one) |
| `GET /agents/:id/metrics?hours=&version=`       | JWT or PAT      | `read`  | Aggregated operational metrics        |
| `GET /agents/:id/runs?limit=`                   | JWT or PAT      | `read`  | Past runs, newest first (durable)     |
| `GET /agents/:id/runs/:runId`                   | JWT or PAT      | `read`  | One past run's trajectory (table, else the S3 archive) |
| `GET /agents/:id/slack`                         | JWT or PAT      | `read`  | Slack setup state + the app manifest to paste |
| `PATCH /agents/:id/slack/credentials`             | JWT or PAT      | `write` | Store + verify the bot token & signing secret (write-only) |
| `PATCH /agents/:id/slack/channels`                | JWT or PAT      | `write` | Set the channel allowlist (each id validated vs the workspace) |
| `POST /tokens`                                  | JWT only        | -              | Create a Personal Access Token (once, bound to the active org) |
| `GET /tokens`                                   | JWT only        | -              | List your tokens (metadata only)     |
| `DELETE /tokens/:id`                            | JWT only        | -              | Revoke a token                       |
| `POST /agents/:id/invoke`                       | agent API key   | -              | Trigger async; returns session id    |
| `GET /agents/:id/sessions/:sessionId?after=`    | agent API key   | -              | Poll status + trajectory delta       |
| `GET /openapi.json`                             | none            | -              | OpenAPI 3.1 spec (built from the shared wire types) |
| `GET /skill.md`                                 | none            | -              | Coding-agent skill: a self-contained Markdown guide |
| `POST /skills`                                  | JWT or PAT      | `write` | Create a reusable skill              |
| `GET /skills`                                   | JWT or PAT      | `read`  | List the org's visible skills (+ usedByAgentCount) |
| `GET /skills/:id`                               | JWT or PAT      | `read`  | Get a skill                          |
| `PATCH /skills/:id`                             | JWT or PAT      | `write` | Update a skill (flows to its agents) |
| `DELETE /skills/:id`                            | JWT or PAT      | `delete`| Delete a skill                       |
| `POST /integrations`                            | JWT or PAT      | `write` | Register a downstream API + credential |
| `GET /integrations`                             | JWT or PAT      | `read`  | List the org's visible integrations (+ usedByAgentCount) |
| `GET /integrations/:id`                         | JWT or PAT      | `read`  | Get an integration (never the secret) |
| `PATCH /integrations/:id`                       | JWT or PAT      | `write` | Update (omit `secret` to keep it)    |
| `DELETE /integrations/:id`                      | JWT or PAT      | `delete`| Delete an integration (destroys the stored credential) |
| `POST /integrations/discover`                   | JWT or PAT      | `write` | Preview a spec URL's operations (stateless; authenticates the fetch) |
| `POST /integrations/:id/refresh`                | JWT or PAT      | `write` | Re-sync a discovered integration's operations |
| `GET /me`                                       | JWT or PAT      | -              | Identity + org memberships (with role) + active org |
| `POST /orgs`                                    | JWT only        | -              | Create a team org (creator becomes admin) |
| `PATCH /orgs/:id`                               | JWT only        | admin          | Rename an org                        |
| `DELETE /orgs/:id`                              | JWT only        | admin          | Delete a team org + cascade (personal orgs can't be deleted) |
| `GET /orgs/:id/members`                         | JWT or PAT      | `read` + member | List an org's members (path org, so any org you're in) |
| `PATCH /orgs/:id/members/:userId`               | JWT only        | admin          | Change a member's role (keeps ≥1 admin) |
| `DELETE /orgs/:id/members/:userId`              | JWT only        | admin          | Remove a member (keeps ≥1 admin)     |
| `POST /orgs/:id/invites`                        | JWT only        | admin          | Invite someone by email              |
| `GET /orgs/:id/invites`                         | JWT only        | admin          | List an org's pending invites        |
| `DELETE /orgs/:id/invites/:email`               | JWT only        | admin          | Rescind a pending invite             |
| `GET /invites`                                  | JWT only        | -              | My pending invites (matched to my login email) |
| `POST /invites/:orgId/accept`                   | JWT only        | -              | Accept an invite → become a member   |
| `POST /invites/:orgId/decline`                  | JWT only        | -              | Decline an invite                    |

The org/member/invite routes name the org in the *path*, so role is checked in the
**path org** (`requireOrgRole`), which may differ from the active-org header;
management actions add `requireOrgRole("admin")` + `requireUser` (JWT-only, like token
management - a PAT can't invite people or delete an org). A non-member of the path
org gets `404` (don't leak existence); insufficient role gets `403`.

The OpenAPI document is authored in `packages/shared/src/openapi.ts` (beside the
wire types it describes, so they stay in sync) and served with the deployed
origin as its `servers` URL. It's public so a code assistant or SDK generator
can fetch it; the web Docs page links to it ("point your AI assistant here").

`GET /skill.md` serves the **coding-agent skill** - a single self-contained
Markdown guide (built by `packages/shared/src/skill.ts` from the same scope +
model source of truth, so it can't drift) covering what Agency is, auth + scopes,
agent config, and copy-paste recipes, pointing to `/openapi.json` for exact
schemas. It's the one reference we hand a coding agent; the Docs page offers it as
a download.

## Auth

Two schemes, deliberately separate (full detail + how to extend in `docs/auth.md`):

- **Management routes** require either a Cognito JWT (interactive user or **M2M**
  client-credentials, verified via `jose`) **or** a **Personal Access Token** (`agpat_…`,
  looked up by hash). Both resolve to a principal whose scopes come from the caller's
  **role** in the active org (`viewer → read`; `editor`/`admin` → `read`/`write`/`delete`);
  a PAT is further narrowed by its own minted scopes and pinned to one org. There is **no
  JWT bypass** - a viewer genuinely lacks write. Each route declares the scope it needs via
  `requireScope(...)`, so a PAT handed to a coding assistant is least-privilege.
  `requireAuth` is attached to the *exact* management routes, never a glob - a glob would
  wrongly catch the API-key routes.
- **Org- and token-management routes** are JWT-only (`requireUser`): a PAT cannot mint more
  tokens, escalate its own scopes, invite members, or manage an org - only an interactive
  login can. Org config (rename/delete, member roles, invites) additionally requires the
  `admin` role in the path org (`requireOrgRole`).
- **Invoke + poll** are authed by the agent's own API key (SHA-256 hashed at rest,
  timing-safe compared), so an external client can trigger exactly one agent without
  platform credentials.

Locally, `AUTH_DISABLED=true` bypasses auth entirely (never set in prod - the app refuses to
start unless `PUBLIC_API_URL`'s host is loopback; see docs/auth.md) - note this means
scope enforcement can only be exercised on a deployed, auth-enabled stack (see the
`scope-mw` unit tests for deterministic coverage).

## Config immediacy

`PATCH` writes the new config to DynamoDB. Every field takes effect on the agent's next
invoke, because the control-plane sends the current config (+ resolved skills + resolved
integration manifests + version) in the invoke payload to the shared runtime - no redeploy,
no re-provision, no runtime read of the agents table. There is no per-agent image to re-bake: the platform image is shared and
updated on deploy, reaching all agents at once. `networkMode` is the exception to "config
just rides the payload": it selects WHICH runtime the invoke targets (public vs the isolated
VPC runtime with no public egress), so switching it moves the agent to the other runtime on
its next invoke. `normalizeConfig` forces `webSearch`/`networkAccess` off in isolated mode.

## Triggers

An agent's config carries `triggers: Trigger[]` - a discriminated union so new managed
triggers slot in without reshaping config (see docs/triggers.md). Always present: an `api`
trigger (the per-agent API key). Optional today: a `schedule` trigger (EventBridge
Scheduler). On create/patch the control-plane reconciles the schedule through the
`ScheduleProvisioner` seam (prod = one EventBridge schedule per agent → the trigger Lambda;
local = no-op). Legacy records that predate the list (`config.trigger` string) are
up-migrated to `[{type:"api"}]` at read time in `toPublic`.

## Invoke outcomes

`POST /invoke` returns immediately with one of three statuses (see docs/injection.md for
the mechanism): `triggered` (started a fresh turn), `injected` (added to the running turn),
or `rejected` (the session's mailbox is at capacity - back off and retry).

**Invoking is not idempotent**, which shapes how failures are reported: a second invoke on
the same `sessionId` is *injected* into the running turn, so a blind retry makes the agent
see the prompt twice. So the invoker retries only errors that mean the request was rejected
before any work started (`ResourceNotReady`/`ConflictException`/`ThrottlingException`, with
jittered backoff), and deliberately does NOT retry a client-side timeout even when the AWS
SDK flags it `$retryable` - a timeout leaves the outcome unknown. The route reports that case
as **504** with the `sessionId`, so the client polls that session to see whether the turn
started rather than duplicating the prompt.

## Poll status (`working` vs `idle`)

A poll reports `idle` only once the client HOLDS the terminal (`session_end`/`error`) event -
otherwise it would stop polling and miss the final answer. So a session whose terminal event
exists but hasn't been delivered to this client yet still reads `working` (`tailStatus`).

**Abandoned sessions.** A microVM can die (crash, reclaim, OOM) without writing a terminal
event, which would leave the session `working` forever and a client polling it forever. When
the session's newest event is non-terminal and older than 30 minutes, the poll path writes a
synthetic terminal `error` ("the session stopped responding") and delivers it in that same
reply, so the client learns why and stops. The window is deliberately generous: the runtime
emits an event per text block and per tool call, so 30 minutes of total silence means the
process is gone - but a single very long tool call must not be declared dead. The check
requires the tail to be non-terminal, so a normally-finished session is never given a second,
contradictory terminal event. *Residual:* this closes the client-visible hang, not the metrics
gap - no session-summary row is written, so an abandoned session still doesn't count toward
error rates (`ControlPlaneFn` holds READ-only on the sessions table by design).

## Internal ingest + integrations proxy (`/internal`)

The runtime holds no AWS table access, so it POSTs telemetry (trajectory + session summaries)
and integration calls to `/internal` routes on the control-plane, authed by the **per-session
capability token** minted at invoke (HMAC over `(orgId, agentCreatedBy, agentId, sessionId)` +
granted `integrationIds`, ~9h TTL; sent as `X-Agency-Ingest-Token`). These routes are NOT
scope-gated - the token is the credential.

- **`POST /internal/trajectory`** + **`POST /internal/session-summary`** - trajectory events +
  session summaries (see docs/metrics.md).
- **`POST /internal/integrations/call`** - the integrations proxy.
- **`POST /internal/slack/call`** - the Slack proxy: the agent's only route to Slack, so the bot
  token never enters the runtime. The target channel + thread are derived from the token's
  `sessionId` (a Slack session id *is* `slack-<channel>-<threadTs>`), not from the body - so
  there is no channel parameter for a prompt-injected agent to aim elsewhere.
  Verifies the token, checks the requested `integrationId` is in its granted set (else 403),
  loads the integration record scoped to the token's `orgId` and re-checks it's still visible
  to the agent's creator (`agentCreatedBy` - graceful if un-shared since attach; 404 if
  deleted), injects the stored credential, and forwards
  ONLY to the integration's `baseUrl` + declared operation path (URL re-validated to stay under
  base origin+path - the SSRF anchor). Returns the downstream status + a size-capped body. See
  docs/integrations.md.

In prod these are reached over a small public HTTP API (public runtime) or a VPC-private REST
API via PrivateLink (isolated runtime). The verifying Lambda (`IngestFn`) holds the two
telemetry table writes, **read** on the trajectory table (to pull a run's events for the
archive), **PUT-only** on the traces bucket, and **read-only** on the integrations table.

## Error responses

Transient AWS errors (throttling, conflict, not-ready, or an SDK-flagged retryable / a
429/500/503 status) are mapped by `app.onError` to **HTTP 503** so callers can tell "retry
me" apart from a permanent failure; everything else is a generic **500** (no stack leaked).

## Session ids

AgentCore requires `[a-zA-Z0-9_-]{33,100}`. `session-id.ts` generates compliant ids when
none is supplied. A client-supplied id must already be compliant - the invoke route rejects
non-compliant ids with a 400 rather than coercing them (lossy coercion could map two
distinct ids onto one session and merge unrelated conversations).
