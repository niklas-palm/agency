# Deployment

Infra is CDK (`infra/`), one stack per concern. Region is `eu-north-1` (pinned in
`infra/lib/config.ts`). Three things remain us-east-1-only and are handled the same way -
provisioned in us-east-1 and consumed from eu-north-1: OpenAI-via-Mantle and the AgentCore
web-search gateway (its own `AgencyWebSearch` stack in us-east-1, reached **cross-region** and
SigV4-signed by the public runtime; `AgencyControlPlane` sets `crossRegionReferences: true` to
consume its outputs), and - only when a custom domain is configured - the CloudFront
certificate (`AgencyWebCert`, read cross-region by `AgencyWeb`).

## Prerequisites

- **Node >= 22**, and `npm install` at the repo root (this is a workspaces monorepo - installing
  inside `infra/` alone won't work).
- **`cdk bootstrap` in TWO regions**: `eu-north-1` and `us-east-1`. The web-search gateway stack
  lives in us-east-1 because that connector is us-east-1-only - and so does the CloudFront
  certificate stack if you configure a custom domain.
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

## Continuous deployment (GitHub Actions)

Merges to `main` deploy automatically. Two workflows:

- **`.github/workflows/ci.yml`** - on every PR and push: `npm ci`, `typecheck`, `test`, plus
  the deploy-scope tests. **No AWS credentials.** A PR from a fork runs this and nothing else.
- **`.github/workflows/deploy.yml`** - on push to `main` only (plus manual dispatch). Runs the
  same gate, then picks the cheapest path that covers the change.

### Two paths, so a UI tweak doesn't rebuild the world

| Change | Path | What runs |
|---|---|---|
| Only `apps/web/src`, `public/`, `index.html` | **fast** | build the SPA → `s3 sync` → CloudFront invalidation. No CloudFormation, no Docker. |
| Anything else | **full** | `cdk deploy --all`. CDK still skips unchanged assets by content hash, so a control-plane-only change doesn't rebuild the ARM64 runtime image. |

The rule is deliberately conservative - UI-only requires that **every** changed path is web
source. `packages/shared` is excluded (it feeds the runtime and the Lambdas too), as are
`apps/web/package.json`, `vite.config.ts` and `tsconfig.json` (build inputs). It lives in
`.github/scripts/deploy-scope.sh` with tests in `deploy-scope.test.sh`, because an earlier
inline version silently classified a mixed web+shared change as UI-only - which would have
skipped a backend deploy with no failure to notice.

On the fast path `index.html` is uploaded **last**, with `no-cache`, while hashed assets get
`immutable` + a one-year max-age. So a browser can never fetch a new index that references
assets which aren't uploaded yet.

### Credentials: OIDC, no stored keys

GitHub mints a short-lived OIDC token per job; STS exchanges it for temporary AWS credentials.
There is no AWS secret in the repository.

The role is **`agency-github-deploy`** (created once by hand - it can't deploy itself, since
nothing can assume it until it exists). Two properties make it safe on a public repo:

- Its trust policy pins the `sub` claim to **this repository and only `refs/heads/main` or the
  `prod` environment**, and pins `aud` to `sts.amazonaws.com`. A wildcard `sub` is the classic
  mistake - it lets any repository on GitHub assume the role. A fork's PR presents
  `repo:<fork>/…`, which doesn't match.
- **The deploy job never runs on `pull_request`.** Only a push to `main` deploys.

It holds no deploy permissions directly. It may only `sts:AssumeRole` the four CDK bootstrap
roles (deploy / file-publishing / image-publishing / lookup), scoped by exact ARN per region -
that's where the privilege lives, and it's how CDK is designed to be driven from CI. Plus the
narrow extras the fast path needs: `cloudformation:DescribeStacks`, object access to the site
bucket, and `cloudfront:CreateInvalidation`. Verified with `iam simulate-principal-policy`:
`iam:CreateUser`, `dynamodb:DeleteTable` and `s3:DeleteBucket` are all implicitly denied.

Create or update it with the script (idempotent - safe to re-run):

```bash
bash .github/scripts/setup-oidc-role.sh <owner>/<repo>
# …and, if you want PR previews, the separate preview role (see PR previews):
PREVIEWS=1 bash .github/scripts/setup-oidc-role.sh <owner>/<repo>
```

**The `sub` claim format is the one thing that will catch you out.** It's documented as
`repo:<owner>/<name>:ref:refs/heads/main`, but some GitHub accounts emit **immutable numeric
ids**:

```
repo:<owner>@<owner_id>/<name>@<repo_id>:ref:refs/heads/main
```

A trust policy written in the plain form then fails with `Not authorized to perform
sts:AssumeRoleWithWebIdentity` - which reads like a permissions problem and is actually a
string mismatch, so you can burn a while checking IAM. **CloudTrail is where the truth is:**
look up the failed `AssumeRoleWithWebIdentity` event and read
`userIdentity.userName` - that's the subject the token actually carried.

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --max-results 5 --query 'Events[].CloudTrailEvent' --output text
```

The script sidesteps it by asking the GitHub API for the ids and building the subject from the
answer - and refusing to write a policy if that lookup fails, rather than guessing and leaving
a trust policy no token can ever match. The id-qualified form is the *stronger* one anyway: a
renamed or recreated repo gets new ids and can't inherit the old trust.

The policy uses `StringEquals` on the full subject, with **no wildcard operator anywhere**.

Then point the workflow at the role. It reads a **repo variable**, not a hardcoded ARN - this
repository is public, and an account id in a tracked file is a live-deployment identifier
(see CONTRIBUTING.md). It also means a fork or a second deployment needs no edit:

```bash
gh variable set AWS_DEPLOY_ROLE_ARN --body arn:aws:iam::<account>:role/agency-github-deploy
```

If it's unset the deploy fails early with a clear message, rather than surfacing later as an
opaque `Could not assume role with OIDC`.

The GitHub OIDC provider (`token.actions.githubusercontent.com`) is account-global and is
**not** managed by this project - it's shared with anything else in the account. Create it once
per account if it's absent.

### Build inputs come from stack outputs, with one deliberate exception

`.github/scripts/stack-outputs.sh` reads the API URL, Cognito ids, site bucket and distribution
id from CloudFormation at deploy time. A repo variable would go stale when a stack is recreated
and produce an SPA silently pointed at the wrong API.

**The exception is the API URL when a custom domain is configured.** With `domainName` set in the
CDK context, the script derives `https://api.<domain>` instead of reading the output - because the host
is known by construction, and on the deploy that FIRST introduces the domain the deployed output
still names the execute-api endpoint, so a bundle built from it would be stale the moment that
deploy landed. The cost of the exception: a typo in that variable publishes a bundle aimed at a
host that doesn't exist (`smoke.sh` catches it, after the fact), and a UI-only deploy made
*before* the domain deploy lands would do the same. So set the pair as repo variables in the
same change that configures the domain. `assert-bundle.sh` then greps the built
bundle for the API host and refuses one carrying `VITE_AUTH_DISABLED`, because Vite inlines env
at build time - a missing variable doesn't fail the build, it ships a broken console.

After a full deploy, `smoke.sh` asserts `/health` 200, `/openapi.json` 200, `/agents` **401**
(auth is on), the SPA serves, and the served bundle references this deployment's API. It does
**not** run the E2E - that invokes real models and costs money; run it on demand.

**An absent stack resolves to an empty value; anything else fails the step.** Optional stacks
(`AgencyWebPreview`) and a first-ever deploy both mean a lookup for a stack that isn't there, and
`aws cloudformation describe-stacks` exits **254** for one - which under `set -e` used to kill the
script, so a deploy died resolving outputs one step before `cdk deploy`, taking with it the deploy
that would have created the stack it was looking for. Only the CLI's "does not exist" is
translated to `""`; expired credentials, a denied call or throttling still stop the deploy, because
resolving those to `""` would publish a bundle built against nothing (or, on the fast path, sync to
nowhere). `stack-outputs.test.sh` pins both halves with a stubbed `aws` on `PATH`, and CI runs it
alongside the scope tests.

### First deploy from CI

The stacks don't exist yet, so the outputs are empty and the SPA build is skipped - CI deploys
the backend, and the next run publishes the SPA. Same two-phase shape as a manual first deploy
(above). To force a full deploy at any time: **Actions → Deploy → Run workflow → full**.

## Context you must set

CDK context carries the per-deployment values the repo can't ship a default for. Put them in
`infra/cdk.context.json` (tracked - see above) or pass `-c key=value`; `infra/cdk.json` holds a
`//`-prefixed placeholder documenting each one.

| Key | Required? | What happens if unset |
|---|---|---|
| `webCallbackUrl` | **Yes** for anything but a throwaway, unless `domainName` is set | It's the sign-in link in the Cognito invite email, so your users get a `localhost` link - or someone else's app. With `domainName` set it defaults to that origin; otherwise synth emits a warning. |
| `domainName` + `hostedZoneId` | No | No custom domain: the SPA serves on the CloudFront hostname and the API on its execute-api endpoint. See [Custom domain](#custom-domain). |
| `cognitoDomainPrefix` | Only for a second deployment in one region | Defaults to `agency-auth`; the prefix is globally unique per region, so a second stack fails. |
| `sampleApi` | No | `AgencySampleApi` is **opt-in**: `--all` leaves it out. Pass `-c sampleApi=true` to deploy the integrations E2E target. |
| `previews` | No | `AgencyWebPreview` is **opt-in** and needs a domain: `--all` leaves it out. Pass `-c previews=true` for PR previews at `<pr>.<domainName>`. See [PR previews](#pr-previews). |

So `cdk deploy --all` provisions **five** stacks - six with a custom domain (`AgencyWebCert`),
seven with `-c previews=true` on top of that (`AgencyWebPreview`), and the sample API is one
more with `-c sampleApi=true`.

## Custom domain

Optional, and off by default. Set **both** context keys - `domainName` (the apex the SPA is
served on) and `hostedZoneId` (its public Route53 zone) - and the deployment answers on:

| Host | Front door | Certificate |
|---|---|---|
| `<domainName>` | the CloudFront distribution (`AgencyWeb`) | **us-east-1**, in `AgencyWebCert` - CloudFront reads certificates from nowhere else |
| `api.<domainName>` | the control-plane HTTP API (`AgencyControlPlane`) | **eu-north-1**, in `AgencyControlPlane` - an API Gateway *regional* custom domain requires a same-region certificate |

Those two opposite certificate rules are the whole reason for the extra stack: a CloudFormation
stack is single-region, so the CloudFront certificate needs a us-east-1 stack of its own (the
same constraint that gives `AgencyWebSearch` one) and `AgencyWeb` reads its ARN via
`crossRegionReferences`. The API host is always `api.<domainName>` - one decision, not two.

What the deployment does with it:

- Both certificates are **DNS-validated in that zone**, so the zone must already exist *and be
  delegated* (the parent zone's NS records point at it). An undelegated zone doesn't fail fast:
  CloudFormation waits on validation for hours and then times out.
- `AgencyWeb` owns the apex **A + AAAA** alias records to CloudFront (dual-stack).
  `AgencyControlPlane` owns the **A** alias for `api.` - a regional HTTP API custom domain is
  IPv4-only, so an AAAA alias there would resolve to nothing.
- **Use a zone that doesn't already serve those names.** CloudFormation record creation is an
  UPSERT, so deploying into a zone whose apex already points somewhere (a marketing site, say)
  silently repoints it - and `cdk destroy AgencyWeb` then deletes the record. Give the platform
  its own subdomain zone rather than a zone you use for anything else.
- The `ApiUrl` + `SiteUrl` outputs become the custom hosts, so the SPA build
  (`VITE_API_URL`), the invoke URLs the API advertises (`PUBLIC_API_URL` → `invokeUrl`, the
  OpenAPI `servers` entry, the coding-agent skill) and `smoke.sh` all follow automatically.
- The **execute-api endpoint stays enabled** and the `*.cloudfront.net` hostname keeps serving:
  agent keys already handed out carry invoke URLs on the old host.
- The Cognito invite email's sign-in link defaults to `https://<domainName>/`, so
  `webCallbackUrl` becomes unnecessary (set it only to override).

**`infra/cdk.context.json` is the single source of truth, and it is checked in.** CDK reads it
automatically, so a local `cdk deploy` and CI use the identical file - no context wiring in the
workflow, nothing to keep in sync.

### Deploying your own copy

The file ships with **this** deployment's values, not defaults. Two lines decide everything:

```json
"domainName": "agency.nipalm.com",
"hostedZoneId": "Z0..."
```

**Option A - no custom domain (recommended for a first deploy).** Delete both lines. You get:

| | Serves on |
|---|---|
| SPA | the CloudFront hostname (`d….cloudfront.net`) |
| API | the API Gateway hostname (`….execute-api.<region>.amazonaws.com`) |

No DNS, no certificates, no Route53, no us-east-1 bootstrap, and one fewer stack
(`AgencyWebCert` isn't synthesized). Everything else - agents, Slack, integrations, the SPA's
sign-in - works identically; the only difference is the hostnames. This path is verified: with
both keys absent the app synthesizes **zero** certificates and **zero** Route53 records, and the
`ApiUrl`/`SiteUrl` outputs resolve to the AWS-provided hostnames.

**Option B - your own domain.** Replace both values. `hostedZoneId` must be a **public** Route53
zone that already exists and is **delegated** (the parent zone's NS records point at it), because
both certificates are DNS-validated in it. An undelegated zone doesn't fail fast: CloudFormation
waits on validation for hours and then times out. Also `cdk bootstrap` us-east-1, since the
CloudFront certificate stack lives there.

**What happens if you deploy without changing them:** CDK requests an ACM certificate for a domain
you don't control and tries to write validation records into a hosted zone in someone else's
account - an IAM denial, or a CloudFormation hang. Nothing is damaged, but the deploy won't
complete. Delete the two lines and re-run.

**A half-set pair is refused at synth**, with a message naming what's missing - so deleting only
one line fails immediately rather than deploying half a domain. Empty strings (`""`) are treated
as unset, which is what a careless edit usually produces.

The no-domain path is pinned by `infra/lib/no-domain-path.test.ts`: with both keys absent it
asserts zero certificates, zero Route53 records, no API domain mapping, and `ApiUrl`/`SiteUrl`
outputs that still resolve to the AWS-provided hostnames. It's the path we'd otherwise never
notice breaking, because our own deploys always have a domain.

### `sampleApi`

`"false"` by default, so a clone doesn't deploy a demo it didn't ask for. Set `"true"` to add
`AgencySampleApi` - a small pet-store API that exists only as the target for the integrations
E2E (`RUN_INTEGRATION=1`); locally the same role is played by the `sample-api` docker-compose
service, so the stack matters only for AWS runs.

Note that flipping it back to `"false"` does **not** remove an already-deployed sample API:
`cdk deploy --all` only deploys the stacks it synthesizes and never deletes ones it no longer
knows about, so the stack keeps running, unmanaged, until `cdk destroy AgencySampleApi`.

**CI needs the same pair as repo variables**, because CDK context is not tracked - a deploy from
CI without them would remove the domain a local deploy had configured:

```bash
# in infra/cdk.context.json (see "single source of truth" above), then:
gh variable set AGENCY_CDK_CONTEXT --body "$(cat infra/cdk.context.json)"
```

Setting only one half is refused at synth (`infra/lib/domain.ts`) rather than deploying half a
domain. On the deploy that first introduces a domain the SPA is built against
`https://api.<domainName>` *before* that host exists - which is deliberate: the bundle is only
served after the same deploy creates the mapping and the records, and building it against the
old host would make `smoke.sh`'s "served bundle targets this API" check fail immediately.

## PR previews

**Opt-in** (`-c previews=true` plus a custom domain). Label a pull request `preview` and
`.github/workflows/preview.yml` publishes that branch's SPA at
**`https://<pr-number>.<domainName>`**, comments the URL on the PR, republishes on every push,
and deletes it when the label comes off or the PR closes.

### Frontend-only, on purpose

A preview rebuilds the **bundle only** and points it at the already-deployed API, so it can
only tell the truth about a change that lives entirely in `apps/web/`. A PR that also touches
the control plane, the runtime, `packages/shared` or `infra` gets a comment explaining why
there's no preview rather than a console whose backend half doesn't exist yet - which would
look like a working preview. Markdown anywhere rides along (rule 4 means a UI change normally
arrives *with* its doc edits, and a doc is a build input for nothing), but at least one
`apps/web/` file must have changed - a docs-only preview would publish an unchanged console.

The rule is `.github/scripts/preview-scope.sh`, tested in `preview-scope.test.sh` (CI runs it).
It deliberately differs from `deploy-scope.sh`: a change to `apps/web/package.json` blocks
prod's fast path but is fine for a preview, because a preview rebuilds everything from source
anyway.

### One distribution, a prefix per PR

`AgencyWebPreview` is a single private bucket behind a single CloudFront distribution with the
alternate name `*.<domainName>`. A CloudFront **function** (`infra/lib/preview-router.js`, run
on viewer request) maps the host's first label to the matching key prefix and appends
`index.html` for a directory request:

```
123.<domain>/            ->  s3://<previews>/123/index.html
123.<domain>/assets/x.js ->  s3://<previews>/123/assets/x.js
```

That is what makes a preview cheap: publishing is `aws s3 sync` into `123/` plus one
invalidation of `/123/*` - no CloudFormation, ~1 minute. A distribution per PR would mean a
stack, a certificate and a DNS record per PR, several minutes of waiting, and a quota to run
into. The label must be all digits; anything else (the distribution's own `*.cloudfront.net`
name, or a probe at some other subdomain the wildcard record now answers for) gets a 404 from
the edge. The URI carries the prefix, so the cache key does too - one PR's cache can't serve
another's bundle.

Two safety nets on cost: CI deletes a PR's prefix on close, and the bucket has a **30-day
lifecycle expiry** for whatever CI missed (a cancelled teardown, a PR closed while the workflow
was off).

### What it costs you to know

- **A preview talks to the real API and the real user pool.** Anything you create in one is a
  real agent in a real org. The build sets `VITE_PREVIEW_LABEL`, so the console shows a
  permanent `Preview · PR #123 · live data` chip - a preview must never be mistakable for
  production. Responses carry `X-Robots-Tag: noindex, nofollow`.
- **A preview is a sibling host, never a path on the production origin.** That is deliberate:
  the SPA keeps its access token in `localStorage`, which is per-origin, so unreviewed PR code
  served from `<domainName>` itself could read a signed-in user's real token. From
  `123.<domainName>` it cannot. (The console sets no cookies, so there's nothing scoped to the
  parent domain either.)
- **A wildcard DNS record answers for every subdomain you have no explicit record for.** The
  apex and `api.` keep working - an explicit record always beats a wildcard - but plan around
  it before adding new hostnames.

### Setting it up

1. `PREVIEWS=1 bash .github/scripts/setup-oidc-role.sh <owner>/<repo>` - creates
   **`agency-github-preview`**, a role that can write the previews bucket, invalidate the
   previews distribution and read stack outputs, and **nothing else**. It cannot assume the CDK
   bootstrap roles, so no PR can deploy infrastructure. This is why previews don't reuse
   `agency-github-deploy`: that role's whole point is that no PR branch can deploy, and
   previews run on `pull_request`. (`cloudformation:DescribeStacks` has no resource-level
   scoping in IAM, so that one statement is `*`; stack outputs are hostnames and ids, not
   secrets.)
2. `gh variable set AWS_PREVIEW_ROLE_ARN --body arn:aws:iam::<acct>:role/agency-github-preview`.
3. Create the **`preview`** GitHub environment (Settings → Environments). The preview role
   trusts exactly one subject, `repo:<owner>/<repo>:environment:preview`, so nothing outside
   that environment can assume it - and that's where you'd add a required reviewer if you want
   previews approved before they publish. Note that a reviewer requirement gates the
   **teardown** job too, since it needs the same credentials.
4. Set `"previews": "true"` in `infra/cdk.context.json` and deploy. The first deploy issues the
   `*.<domainName>` certificate (DNS-validated, so the zone must be delegated - the same
   caveat as the site certificate) and creates the wildcard alias records. The **existing
   site certificate is not touched**: previews get a certificate of their own precisely so
   that enabling them can't re-issue and swap the certificate on the production distribution.
5. Label a frontend PR `preview`.

A fork PR is skipped: GitHub withholds write permissions and secrets from fork PRs, and the
workflow also checks that the head repo is this repo, so it fails with an explanation rather
than an obscure OIDC error.

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
  isolated runtime omits both - it has no cross-region egress). With a custom domain configured
  it also issues the **regional** certificate for `api.<domain>`, maps the HTTP API onto it and
  owns that host's alias record (see [Custom domain](#custom-domain)).
- **AgencyWebSearch** - a us-east-1 stack (AgentCore Web Search is **us-east-1 only**) holding
  the shared **web-search gateway** (`AWS::BedrockAgentCore::Gateway` fronting the managed
  `web-search` connector; the gateway role gets `InvokeWebSearch`). The eu-north-1 public
  runtime reaches it cross-region (SigV4-signed to `WEB_SEARCH_REGION`), so `web_search` works
  in public mode; `AgencyControlPlane` consumes its URL + ARN via `crossRegionReferences`.
- **AgencyWeb** - the SPA on a private S3 bucket behind CloudFront (OAI). SPA routing
  (403/404 → index.html) supports the hash router. With a custom domain configured it also
  answers on that domain (certificate from `AgencyWebCert`, cross-region) and owns the apex
  A + AAAA alias records.
- **AgencyWebCert** (only with a custom domain) - a us-east-1 stack holding *just* the
  DNS-validated certificate for the site domain, because CloudFront accepts certificates only
  from us-east-1. `AgencyWeb` consumes the ARN via `crossRegionReferences`. See
  [Custom domain](#custom-domain).
- **AgencyWebPreview** (**opt-in** - `-c previews=true`, and only with a custom domain) - one
  private bucket + one CloudFront distribution serving EVERY open PR preview at
  `<pr-number>.<domainName>`, plus the `*.<domainName>` wildcard alias records and a
  `*.<domainName>` certificate (issued alongside the site one in `AgencyWebCert`). A
  CloudFront function maps the host's first label to the key prefix, so publishing a preview
  is an `s3 sync` with no CloudFormation. See [PR previews](#pr-previews).
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

## Logs

Everything writes to CloudWatch, and **every group we own expires after 30 days**
(`infra/lib/logging.ts` - one constant to change if your policy wants a different horizon).
None of these groups is declared by
CDK: Lambda creates `/aws/lambda/<function>` on first invoke and AgentCore creates
`/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT`, so retention is applied to the
existing group **by name** with a `logs.LogRetention` custom resource (PutRetentionPolicy).
It applies from the **first** deploy - the custom resource creates the group with the policy
already on it if the service hasn't made it yet - so a fresh deployment never accumulates an
unbounded group.
A new Lambda therefore needs an `expireFunctionLogs(fn)` call, and
`infra/lib/log-retention.test.ts` fails if one is forgotten. The groups CDK creates for its
own deploy-time custom resources (bucket deployment, cross-region export reader,
auto-delete-objects, and LogRetention's own singleton) are left alone - they log a few KB
per deploy.

The cost of that mechanism, stated plainly: CDK's `LogRetention` is a deploy-time Lambda
holding `logs:PutRetentionPolicy` + `logs:DeleteRetentionPolicy` on `*` (CDK hardcodes the
wildcard - it isn't ours to scope). It can change a retention policy and read nothing, and it
runs only during a deploy. The alternative is setting retention by hand outside CDK, which
drifts the moment someone forgets.

Where to look:

| Group | What's in it |
| --- | --- |
| `/aws/lambda/…ControlPlaneFn…` | the API. Every failed request (`request <method> <path> status= ms=`), transient-dependency 503s, unhandled errors |
| `/aws/lambda/…IngestFn…` | telemetry ingest + the integrations/Slack proxies. Start here when a run executed but its trajectory or metrics are missing |
| `/aws/lambda/…ScheduleTriggerFn…` | scheduled invokes (`schedule fired …`) |
| `/aws/lambda/…DiscoverySweepFn…` | the daily integration spec refresh |
| `/aws/lambda/…PreTokenFn…` | sign-in token shaping |
| `/aws/bedrock-agentcore/runtimes/agency_runtime-…-DEFAULT` | the public agent microVMs - the agent's own stdout/stderr, incl. ingest failures |
| `/aws/bedrock-agentcore/runtimes/agency_runtime_isolated-…-DEFAULT` | the same for isolated agents |

**What is and isn't logged.** A request that failed is always logged; a successful one is
not (clients poll in a loop, and the trajectory is the durable record of a run). Setting
`DEBUG=1` on a function or runtime adds the verbose trace - every request, invoke, poll,
step and telemetry POST - which is how the local stack runs (see docs/local-dev.md). No
stack sets it in prod; flipping it on a deployed Lambda is a deliberate, temporary act, and
CDK will remove it on the next deploy. Debug lines carry ids, names and sizes only - prompt
text, tool arguments and `config.env` values stay out of CloudWatch, where the audience is
"anyone with account access" rather than "people who can see the agent".

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
