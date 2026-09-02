# Architecture

Agency is a managed platform for no/low-code creation of agents. Users create
agents in a UI; each agent runs in an isolated **AWS Bedrock AgentCore** microVM, is
built with the **Strands Agents SDK (TypeScript)**, and is invoked asynchronously via a
public API that returns immediately with a session id the client can poll.

## Components

```
apps/control-plane   Hono API. Create/list/update/invoke/poll agents.
                     Runs as a Node server locally, as a Lambda in prod (same app,
                     different adapter - see docs/control-plane.md).
apps/agent-runtime   The Strands agent harness that runs inside each AgentCore microVM.
                     One container image; each agent's config arrives in the invoke
                     payload (see docs/runtime.md).
apps/sample-api      A tiny pet-store Hono API - a REMOVABLE demo/E2E target for
                     integrations (its own CDK stack; a docker-compose service locally).
apps/web             React + Vite SPA, Tailwind "Studio" editorial design system (warm
                     cream/marigold/pine palette, Hanken Grotesk + a Fraunces serif eyebrow
                     + IBM Plex Mono for machine data, a hand-drawn compass mark; the live
                     run as a timeline trace), mobile-first. Every color is a palette token
                     read from a CSS variable, so a THEME repaints the console by redefining
                     ~20 of them (`src/styles.css` holds the palettes - Agency, Catppuccin
                     Mocha, Gruvbox dark - and `src/theme.ts` the picker in Settings; the
                     choice lives in localStorage, not on the account). Signed-out visitors get a
                     landing page (no auto-redirect) and can read the public Docs page;
                     sign-in is an in-app SRP login form (no hosted-UI redirect). A top-bar org switcher selects the active org (sent
                     as X-Agency-Org); a Members page manages roles + invites; the UI gates
                     controls by the caller's role (a viewer sees no create/edit/delete, no
                     key rotation) and offers a per-resource share toggle. Agent roster, create
                     form, detail (Monitor / Run / Configure / Versions / Integrate tabs),
                     Skills, Integrations, Docs, and Settings pages.
packages/shared      Wire types shared by all of the above (dependency-free).
infra                CDK: AgencyAuth (Cognito), AgencyData (DynamoDB),
                     AgencyControlPlane (Lambda + API GW + runtime image + IAM +
                     schedule trigger + telemetry/integrations ingest),
                     AgencyWebSearch (a us-east-1 web-search gateway the public runtime
                     reaches cross-region), AgencyWeb (S3 + CloudFront),
                     AgencyWebCert (the us-east-1 CloudFront certificate - only with a
                     custom domain configured, see docs/deployment.md),
                     AgencySampleApi (removable demo API - opt-in, `-c sampleApi=true`),
                     AgencyWebPreview (PR previews at `<pr>.<domain>` - opt-in,
                     `-c previews=true`, needs a domain; see docs/deployment.md).
```

## Request lifecycle

1. **Create** - `POST /agents` (JWT-authed). The control-plane writes the config to
   DynamoDB (+ version 1 + schedule reconcile). An agent is pure config - there is no
   per-agent runtime to provision. Returns the agent + a one-time API key.
2. **Invoke** - `POST /agents/:id/invoke` (API-key authed). Posts to a shared runtime (public
   or the isolated VPC runtime, picked by `config.networkMode`) with agentId + config +
   skills + integrations (manifest, no secrets) + version in the payload; returns immediately
   with a session id and a `triggered`/`injected`/`rejected` status (see docs/injection.md).
   The agent runs async in its per-session microVM.
3. **Poll** - `GET /agents/:id/sessions/:sessionId?after=<cursor>`. Returns the session
   status and the trajectory delta since the cursor.

## The runtime seam (local ⇄ prod)

A small shared-runtime pool backs every agent (agentId + config ride the payload); the
control-plane depends only on the `AgentInvoker` interface, chosen by `MODE`:

- **`AgentInvoker`** - `AgentCoreInvoker` (SigV4 `InvokeAgentRuntime` against a CDK-owned
  AgentCore runtime - public or the isolated VPC runtime, ARN picked by `runtimeArnFor(config.networkMode)`)
  vs `HttpAgentInvoker` (POST to the local docker-compose runtime's `/invocations`, same
  session header as AgentCore; one local container serves both modes - the egress cut is a
  prod-only VPC property).

(The `ScheduleProvisioner` seam - EventBridge vs local no-op - handles schedule triggers the
same way. The `slack` trigger needs no provisioner: the user registers the webhook themselves by
pasting the manifest we generate, so it works identically in both stacks as long as the API is
reachable from Slack - which locally means it isn't, so exercise it with a signed fixture. See
docs/triggers.md.)

This is what makes the local docker-compose stack a faithful replica: identical app code,
identical payloads and session semantics, only the transport differs. See
docs/local-dev.md.

## Data

Every resource (agent/skill/integration) carries `orgId` + `createdBy` + `shared` - it
lives in one **organization**, is attributed to its creator, and is either shared with the
org or private to the creator (see docs/auth.md for the org + role model).

- **agents table** (`pk=id`, GSI `byOrg`): config, API-key hash, metrics.
- **trajectory table** (`pk=sessionId`, `sk=cursor` UUIDv7, 30-day TTL): one item per agent
  action. UUIDv7 sorts chronologically → cheap ordered delta polling with `cursor > :after`.
  Because it expires, a finished run's events are also archived to the **traces bucket**
  (`traces/<agentId>/<runId>.json` - keyed by RUN, since a client may reuse a sessionId
  across runs) so past runs stay inspectable (see docs/metrics.md).
- **skills + integrations tables** (`pk=orgId`, `sk=id`): org-scoped reusable resources
  attached to agents by id. Integrations hold a downstream API + write-only credential; the
  agent reaches it only via the control-plane proxy (see docs/integrations.md).
- **orgs table** (`pk=orgId`): one row per org (personal + team alike).
- **memberships table** (`pk=orgId`, `sk=userId`, GSI `byUser`): the authority source, one
  row per (org, user) carrying the `role`; `byUser` answers "which orgs am I in".
- **invites table** (`pk=email`, `sk=orgId`, GSI `byOrg`): pending email-keyed invitations,
  deleted on accept/decline/rescind.
- **tokens table** (`pk=tokenHash`, GSI `byOwner`): PATs, each pinned to one `orgId` at mint.

## Key decisions

- **Everything TypeScript.** The Strands TS SDK ships all model providers we need, so the
  agent container is TS - no Python.
- **Mid-turn injection is real**, not queued-next-turn. See docs/injection.md.
- **OpenAI models run keyless via Bedrock Mantle.** See docs/models.md.
