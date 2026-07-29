# Agency

A managed platform for no/low-code creation of agents. Users create agents in a UI; each
agent runs in an isolated **AWS Bedrock AgentCore** microVM, is built with the **Strands
Agents SDK (TypeScript)**, and is invoked asynchronously via a public API that returns
immediately with a session id the client polls for status + trajectory. New messages on a
working session are **injected mid-turn**. Everything is TypeScript; infra is CDK; auth is
Cognito.

## Where things live

```
apps/control-plane   Hono API (Node locally, Lambda in prod). Create/list/update/invoke/poll.
apps/agent-runtime   Strands agent on AgentCore. A shared runtime backs every agent (one
                     PUBLIC + one ISOLATED/VPC, picked by config.networkMode); agentId +
                     config + skills + integrations + version arrive in the invoke payload.
apps/sample-api      A tiny pet-store Hono API - a REMOVABLE demo/E2E target for integrations
                     (its own CDK stack; the sample-api docker-compose service locally).
apps/web             React + Vite SPA (Tailwind "Studio" editorial design - warm cream/marigold/pine,
                     Hanken Grotesk + Fraunces eyebrow + IBM Plex Mono, a compass mark). Signed-out
                     visitors see a landing page (no auto-redirect) + can read the public Docs page;
                     sign-in is our own in-app SRP login form (amazon-cognito-identity-js - no
                     hosted-UI redirect; the password never leaves the browser). Admin-created
                     users get a temp password by email + are forced to change it on first sign-in;
                     forgot-password recovers via emailed code. Cognito stays the identity store.
                     Roster + agent detail (Monitor - incl. a past-runs list you open to replay a
                     finished run's trajectory - / Run/Configure/Versions/Integrate tabs) + Skills + Integrations
                     pages + a Docs guide page (how-it-works cards + TS/Python recipes; links to
                     the public GET /openapi.json spec and downloads the GET /skill.md coding-agent
                     skill) + a Settings page (Personal Access Tokens for programmatic access).
                     A top-bar org switcher selects the active org (X-Agency-Org header) + a
                     Members page (roles + invites); controls are role-gated (viewer = read-only - a read-only
                     form renders DISABLED with a line saying why, not merely un-savable),
                     a failed /me shows an error + retry rather than silently denying every write,
                     and resources carry a per-resource share toggle.
packages/shared      Wire types (dependency-free), incl. the MODELS map + the org model (org.ts:
                     Role, scopesForRole).
infra                CDK: AgencyAuth, AgencyData (agents/trajectory/tokens/versions/sessions/
                     skills/integrations + orgs/memberships/invites tables + the traces bucket
                     that outlives the trajectory table's TTL - traces are kept FOREVER,
                     no lifecycle expiry), AgencyControlPlane,
                     AgencyWebSearch (a us-east-1 web-search gateway reached cross-region),
                     AgencyWeb, AgencyWebCert (the us-east-1 CloudFront cert, only when a
                     custom domain is configured - `-c domainName=… -c hostedZoneId=…`;
                     the API's cert is regional and lives in AgencyControlPlane),
                     AgencySampleApi (opt-in, `-c sampleApi=true`).
scripts              ensure-tables, e2e, models-e2e, mint-m2m-token.
.github/             CI (typecheck + tests, no AWS creds) + CD on merge to main via OIDC.
                     Two deploy paths: UI-only (build + s3 sync + CDN invalidate) vs full
                     `cdk deploy --all`. The rule is a TESTED script
                     (.github/scripts/deploy-scope.sh) - see docs/deployment.md.
docs/                Living documentation - the reference for WHY, and part of every change
                     (standing rules 4-6). Start at docs/architecture.md.
README.md            The public front door. LICENSE (Apache-2.0) + NOTICE + SECURITY.md +
                     CONTRIBUTING.md exist for an open-source release; SECURITY.md is where
                     the accepted trade-offs are stated for a deployer.
```

## Read the docs

`docs/` is the reference, not background reading - it holds the *why* behind decisions the
code can only show you the *what* of. Read the page for the area you're touching BEFORE
changing it, and update it in the same change (standing rule 4). Most rules below name the
page they belong to.

- `docs/architecture.md` - components, request lifecycle, the local⇄prod seams.
- `docs/runtime.md` - the agent harness, session model, trajectory.
- `docs/injection.md` - how mid-turn injection works (the load-bearing feature).
- `docs/models.md` - the model factory; OpenAI-via-Bedrock-Mantle (keyless).
- `docs/control-plane.md` - endpoints, the two auth schemes, config immediacy.
- `docs/auth.md` - credential kinds (JWT / Personal Access Token / agent key), the roles ×
  scopes authority model, per-resource visibility (`canView`/`canWrite`/`authorize`), and how
  to extend it.
- `docs/org-model.md` - the organization data model: orgs/memberships/invites tables, the
  personal-org bootstrap, invite + cascade lifecycle, and the org access patterns.
- `docs/data-model.md` - every store in one map: the ten tables + the traces bucket, why each
  key is what it is, retention + what survives a delete, and the local⇄prod parity gaps.
- `docs/metrics.md` - agent config versioning + the operational-metrics engine (the
  agent-versions + agent-sessions tables, the session-summary write path, dashboards).
- `docs/triggers.md` - how agents get invoked (api + schedule + slack; the managed-trigger seam).
- `docs/integrations.md` - downstream-API integrations: the proxy that holds the credential,
  the manifest-based discovery, the SSRF anchor, and the sample API.
- `docs/local-dev.md` - running the full replica locally.
- `docs/deployment.md` - CDK stacks, IAM, runtime readiness, M2M token minting.

## How the system works (one paragraph)

An agent is pure config in DynamoDB - creating one is a DynamoDB write, no per-agent infra.
A small shared AgentCore runtime pool (owned by CDK - one public, one isolated/VPC, picked by
`config.networkMode`) backs every agent; invoking an agent posts to the chosen runtime with
the agentId + config + skills + integrations + version in the payload and returns a session id. The
control-plane records the user's `prompt` event at invoke time (so it shows for every agent,
image-independent); the runtime streams its actions to the control-plane's ingest API, which
records them in a trajectory table keyed by (sessionId, UUIDv7) so clients poll deltas with
`after=<cursor>`. AgentCore still isolates
each session in its own microVM, so a runtime *process* serves exactly one session: a single
warm Agent keeps conversation state, and a `BeforeModelCallEvent` hook drains the mailbox to
inject mid-turn messages. Model choice is a one-line entry in `packages/shared`'s MODELS map,
resolved by `agent-runtime/src/model.ts` (Bedrock for Anthropic, Bedrock Mantle for OpenAI -
keyless, but it DOES need the `@aws/bedrock-token-generator` runtime dep: Strands declares it an
optional peer and imports it lazily, so a missing install fails mid-turn rather than at boot -
see docs/models.md).

## Organizations (the top ownership hierarchy)

Every resource (agent/skill/integration) lives in one **organization** and carries
`orgId` + `createdBy` + `shared`. Every user has a personal org (auto-created lazily, id ==
their userId, non-deletable) and can create team orgs and invite others by email (inviting a
new email lazily provisions a Cognito login via the `IdentityProvider` seam - which also
resolves a member's userId back to an email for the roster - and Cognito emails
them a temp password; an existing user is a no-op, idempotent). Membership
carries a **role** - `viewer` (read-only), `editor` (create + manage what they created), or
`admin` (+ manage any shared resource, members, and org settings). VISIBLE = same org AND
(`shared` OR you created it) - admin does NOT pierce privacy; WRITABLE = visible AND (you
created it OR admin OR a listed manager - each resource carries an optional `managers?`
userId list that only GRANTS extra writers, never piercing privacy), so an editor can't
edit a co-member's shared resource unless named a manager. The active org
rides the `X-Agency-Org` header (validated vs membership every request; absent → personal).
A JWT no longer bypasses scopes - it carries its role's scope set (`scopesForRole`); a PAT is
bound to one org at mint and its effective scopes = token scopes ∩ role scopes, with
membership re-checked every request (removal/role change is immediate). Name uniqueness is per-org for skills +
integrations (agents aren't name-checked). See docs/org-model.md (data model + lifecycle) + docs/auth.md (authorization).

## Standing rules

These aren't style preferences - they're why this codebase is still legible. `CONTRIBUTING.md`
states the same rules for human contributors; if you change one, change both.

### Simplicity first

1. **Prefer the simpler solution**, without sacrificing functionality. Before adding code,
   stop and ask whether there's a smaller way. Readability, simplicity, and clear structure
   beat cleverness every time.
2. **Don't over-engineer.** Don't add abstraction, configuration, or generality for a case
   nobody has asked for. Solve the problem in front of you; the seams below already exist
   for the extensions we actually expect. Defensive code for a scenario that can't happen is
   pure cost - if a migration path or back-compat shim is genuinely needed, say why and keep
   it; otherwise delete it. **There is no backwards-compatibility requirement in this
   project** unless a specific stored record or deployed client demands one.
3. **No dead or stale code.** Delete unused code, don't comment it out. When a workaround
   stops being necessary, remove it. Same for now-unused exports, env vars, and types - if
   CDK sets an env var nothing reads, one of the two is wrong.

### Documentation is part of the change

4. **Keep the docs current, in the same change.** Change how something works → update the
   relevant `docs/*.md` **and this file** alongside the code. This explicitly includes the
   **OpenAPI spec** (`packages/shared/src/openapi.ts`) and the **coding-agent skill**
   (`packages/shared/src/skill.ts`): any API surface change (endpoint, wire type, scope,
   model, auth) must reach both, so the machine-readable contract and the skill we hand
   coding agents can't drift from the code.
5. **Docs are scoped to the REPO, not the diff.** Staleness lives in files your change never
   touched. After changing behavior, grep for claims it just falsified - topology statements,
   stack/table lists, env-var references, retention numbers, command/flag docs, the test
   count in `README.md`. A diff-scoped check is structurally blind to this and is the single
   most common way wrong docs ship here.
6. **Comments describe the *current* implementation, never a past one.** A comment explaining
   why the code used to be different is worse than no comment. Comments explain *why*, not
   *what* - the code says what. Where something is subtle, say so and say why; the existing
   prose density is deliberate.

### Architecture

7. **Respect the seams.** New cross-boundary behavior goes through the existing interfaces -
   `AgentInvoker`, `ScheduleProvisioner`, `IdentityProvider`, `DiscoveryProvider`, the MODELS
   map (`docs/models.md`), the shared wire types - don't bypass them. See
   `docs/architecture.md` for what each seam separates and `docs/triggers.md` /
   `docs/integrations.md` for the two most recently extended ones.
8. **The local stack stays a faithful replica of prod.** Both run one shared runtime (prod
   the CDK-owned AgentCore runtime, local the docker-compose container). A change that works
   only in one is a bug; a deliberate divergence is documented in `docs/local-dev.md` (and
   the data-store gaps in `docs/data-model.md`).
9. **Tools never throw.** An agent tool returns `{ error, hint }` so the model can adapt - a
   thrown exception reaches it as an opaque stack trace instead. See `docs/runtime.md`.
10. **Authorization is decided from the record.** Every tenant-owned resource carries
    `orgId` + `createdBy` + `shared`; go through `canView`/`canWrite`/`authorize` rather than
    hand-rolling a check. Read `docs/auth.md` before touching an auth path and
    `docs/org-model.md` before touching org data.
11. **Every tenant-supplied outbound URL goes through `outbound.ts`.** It's the single SSRF
    anchor (`isBlockedHost`/`validateOutboundUrl`/`guardedFetch`) - see
    `docs/integrations.md`. Never add a second fetch path with its own validation.
12. **Secrets never enter the runtime's process env** and never reach a read response.
    `run_bash` can read `/proc/1/environ`, so the env fence isn't the boundary - see
    `docs/runtime.md`. Credentials are hashed at rest or write-only; `config.env` values are
    redacted for non-writers (`docs/auth.md`).

### Verification

13. **Verify end to end.** After a non-trivial change run `npm run e2e:local` - the E2E is
    the contract (create → invoke → poll → inject → assert). For infra/runtime changes also
    run the AWS E2E. `RUN_INTEGRATION=1` adds the integrations round-trips; see
    `docs/local-dev.md` for the full list of E2E scripts and what each needs.
14. **A bug fix comes with a regression test that fails without the fix.** Revert the fix
    briefly and confirm the test catches it. A test that passes for the wrong reason is worse
    than no test - this repo has shipped several (a truncation test that tripped a different
    cap; a parity test that passed while both sides were wrong identically; a mock that
    re-implemented the function it claimed to be testing).
15. **Mock at the repository boundary (`repo/*.ts`), not the AWS SDK**, and make the fake
    faithful. Mocking a conditional write as always-succeeding hides exactly the bug the
    condition exists to prevent. When a test needs real logic from a mocked module, use
    `vi.importActual` and override only the accessors.
16. **Before opening a PR**, all three must be clean:
    ```bash
    npm run typecheck     # every workspace
    npm test              # the full suite
    npm run e2e:local     # anything touching runtime / invoke / trajectory
    ```
    Plus: the relevant `docs/*.md` and this file updated (rules 4-5), a regression test for
    any bug fixed (rule 14), and no scratch files left behind - especially under
    `apps/agent-runtime/src`, which is in the Docker build context, so a stray file changes
    the image hash and shows up as infra drift. For infra changes, include what `cdk diff`
    shows; a clean tree should diff to zero on every stack (five, plus one each for a
    custom domain and `-c sampleApi=true` - see `docs/deployment.md`).
17. **Commit messages say what changed and *why it mattered*** - the failure mode, not the
    diff. Present tense, lowercase subject, no trailing period. `git log` here is
    documentation.

### This repository is PUBLIC

Everything you write here is world-readable the moment it's pushed, and a commit message
cannot be retracted by a later commit - the only remedy is a history rewrite, which is
disruptive once others have cloned. So treat every commit, comment, doc and test fixture as
published. Before committing, check you are not including:

18. **Anything that isn't yours to publish.** No third-party names, email addresses,
    usernames or Slack handles - not in code, not in a commit message, not in a fixture.
    Describe the *behaviour* ("a member's row had no cached email") rather than the person or
    the record you saw it in. Don't quote real user data, ids, or org names read out of a live
    table. **This is not hypothetical:** a colleague's email address in one commit message is
    why this repo's history had to be squashed before release.
19. **Internal or employer-specific references.** No internal tool names, codenames, service
    names, ticket ids, wiki links, or internal hostnames/domains. If a constraint comes from
    an internal system, state the constraint and drop the source ("security tooling flags an
    `authType:NONE` Function URL", not the tool's name).
20. **Live deployment identifiers and credentials.** Never commit an AWS account id, ARN,
    API Gateway id, CloudFront domain, Cognito pool/client id, bucket name, or anything
    credential-shaped. Those are resolved from stack outputs at deploy time, never written into
    tracked config, docs or examples. Test fixtures must be *obviously* synthetic:
    `agpat_test_token_000000`, `example.com`, `000000000000`.

    **The deliberate exception is `infra/cdk.context.json`**, which IS tracked and carries this
    deployment's `domainName` + `hostedZoneId`. Neither is a credential - a domain is public DNS
    and a zone id is useless without account access - and this is a public *sample*, where one
    file a deployer edits beats a mechanism they have to discover. It ships with a comment saying
    to change or delete them, and the no-domain path (delete both) is the documented default. Do
    NOT extend this exception to anything credential-shaped.
21. **Speculation about unfixed weaknesses, outside SECURITY.md.** A published weakness
    inventory is a roadmap for an attacker. Accepted trade-offs go in SECURITY.md,
    deliberately and with their mitigations; a stray "this is probably exploitable if you
    …" in a commit message is a free tip. Genuine findings get fixed, or documented there.

A useful test before you commit: *would I be comfortable if this line were quoted back to me
publicly, out of context?* If not, rewrite it. The local `backlog/` directory is gitignored
precisely because it holds the material that fails this test - never link to it from a tracked
file, and never move its content into one.

## Status

Deployed and verified end-to-end on AWS (eu-north-1), including mid-turn injection on a real
AgentCore microVM. Local docker-compose E2E and the web UI are verified too.

## Versioning + metrics

Every config change appends an immutable snapshot to the **agent-versions** table and bumps
the agent's `version`; invokes always run the latest (version rides the invoke payload).
`applyNewVersion` (routes.ts) is the shared bump+append path for edits and restores; restore
appends the old config as a NEW version (linear history). The bump is a **compare-and-swap**
(`putVersion` claims the (agentId, version) slot; `updateAgent` guards on the expected current
version) with a bounded re-read-and-retry on `ConditionalCheckFailedException`, so two
concurrent PATCHes can't both land on the same version number - which would drop one config
from history and let the live config disagree with the snapshot it points at. Config takes
effect on the next invoke (it rides the payload to the shared runtime - nothing to
re-provision). The non-versioned `description` lives on the agent record (editing it never
bumps a version).

Operational metrics come from the **agent-sessions** table: the runtime accumulates per
microVM lifetime (invocations, turns, tool uses + breakdown, injections, duration, outcome,
token usage + model) and OVERWRITES
one summary row (keyed by agentId+runId) at each idle point - so a session's many triggers
stay one row, and a reused sessionId on a fresh microVM starts a new row (counts runtime
lifetimes, never double-counts). Token usage is read from the Strands Agent's cumulative
accumulator (`agent.metrics.accumulatedUsage`) - stored as the latest snapshot, never summed
(the Meter isn't reset per turn). `GET /agents/:id/metrics?hours=&version=` aggregates these
into a time-bucketed dashboard (hourly buckets up to 7 days, daily beyond; across all versions,
or one), pricing cost read-side per session's model from `MODEL_PRICING` (`costFor`). The web Monitor tab (front and
center on the detail page) + the Versions tab render it. See docs/metrics.md.

**Run history** reuses those same rows: `GET /agents/:id/runs` lists past runs newest-first
(durable - the rows are retained forever) and `GET /agents/:id/runs/:runId` opens one run's
trajectory. Since the trajectory table is TTL'd at 30 days, `IngestFn` archives a run's events
to S3 (`traces/<agentId>/<runId>.json`) whenever it writes that run's summary - keyed by runId,
NOT sessionId, because a client may reuse one sessionId across microVM lifetimes and a
session-keyed object let the later run overwrite the earlier run's trace - and the read path
serves the table first, falling back to the archive (`archived` says which; a transient S3
failure is a retryable 503, not a false "steps are gone"). Traces are kept FOREVER - no
lifecycle expiry, and no Lambda holds `s3:Delete*` - so BOTH the run list and the trace
behind it are durable indefinitely; only a run whose trajectory aged out before archiving
existed returns `events: []`. The accepted cost is unbounded storage growth and indefinite
retention of prompt + tool-IO content (see SECURITY.md). The Monitor tab renders the list; opening a row shows the
same trajectory viewer the live Run tab uses (one line per step, expandable, a tool result folded
into the call it answers by `toolUseId`).

## The Slack trigger

An agent with a `slack` trigger runs when its bot is **@-mentioned** in an allowed channel and
answers in that thread. **One Slack app per agent** - the app IS the agent's identity (its name
and bot user are what people @-mention), which also gives per-agent scopes, revocation, and
several agents co-existing in one channel. The user creates the app by pasting a **complete
manifest we generate** (`packages/shared/src/slack-manifest.ts`: one scope per API method we
actually call - incl. `channels:read`/`groups:read`, which `conversations.info` needs and the
`*:history` scopes do NOT imply, the `app_mention` subscription, and the agent's own webhook URL all baked
in) - so we hold **no Slack app-configuration token**, a credential that could reshape any app
in their workspace and whose single-use/12h rotation needs a retrying agent to survive, not a
self-service form. Setup is a resumable state machine derived from the record, never stored:
`manifest_ready` → `url_verified` → `needs_bot_token` → `verified` → `live` (three
`/agents/:id/slack*` endpoints drive it). `url_verified` arrives unprompted, which is the
moment it feels managed; `verified` shows what Slack ACTUALLY granted (`auth.test`'s
`x-oauth-scopes`); channels are validated against the connected workspace
(`conversations.info`) because a foreign channel id yields an agent that looks configured and
silently ignores every mention.

The webhook (`POST /webhooks/slack/:agentId`) is public - Slack can hold no credential of ours -
so **the HMAC is the whole boundary** (raw body, replay window, constant-time compare).
`url_verification` is the one request that can't be verified (Slack fires it at app-creation,
before we know the signing secret), so `isUrlVerification` refuses any body that also carries an
`event` - without that clause an unsigned request could reach the invoke path. The agentId
therefore rides the URL **path**, which is also why a forged path can't pick another agent's
secret. **One thread = one session** (`slack-<channel>-<threadTs>`), so a follow-up mention is
**injected into the running turn** - the load-bearing feature made visible. The agent never
holds the bot token: six tools (`slack_reply`/`slack_set_status`/`slack_read_thread`/`slack_ask_user`/
`slack_upload_file`/`slack_download_file`) are wired only when the payload carries `fromSlack`, and the control-plane derives the reply target from the session token, so there's
no channel argument to poison. The webhook adds 👀 on receipt (before the run), and the four status
reactions (🟡 working → 🟢 done / 🔴 failed / ❓ needs_input) are mutually exclusive. It all works in
ISOLATED mode too - the agent reaches the proxy over PrivateLink and the control-plane makes the
outbound Slack call, so no egress exception is needed. The channel allowlist is a security control (anyone who can
`/invite` the bot can direct the agent); empty means answer nowhere, and the opt-in
`allChannels` deliberately delegates the gate to whoever can `/invite`. See docs/triggers.md.

## Skills + integrations + env vars

**Skills** are reusable Markdown docs (org-scoped `skills` table, pk=orgId/sk=id, with
createdBy + shared), managed on the Skills page and attached to agents by id
(`config.skillIds`, versioned).
The control-plane resolves ids→content at invoke (`resolve-attachments.ts`, shared by the API
route and the schedule trigger) and passes them in the payload; the runtime
builds Strands `Skill` instances + the `AgentSkills` plugin (progressive disclosure: metadata
in the prompt, full instructions loaded on-demand via a tool). Editing a skill flows to every
agent using it on the next run - content is never copied into config. Skills routes are gated
by the `read`/`write`/`delete` scopes.

**Integrations** are downstream APIs a user onboards once (org-scoped `integrations` table,
pk=orgId/sk=id, with createdBy + shared) and attaches to agents by id (`config.integrationIds`,
versioned) - managed on the Integrations page. The load-bearing property: **the agent never sees the credential.**
An integration stores a `baseUrl`, an `auth` mechanism (`none`/`bearer`/`apiKey` static token /
`oauth2Client` OAuth2 client-credentials m2m - a discriminated union so token-exchange/3-legged
slot in later without reshaping the agent-facing contract), a write-only `secret` (static token,
or the OAuth client secret), and a list of `operations` (the discovery surface + the proxy's grant
unit). Operations are authored two ways: **manually** (a hand-written list) or **auto-discovered**
from a spec URL (`discovery`, behind a reusable `DiscoveryProvider` seam - OpenAPI JSON today - in
`discover-operations.ts`; the stored top-level `operations` is the *enabled subset* of the
discovered catalog, so runtime/proxy never know discovery exists). Discovery has a per-op selection
that survives refresh: first import enables all (or the picked subset), a refresh keeps stored flags
and defaults a newly-appeared op OFF (`POST /integrations/:id/refresh` + a daily EventBridge sweep,
`discovery-sweep-lambda.ts`) - so an evolving upstream API never silently grants a new capability.
Both refresh paths persist via `updateDiscoveryResult` - an UpdateItem touching only the fields
discovery owns, conditioned on `discovery.url` - so a refresh can't revert a user PATCH that
landed during its slow spec fetch (secret/shared/managers/baseUrl), nor apply operations from a
spec the integration no longer points at (route → 409; sweep → `superseded`).
At invoke the control-plane resolves ids→manifest (name + operations, NO
secret/baseUrl) into the payload. An id that's been deleted or un-shared since attach drops
out silently (graceful degradation), but a **read failure fails the invoke** (503 / a retried
schedule tick) rather than starting an agent that has no way to call the API it exists to
call. The runtime surfaces the manifest via the system prompt +
`list_integration_operations` (discovery: "what CAN I call?") and calls an operation with
`call_integration`, which POSTs to the control-plane proxy (`POST /internal/integrations/call` -
the only *integrations* proxy endpoint; the Slack trigger adds `POST /internal/slack/call` on the
same per-session-token pattern). Call args are open per-call (`pathParams`/`query`/`body` - so an agent
pages a listing by varying `query`); an optional `outputPath` writes the response to a
workspace file (confined by the shared `sandboxed()`) instead of into context, so a code agent
fetches data and computes over it with `run_bash` - the runtime sends `largeResponse` and the
proxy uses a 2.5 MiB cap (buffered; sized so the JSON-escaped reply stays under the Lambda ~6 MB
ceiling; a capped body is flagged `truncated` so the agent pages). The system prompt teaches when to
use it (large data / data you'll process / paging). The proxy - authed by the same per-session capability token as
telemetry ingest (its claims carry `orgId` + `agentCreatedBy` + the granted `integrationIds`) -
verifies the agent is allowed, resolves the record by the token's `orgId` and re-checks it's
still visible to the agent's creator (un-sharing degrades gracefully), injects the credential
(for `oauth2Client`, `credentialHeaders` is async: `oauth-token.ts`
mints + caches a short-lived token from `tokenUrl`; the agent never sees the client secret OR the
minted token; it also forwards a non-secret `X-Agency-Agent-Id` provenance header), and forwards
ONLY to `baseUrl` (URL re-validated to stay under
base origin+path - the SSRF anchor; redirects are followed manually, re-validating each hop stays
under base and refusing an off-base one, so a `3xx` can't bounce the proxy - or replay a custom
`apiKey` header - to an internal host). A shared `outbound.ts` (`isBlockedHost`/`validateOutboundUrl`/
`guardedFetch`) is the single SSRF anchor for every tenant-supplied outbound URL - `baseUrl` (via
`normalizeBaseUrl`, refused at `localhost`/literal private/loopback/link-local/metadata IP at
registration), the OAuth `tokenUrl`, and the discovery spec URL (both https-only since they carry a
credential; `guardedFetch` also strips credential headers on a cross-origin redirect and refuses a
cross-origin hop when the credential is in the body). The **discovery fetch** tries UNAUTHENTICATED first and retries with the
integration's credential only if that fails (an API often gates its own spec behind the same
key), via the shared `credentialHeaders` - and only when the spec URL is under `baseUrl`'s origin (`credentialForSpec`,
on every path incl. refresh + the sweep) - else the write-only secret could be aimed at an
attacker host and read from the outbound header. Root guard: since the credential's *sink*
URLs (`baseUrl`, and `tokenUrl` for oauth2Client) are caller-supplied on PATCH, **changing any
sink's origin while keeping a stored secret is rejected** (`credentialSinkOrigins`; re-enter the
credential) - closing the leak across the proxy forward, the discovery fetch, and the OAuth mint.
Works in every network mode (isolated reaches the proxy over PrivateLink). `IngestFn` gets READ-ONLY on the integrations table; the runtime holds no
secret. Routes gated by the `read`/`write`/`delete` scopes. See docs/integrations.md.

**Env vars** (`config.env`, versioned) are injected into the runtime process so the
agent's tools (bash) read them by name and the model is told which keys exist (names only, not
values). For per-agent third-party secrets, so the VALUES are readable only by a caller who can
WRITE the agent (creator/admin/manager) - a viewer or co-member of a shared agent gets the key
names with each value redacted to `***`, on both `GET /agents/:id` and the versions history
(each version is a full config snapshot). **The agent's own API key is gated the same way**: it
is stored in PLAINTEXT and returned on reads to a caller who can write the agent, so the console
prefills it in the Run tab and the integration samples; a viewer of a shared agent doesn't get it
at all (dropped, not starred - a `***` pasted into curl fails confusingly).

That is a deliberate DX-over-secrecy trade, reversing an earlier decision to store only the hash.
The reasoning, so it isn't undone by accident: a deployment has many agents with one key each, so
a key you can see exactly once means re-pasting a different secret per agent per browser - and
people then keep those keys somewhere worse than we would. It gives a writer no authority they
lacked (they could rotate and read the new key anyway) and the key invokes ONE agent. The cost -
a table read yields live keys - is stated in SECURITY.md. The key HASH is still what invoke
verifies against, so the plaintext is never on the auth path.

*Deliberate limit of that redaction:* it covers **config**, not **output**. A trajectory
records what the agent did - prompts, tool inputs, tool results - and an agent that echoes
an env value into a tool call has put it in the trace. Run history is gated on `read`
(anyone who can see the agent can open its past runs), because a team debugging an agent
together needs its trajectory, and the live Run tab already shows the same content to
anyone holding the agent key. So `config.env` is the right place for a secret the platform
should keep out of the config surface - not a guarantee it can never appear in output.
Scrubbing output would be best-effort at best (an agent can transform a value so no
pattern matches) and would read as a stronger promise than it is.

## Deferred (next iterations, against this working spine)

A public/curated skills marketplace + search (today skills are org-scoped, shared within the
org via the `shared` flag; Strands `AgentSkills` also supports HTTPS SKILL.md URLs if a
cross-org shared registry is added), user-defined MCP servers, richer integrations
(downstream-API **integrations** are shipped - incl. OpenAPI auto-discovery of the operation
manifest + OAuth2 client-credentials auth, see docs/integrations.md; still deferred: OAuth
refresh-token/3-legged + token-exchange auth kinds - the `IntegrationAuth` union is built to
extend - and more discovery providers (GraphQL/MCP/YAML)), and the GitHub managed trigger
(stubbed as "Soon" in the triggers UI; `api` + `schedule` + `slack` are wired - see
docs/triggers.md, and a local design doc for GitHub).

**The organization model is shipped** (was deferred as org-scoped resources + who-can-use
governance): resources are org-scoped with `createdBy` + `shared`, memberships carry
admin/editor/viewer roles, users invite by email, and the active org rides the `X-Agency-Org`
header - see the Organizations section above + docs/auth.md. Still deferred: finer-grained
per-resource who-can-use policy beyond the role + shared model.

**Network isolation is wired.** There's a small runtime pool keyed by network mode: the
default PUBLIC runtime (public egress) and an ISOLATED VPC runtime with NO public egress (no
IGW/NAT). An agent's `config.networkMode` ("public" | "isolated") picks the target runtime at
invoke (`runtimeArnFor`); the isolated runtime reaches AWS only via PrivateLink interface
endpoints - bedrock-runtime (Anthropic) for inference, the
bedrock-agentcore data-plane endpoint (the microVM's own invocation/identity plumbing - as
load-bearing as the model endpoints), plus logs/ecr/s3 + execute-api (the private ingest API
for telemetry - no DynamoDB, the runtime role has no table access). So web search, fetch, and
`run_bash` curl all genuinely fail in isolated mode - isolation is enforced at the network,
not just by un-wiring tools. **Region caveat (eu-north-1):** the isolated VPC has NO
bedrock-mantle endpoint (Mantle/OpenAI is us-east-1-only, no cross-region PrivateLink), so
**OpenAI models are unavailable in isolated mode** - Anthropic works in every mode.
`normalizeConfig` forces `webSearch`/`networkAccess` off when
isolated, and the runtime prepends an ISOLATED_PROMPT telling the model there's no internet.
The image bakes in `tsx` (the entrypoint runner) so the no-egress microVM never tries to
download it at boot. See `docs/runtime.md`. The `networkAccess` flag now just records whether web tools are wired (a public-mode
sub-toggle). Fetch (public mode only) via a self-built SSRF-guarded tool. **Web search** works
in the public runtime: the managed AgentCore Web Search connector is us-east-1-only, so its
gateway lives in its own us-east-1 stack (`AgencyWebSearch`) and the eu-north-1 PUBLIC runtime
reaches it cross-region (SigV4-signed to `WEB_SEARCH_REGION=us-east-1`), exactly like
OpenAI/Mantle. So `web_search` is wired in public mode; it stays off in isolated mode (no public
egress) and locally (no gateway), where only `fetch_webpage` runs. The fetch guard
validates the URL, re-validates every redirect hop, and blocks all literal-IP forms
(numeric/octal/hex IPv4, IPv4-mapped/NAT64 IPv6). **Known residual - independent DNS
resolution**: the guard resolves the host once but `fetch` resolves it again, so a hostname
publishing BOTH a public and a private/metadata address (static dual-record - no rebinding
needed) can slip a private connection past the guard. Closing it needs socket-level IP
pinning (a custom undici dispatcher connecting only to the vetted IP); left for later since
it needs attacker-controlled DNS and the agent's `run_bash` is already a wider egress path.
The **integrations proxy** shares this same DNS residual: `normalizeBaseUrl` closes the literal-IP
case (incl. IPv4-mapped/NAT64 IPv6) at registration, but a `baseUrl` *hostname* that resolves to
a private/metadata address still slips through - the same socket-pinning fix would close both.

**Agent deletion** - `DELETE /agents/:id` removes the schedule + record (UI: a confirm-gated
delete on the agent detail page). There's no per-agent runtime to tear down (one shared
runtime), so the orphaned-runtime reaper is no longer a concern.

**Runtime credential isolation.** The runtime's AWS role is **Bedrock-only** - it has NO
DynamoDB access at all. Trajectory events + session summaries are POSTed to the control-plane's
telemetry **ingest API** (a dedicated `IngestFn` Lambda granted the two telemetry table
writes, trajectory READ so it can pull a run's events to archive, and PUT-only on the
traces bucket),
authed by a **per-session capability token** (not a static key): the control-plane / trigger
Lambda MINT an HMAC token scoped to `(agentId, sessionId)` (~9h TTL) at invoke and pass it in
the payload; `IngestFn` verifies it (signature + expiry + claims matching the posted body).
The runtime holds **no long-lived secret** - only the minting + verifying Lambdas hold the
signing key - so a token leaked from a microVM writes only its own session's telemetry. Public
runtime reaches the API via a small public HTTP API (`PublicIngestApi` - not a Lambda Function
URL: an `authType:NONE` URL is world-invocable via its `*` invoke grant, which security
tooling reasonably flags and commonly auto-scopes down → 403; an HTTP API isn't flagged); the isolated
runtime via a VPC-private REST
API over an execute-api PrivateLink endpoint (HTTP APIs can't be made private). `run_bash` also
gets an explicit allow-listed env (its own `config.env` + PATH/HOME), never the runtime's
`process.env`, so no platform secret is reachable by the agent. So an agent that steals the role
creds via MMDS can invoke our models but can touch no table and read no secret. See
docs/runtime.md + docs/deployment.md (directions A + C shipped).

*Within-tenant ingest residual (deliberate):* the ingest routes validate the token +
trajectory `type` (allow-list) + `runId`/`cursor` presence, but don't cap body size or
validate the shape of self-reported metric fields (`writeSummary` spreads the posted body;
`cursor` is an attacker-choosable string; `runId` is validated as a canonical UUID, since it
names an S3 object). A compromised agent holding its OWN valid
token can only muddy its OWN tenant's telemetry (fabricated metrics, extra summary rows, odd
cursors) - the `(agentId, sessionId)` claim lock means no cross-tenant reach, so the isolation
goal holds. This is inherent to self-authored telemetry and overlaps the deferred
rate-limiting work; closing it (field allow-list + size caps) is left for when
that surface is hardened. The `/internal/*` routes are also mounted on the public control-plane
Lambda (same Hono app), but fail closed there: token-gated, and a session-summary write 500s
because `ControlPlaneFn` holds only sessions-table READ.

**IAM tightening** (partly deferred): the control-plane Lambda holds
`bedrock-agentcore:InvokeAgentRuntime` scoped to the shared runtime ARNs (public + isolated;
no more `bedrock-agentcore:*`/PassRole - there's no per-agent provisioning), and the runtime role
holds `bedrock:InvokeModel*`/`bedrock-mantle:*` on `*`. Scoping model invocation to the exact
`MODELS` ARNs is fiddly (cross-region inference profiles + Mantle have awkward ARN shapes)
and scoping it wrong breaks invocation, so it's left broad for now. Blast radius of a
compromised agent (via `run_bash` + the role's creds) is now just: invoke other Bedrock models /
drain shared quota (no table access - see above). The schedule
**trigger Lambda** holds agents-table read + `dynamodb:UpdateItem` (table-wide, for the
metrics counter); UpdateItem can still `SET` any agent's fields (incl. `apiKeyHash`), so
true item-scoping means moving metrics to a separate table the trigger writes while holding
no write on the config table. Tighten model-ARN scope + add per-runtime roles + split the
metrics table when the surface is final.

**Rate limiting** - there is still no invoke/poll rate limit and no per-agent concurrency
cap, so nothing bounds how many turns are STARTED in parallel; add an API Gateway usage plan
/ WAF plus a concurrency cap. But a single turn is now bounded: `runAgentTurn` passes
`limits: { turns, totalTokens }` + a `cancelSignal` deadline to `agent.stream`, from
`MAX_TURNS_PER_INVOCATION` / `MAX_TOKENS_PER_INVOCATION` / `INVOCATION_DEADLINE_MS`
(agent-runtime `config.ts`, env-overridable, 0 disables a dimension; a value outside
0..2^31-1 warns and falls back - Node's `setTimeout` max, which `AbortSignal.timeout` uses:
past 2^32-1 it throws a `RangeError`, and past 2^31-1 it silently CLAMPS TO 1ms, so an
over-large deadline would abort every turn instantly - either way bricking the shared
runtime). The SDK checks caps
at a turn boundary and RETURNS a `limit*`/`cancelled` stop reason rather than throwing, so
`runAgentTurn` reads it off the terminal `agentResultEvent` (`for await` discards a
generator's return value) and `budgetTripMessage` turns a trip into a thrown error - the run
ends as an `error` with a message naming the cap it hit, not a silent success with a blank
answer, and the error rate moves so the caps are tunable. `agent.messages` stays reinvokable,
so a runaway loop no longer pins a billable microVM for its whole 8h lifetime. The individual *hang*
paths are now bounded: the web-search MCP `signedFetch` has a 30s deadline (`continueOnError`
catches errors, not hangs, so a black-hole gateway used to hold a turn open), the
OpenAI/Mantle client is capped at 120s × 2 retries (SDK default: 10 min × 2), and a schedule
tick retries at most twice (Scheduler's default 185 attempts × a fresh sessionId each =
185 billable runs off one failing tick).

**Abandoned sessions are closed out on poll** - a microVM can die (crash/reclaim/OOM) without
writing a terminal event, which used to leave the session `working` forever and the client
polling forever. When the newest event is non-terminal and >30 min old, `readSession` writes a
synthetic terminal `error` and delivers it in that reply (see docs/control-plane.md). This also
bounds the **shared-session status edge**: `tailStatus` does `Limit:1` + an agentId
FilterExpression, so if two agents share a client-supplied sessionId and the other wrote the
newest event, the filtered-out tail falls through to `working` - that client now gets closed
out after the window instead of never. A `sessionId#agentId` composite key would close it
properly. This is now a *status-reporting* edge only: the far more serious version of
sharing a sessionId across agents - landing in another agent's warm microVM - is closed
(see the next paragraph). *Residual:* an abandoned session writes no session-summary row, so it
doesn't count toward error rates (`ControlPlaneFn` holds sessions-table READ only, by design).

**One client session id can no longer reach another agent's microVM.** AgentCore routes
`(runtime ARN, runtimeSessionId)` to a single microVM and ONE shared runtime backs every
agent in every org, so passing the client's sessionId through as the runtimeSessionId meant
an invoke naming agent B with agent A's live session id landed in A's microVM. The runtime
keeps its Agent warm and only rebuilds on a session change, so the caller's prompt ran
against A's system prompt, conversation and `config.env` secrets - and because the
trajectory is stamped with the CALLER's agentId, they could poll the result. Session ids
were never secret enough to rest on: `GET /agents/:id/runs` returns them to anyone who can
*see* a shared agent, and the API invites clients to supply their own. Closed in two places:
`runtimeSessionIdFor` (session-id.ts) derives the runtime-facing id from
`hash(agentId, clientSessionId)`, so two agents structurally cannot name one microVM; and
the runtime binds its warm Agent to `(agentId, sessionId)`, not sessionId alone, which holds
the same guarantee locally and is a second line of defence. The client's own sessionId still
identifies the conversation for polling - only the runtime-facing id changed.

**Drain-loop terminal-write races** (server.ts) - no acked-"injected" message is dropped on
the success path (the loop re-drains after the terminal write and re-runs it). Two accepted
residuals: (1) a straggler arriving during the `session_end` write runs and is durably
recorded under a second `session_end`, but a client polling in the ~write-latency window can
read the first `session_end` as terminal and stop, missing the follow-up - fully closing it
needs a turn-state machine (the terminal write is async and `working` must stay true across
it to serialize turns). (2) a message acked "injected" during an *error* write is dropped
(the warm agent was poisoned/nulled, and keeping it risks leaking into another session's turn
on the shared local runtime). Both are narrow and deliberately not fixed.

**Conversation window** - the warm Agent uses Strands' default
`SlidingWindowConversationManager` (windowSize 40), so a very long single session silently
drops turns beyond 40. This is a deliberate choice (bounded context, no overflow crash); if
long-session fidelity becomes important, switch to the `"auto"` summarizing preset.
