# Deployment

Infra is CDK (`infra/`), one stack per concern. Region is `eu-north-1` (pinned in
`infra/lib/config.ts`). Two capabilities remain us-east-1-only and are handled the same way -
provisioned in us-east-1 and reached **cross-region** from the eu-north-1 public runtime (both
SigV4-signed, public mode only): OpenAI-via-Mantle and the AgentCore web-search gateway (its
own `AgencyWebSearch` stack in us-east-1; `AgencyControlPlane` sets `crossRegionReferences: true`
to consume its outputs).

## Prerequisites

- **Node >= 22**, and `npm install` at the repo root (this is a workspaces monorepo - installing
  inside `infra/` alone won't work).
- **`cdk bootstrap` in TWO regions**: `eu-north-1` and `us-east-1`. The web-search gateway stack
  lives in us-east-1 because that connector is us-east-1-only.
- **Docker running, able to build `linux/arm64`.** The control-plane stack builds the
  agent-runtime container as an ARM64 `DockerImageAsset` (AgentCore requires arm64), so on an
  x86 host you need buildx/qemu.
- **Bedrock model access** granted per-model for everything in `packages/shared/src/models.ts`
  (request it in the Bedrock console first). Model ids are account/region specific and you
  should expect to edit them - the Anthropic ids are `eu.` cross-region inference profiles, and
  a profile prefix must match the calling region.
- **Bedrock AgentCore available and enabled** in your account. The runtime and the web-search
  gateway are L1 CloudFormation constructs over a young service; region and API availability
  are outside this project's control.
- The **context keys** below.

## First deploy is TWO phases

The SPA has to be built with the API URL and Cognito ids baked in (Vite inlines them at build
time) - and those are **outputs of the first deploy**. So a first-time deploy can't be one
command:

```bash
# Phase 1 - the backend. Synthesizes an EMPTY website (you'll see a warning saying so).
cd infra
npx cdk deploy --all --require-approval never

# Phase 2 - build the SPA against phase 1's outputs, then publish it.
#   VITE_API_URL              <- AgencyControlPlane's ApiUrl output
#   VITE_COGNITO_USER_POOL_ID <- AgencyAuth's UserPoolId output
#   VITE_COGNITO_CLIENT_ID    <- AgencyAuth's web client id output
cd ../apps/web && VITE_API_URL=<api> \
  VITE_COGNITO_USER_POOL_ID=<userPoolId> VITE_COGNITO_CLIENT_ID=<webClientId> \
  npx vite build
cd ../../infra && npx cdk deploy AgencyWeb --require-approval never
```

Subsequent deploys are one pass (build the SPA, then `deploy --all`) - see
[Web + auth deploy sequence](#web--auth-deploy-sequence) below.

## Context you must set

CDK context carries the per-deployment values the repo can't ship a default for. Put them in
`infra/cdk.context.json` (gitignored) or pass `-c key=value`; `infra/cdk.json` holds only a
`//webCallbackUrl` placeholder documenting the first.

| Key | Required? | What happens if unset |
|---|---|---|
| `webCallbackUrl` | **Yes** for anything but a throwaway | It's the sign-in link in the Cognito invite email, so your users get a `localhost` link - or someone else's app. Synth emits a warning. |
| `cognitoDomainPrefix` | Only for a second deployment in one region | Defaults to `agency-auth`; the prefix is globally unique per region, so a second stack fails. |
| `sampleApi` | No | `AgencySampleApi` is **opt-in**: `--all` leaves it out. Pass `-c sampleApi=true` to deploy the integrations E2E target. |

So `cdk deploy --all` provisions **five** stacks; the sample API is the sixth only with
`-c sampleApi=true`.

## Stacks

- **AgencyAuth** - Cognito user pool, a web app client, and an M2M
  (client-credentials) app client + resource server (`agency/api` scope) + hosted
  domain for the `/oauth2/token` endpoint. Outputs: issuer, M2M client id, token endpoint.
- **AgencyData** - the DynamoDB tables (agents, trajectory, tokens, versions, sessions,
  skills, integrations, orgs, memberships, invites; matches the local schema in
  `scripts/ensure-tables.ts`), plus the **traces bucket**
  (`traces/<agentId>/<runId>.json` - private, TLS-only, RETAIN, no lifecycle expiry) that
  makes run history outlive the trajectory table's 30-day TTL. There is no
  local equivalent: `TRACES_BUCKET` is unset locally, so archiving no-ops.
- **AgencyControlPlane** - builds the agent-runtime container as an ARM64
  `DockerImageAsset` (→ ECR), a small pool of shared `AgentRuntime`s
  (`AWS::BedrockAgentCore::Runtime`) running that image, the `RuntimeRole` they assume, and
  the control-plane Lambda behind an HTTP API (granted `InvokeAgentRuntime` on both runtimes).
  The pool: **`AgentRuntime`** (networkMode PUBLIC, public egress) and **`AgentRuntimeIsolated`**
  (networkMode VPC). The isolated runtime sits in a NAT-less/IGW-less VPC (`IsolatedVpc`,
  `maxAzs: 2` - CDK picks eu-north-1 AZs; the old us-east-1 deploy pinned AZ names to specific
  AZ IDs AgentCore required there) reaching AWS only via PrivateLink: interface endpoints for
  `bedrock-runtime` (Anthropic), `bedrock-agentcore` (data plane - the microVM's own
  invocation/identity path), `logs`, `ecr.api`, `ecr.dkr`, `execute-api` (to reach the private
  ingest REST API), plus a gateway endpoint for `s3` (ECR layers). **No `bedrock-mantle`
  endpoint** - Mantle is us-east-1-only, so OpenAI models don't work in isolated mode
  (Anthropic does). No DynamoDB endpoint - the runtime role has
  no table access; telemetry goes via `execute-api`. The invoker picks the runtime by
  the agent's `networkMode`. Telemetry goes through the `IngestFn` + its front doors (see IAM
  notes below), not a direct runtime DDB write. CORS is handled inside the Hono app
  (`app.ts`), not API Gateway - the `ANY /{proxy+}` route sends even OPTIONS preflights to
  the Lambda, so the app must answer them (otherwise `requireAuth` 401s the preflight).
  Also provisions the **schedule trigger** (EventBridge Scheduler group + trigger Lambda +
  scheduler role), the **discovery-refresh sweep** (`DiscoverySweepFn` Lambda + a daily
  `DiscoverySweepRule` EventBridge rule; the Lambda holds read/write on the integrations table
  and public egress to fetch tenant spec URLs via `guardedFetch` - it re-fetches every
  discovery-backed integration's spec and reconciles the stored selection, see
  docs/integrations.md). It no longer builds the web-search gateway (that moved to
  `AgencyWebSearch`); it grants the runtime role `InvokeGateway` on the us-east-1 gateway ARN
  and sets `WEB_SEARCH_GATEWAY_URL` + `WEB_SEARCH_REGION` on the **PUBLIC** runtime only (the
  isolated runtime omits both - it has no cross-region egress).
- **AgencyWebSearch** - a us-east-1 stack (AgentCore Web Search is **us-east-1 only**) holding
  the shared **web-search gateway** (`AWS::BedrockAgentCore::Gateway` fronting the managed
  `web-search` connector; the gateway role gets `InvokeWebSearch`). The eu-north-1 public
  runtime reaches it cross-region (SigV4-signed to `WEB_SEARCH_REGION`), so `web_search` works
  in public mode; `AgencyControlPlane` consumes its URL + ARN via `crossRegionReferences`.
- **AgencyWeb** - the SPA on a private S3 bucket behind CloudFront (OAI). SPA routing
  (403/404 → index.html) supports the hash router.
- **AgencySampleApi** (**opt-in** - `-c sampleApi=true`; `--all` leaves it out) - a removable
  demo pet-store API (its own stack so it never entangles the platform;
  `cdk destroy AgencySampleApi`) used as the integrations E2E target. See docs/integrations.md.

## Web + auth deploy sequence

The SPA signs in **in-app via SRP** (`amazon-cognito-identity-js`) - no hosted-UI redirect -
so the build only needs the user-pool + client IDs, not a Cognito domain or an OAuth redirect
URI. The build can therefore happen before the CloudFront URL exists:

```bash
cd apps/web && VITE_API_URL=<api> \
  VITE_COGNITO_USER_POOL_ID=<userPoolId> VITE_COGNITO_CLIENT_ID=<webClientId> \
  npx vite build
cd ../../infra && npx cdk deploy --all --require-approval never
```

**Never set `VITE_AUTH_DISABLED` for a deployed build.** It makes the SPA skip login
entirely; it exists for local dev against an `AUTH_DISABLED` API and is set by
`apps/web/.env.development`, which Vite loads for `vite dev` only - never for `vite build`.
The SPA defaults to requiring auth, so a forgotten variable produces a login prompt (a
visible mistake) rather than a signed-in console. Copying env between local and prod is the
exact mistake that default guards.

The token accepted by the control-plane carries the `agency/api` scope not from an OAuth
scope grant but from the **pre-token-generation V2 Lambda**
(`apps/control-plane/src/pre-token-lambda.ts`), which adds `agency/api` (and the `email`
claim) to every access token - SRP `InitiateAuth` doesn't put resource-server scopes on the
token, so this is what makes an SRP-minted token valid (see docs/auth.md).

> **OAuth callback URLs are no longer part of sign-in.** In-app SRP never hits the
> `/oauth2/authorize` redirect, so there's no `redirect_mismatch` failure mode and no
> `VITE_COGNITO_DOMAIN`/`VITE_REDIRECT_URI` build inputs. The web client sets
> `disableOAuth`, so it registers no callback/logout URLs at all - it keeps only the
> SRP + refresh-token auth flows. (The hosted domain survives solely for the M2M
> `/oauth2/token` endpoint, with no managed-login branding.)

## Users (admin-only)

The pool has **no self-sign-up** (`AllowAdminCreateUserOnly: true`).

Two attribute settings back the invite-matching invariant (see docs/auth.md): the pool
sets **`keepOriginal: { email: true }`** (→ `AttributesRequireVerificationBeforeUpdate:
["email"]`), so changing `email` requires re-verifying it and the **old address stays
authoritative until then**; and the web client's **`writeAttributes` is narrowed to
`preferred_username`**, so the SPA can't write `email` at all (Cognito's default is
"write all standard attributes"). Changing a user's email is therefore an admin
operation (`admin-update-user-attributes`), not self-service. Create a user with
`aws cognito-idp admin-create-user`; set a permanent password with
`aws cognito-idp admin-set-user-password --permanent` to skip the forced-change screen.
An org invite to a new email does the same `AdminCreateUser` automatically (via the
`ControlPlaneFn` `cognito-idp:AdminCreateUser` grant - see docs/org-model.md), so an invitee
with no prior login still receives a temp-password email and can sign in to accept.

## IAM notes (learned the hard way)

- The control-plane Lambda only needs `bedrock-agentcore:InvokeAgentRuntime`, scoped to the
  two shared runtime ARNs (public + isolated) - no `bedrock-agentcore:*` or `iam:PassRole`
  (there's no per-agent runtime creation; CDK owns the runtimes). It also holds
  `cognito-idp:AdminCreateUser` + `AdminGetUser` scoped to the user pool (to lazily provision a
  login when an org invite names a new email, and to resolve a member's userId → email for the
  roster - see docs/org-model.md) and gets `USER_POOL_ID` env (which also selects the Cognito
  identity provider over the local no-op). The invite email's sign-in link comes from the
  Cognito invite template in the auth stack (`webCallbackUrl` context), not from a Lambda env var.
- `RuntimeRole` (assumed by both runtimes) is **Bedrock-only**: `bedrock:InvokeModel*`/`Converse*` +
  `bedrock-mantle:CallWithBearerToken` (OpenAI-on-Bedrock - the Mantle path authorizes
  against this; `CreateInference` is also granted defensively; this only surfaces on AWS
  since local dev uses admin creds) + `InvokeGateway` on the web-search gateway + logs + ECR
  pull. It has **NO DynamoDB** access - the runtime posts trajectory + session summaries to
  the telemetry ingest API (below), so stolen role creds reach no table. Crucially it holds
  **no ingest secret** either: the runtime authenticates with a per-session capability token
  that rides its invoke payload (minted by the control-plane / trigger Lambda), so a token
  stolen from a microVM only writes that session's own telemetry.
- `IngestFn` + front doors: a dedicated Lambda (same Hono app) granted trajectory
  **read+write** (read so the session-summary handler can pull a run's events to archive),
  sessions **write**, **PUT-only** on the traces bucket (never delete - and no lifecycle
  expiry either, so traces are retained indefinitely; add a rule if your policy needs bounded
  retention, see SECURITY.md), **read-only** on the integrations table (it also serves the
  integrations proxy `POST /internal/integrations/call`, resolving the record to inject the
  credential - see docs/integrations.md), + the token signing key (Secrets Manager,
  `RUNTIME_INGEST_KEY`). Public
  runtime reaches it via a small **public HTTP API** (`PublicIngestApi` - not a Lambda
  Function URL: an `authType:NONE` URL gets an `AnyPrincipal` `*` invoke grant, i.e. a
  genuinely world-invocable function. Automated security tooling reasonably flags that and
  commonly auto-scopes the `*` down to the account, which then 403s the anonymous runtime
  call - so the URL is fragile even where it's permitted. An HTTP API invokes Lambda via the
  `apigateway` service principal - no `*` grant, nothing to flag); the isolated runtime via a **VPC-private
  REST API** (`agency-ingest-private`, PRIVATE endpoint locked by resource policy to the
  isolated VPC's execute-api endpoint - HTTP APIs can't be made private, so REST is required
  for the no-egress path). Auth is the per-session token (`X-Agency-Ingest-Token`), verified
  in-app by `verifySessionToken` (HMAC + expiry + agentId/sessionId claim match against the
  posted body) - not a user credential. Only the control-plane + trigger Lambdas (which
  **mint** tokens) and IngestFn (which **verifies**) hold the signing key; the runtimes never
  do. See docs/runtime.md.

## Runtime readiness

The shared runtime is provisioned once by CDK (reaches `READY` shortly after a deploy that
changes it), so there's no per-agent create→READY wait - an agent is invocable the moment
it's created. The invoker keeps a short retry only for transient throttling/conflict.

## Post-deploy: mint an M2M token (no interactive login)

```bash
SECRET=$(aws cognito-idp describe-user-pool-client \
  --user-pool-id <UserPoolId> --client-id <M2MClientId> \
  --region eu-north-1 --query 'UserPoolClient.ClientSecret' --output text)
TOKEN=$(TOKEN_ENDPOINT=<TokenEndpoint> M2M_CLIENT_ID=<M2MClientId> \
  M2M_CLIENT_SECRET=$SECRET M2M_SCOPE=agency/api \
  npx tsx scripts/mint-m2m-token.ts)
API_URL=<ApiUrl> TOKEN=$TOKEN npx tsx scripts/e2e.ts
```

## Docker build context

The `DockerImageAsset` build context is the repo root (to resolve the `@agency/shared`
workspace). A root `.dockerignore` + the asset's `exclude` keep `infra/cdk.out` and
`node_modules` out of the context - without them the asset recurses into its own output.
