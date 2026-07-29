# Agency

A managed platform for no/low-code creation of AI agents. Users create agents in a web UI;
each agent runs in an isolated **AWS Bedrock AgentCore** microVM, is built with the
**Strands Agents SDK**, and is invoked asynchronously through a public API that returns a
session id the client polls for status and a full trajectory of what the agent did.

An agent is **pure config in DynamoDB** - creating one is a single write, with no per-agent
infrastructure to provision. A small shared runtime pool backs every agent.

Everything is TypeScript. Infrastructure is AWS CDK. Auth is Amazon Cognito.

> **Not an official AWS or Anthropic product.** This is a personal project, not affiliated
> with, endorsed by, or supported by either company. It is a **reference implementation**:
> read it, learn from it, borrow from it - but see [Before you deploy](#before-you-deploy)
> and [SECURITY.md](SECURITY.md) before putting it in front of anyone who matters.

## What it does

- **Create an agent from config** - a system prompt, a model, a toolset, optional skills and
  integrations. Changes apply on the agent's next run; no redeploy, no re-bake.
- **Invoke asynchronously** - `POST /agents/:id/invoke` returns immediately with a session
  id; poll for the delta of what the agent is doing.
- **Inject mid-turn** - a new message on a working session is appended to the *running*
  agent's context before its next model call, not queued for afterwards. This is the
  load-bearing feature; see [docs/injection.md](docs/injection.md).
- **Organizations, roles, and sharing** - resources live in an org, carry a creator, and are
  shared or private. Roles are `admin` / `editor` / `viewer`.
- **Skills** - reusable Markdown instructions attached to agents by id, loaded on demand.
- **Integrations** - onboard a downstream API once; the agent calls it through a proxy that
  holds the credential, so **the agent never sees the secret**.
- **Network isolation** - an agent can run on a VPC runtime with no public egress, reaching
  Bedrock privately for inference only.
- **Operational metrics and run history** - per-run tokens, cost, duration and outcome, plus
  a replayable trajectory for any past run.

## Architecture at a glance

```
apps/control-plane   Hono API. Node locally, Lambda in prod - same app, different adapter.
apps/agent-runtime   The Strands agent harness that runs inside each AgentCore microVM.
apps/web             React + Vite SPA.
apps/sample-api      A tiny pet-store API: a removable demo target for integrations.
packages/shared      Wire types, the model catalog, the org model. Dependency-free.
infra                CDK: auth, data, control-plane, web-search, web, web-cert (only with a
                     custom domain), sample-api (opt-in).
scripts              Table bootstrap, end-to-end tests, token minting.
docs                 How it actually works. Start with docs/architecture.md.
```

Read [docs/architecture.md](docs/architecture.md) first, then whichever of these you need:
[runtime](docs/runtime.md) · [injection](docs/injection.md) · [control-plane](docs/control-plane.md) ·
[auth](docs/auth.md) · [org model](docs/org-model.md) · [data model](docs/data-model.md) ·
[integrations](docs/integrations.md) · [metrics + versioning](docs/metrics.md) ·
[triggers](docs/triggers.md) · [models](docs/models.md) · [local dev](docs/local-dev.md) ·
[deployment](docs/deployment.md).

`CLAUDE.md` is the instruction file for AI coding agents working in this repo (`AGENTS.md`
points to it, for agents that look for that name). It is dense
and written for that audience, but it is also the most complete single description of how the
system fits together - including the accepted trade-offs.

## Run it locally

The whole platform runs under docker-compose as a faithful replica of prod. Only Bedrock
model calls leave your machine.

**Prerequisites**

- Node **>= 22** and Docker (with Compose)
- AWS credentials with **Bedrock model access** for the models in
  `packages/shared/src/models.ts` - request access per-model in the Bedrock console first
- Region **eu-north-1**. This is not a preference: the Anthropic ids are `eu.` cross-region
  inference profiles, and a profile prefix must match the calling region.

```bash
npm install
export AWS_ACCESS_KEY_ID=…  AWS_SECRET_ACCESS_KEY=…  AWS_SESSION_TOKEN=…
docker compose up --build
```

Control-plane on `:8787` (with `AUTH_DISABLED=true` - local only, and it refuses to start
that way in prod), runtime on `:8080`, DynamoDB Local on `:8000`, sample API on `:8686`.
Tables are created on boot.

The **web UI is not a compose service** - it runs on Vite alongside the stack:

```bash
cd apps/web && npm run dev     # http://localhost:5173, proxies /api → :8787
```

```bash
npm test              # the full suite
npm run typecheck
npm run e2e:local     # create → invoke → poll → inject → assert, against docker-compose
```

Full detail, including the credential and region reasoning: [docs/local-dev.md](docs/local-dev.md).

## Deploying to AWS

[docs/deployment.md](docs/deployment.md) is the reference. Read it before running anything -
the short version is five CDK stacks (plus one each for an optional custom domain and the
opt-in sample API), and the web bundle must
be built with the API and Cognito ids baked in **before** `cdk deploy` (Vite inlines them at
build time, so a missing `VITE_API_URL` produces an SPA pointed at the wrong origin).

**The one edit to make first.** `infra/cdk.context.json` is checked in and carries this
deployment's own values. For the shortest path to something working, delete two lines:

```jsonc
// infra/cdk.context.json - delete these two and you need no DNS at all
"domainName": "agency.nipalm.com",
"hostedZoneId": "Z0..."
```

The SPA then serves on the CloudFront hostname and the API on the API Gateway one. No
certificates, no Route53, no us-east-1 bootstrap, one fewer stack - and every feature
(agents, Slack, integrations, sign-in) behaves identically. Add your own domain later by
putting both keys back with your values; nothing else changes.

**Things a first-time deployer will hit.** These are real and mostly undocumented elsewhere:

- **`cdk bootstrap` is needed in two regions** - `eu-north-1` and `us-east-1`. The web-search
  gateway stack lives in us-east-1 because that connector is us-east-1 only, and so does the
  CloudFront certificate stack if you configure a custom domain.
- **Bedrock AgentCore must be available and enabled in your account.** The runtime and the
  web-search gateway are L1 CloudFormation constructs over a young service; region and API
  availability are outside this project's control.
- **Model ids are pinned** in `packages/shared/src/models.ts` and are account/region
  specific. Expect to edit them. Anthropic ids rotate, and the `eu.`/`us.`/`global.` profile
  prefixes are region-coupled.
- **Edit `infra/cdk.context.json` first - it's checked in and holds THIS deployment's values.**
  The quickest working deploy is to **delete the `domainName` and `hostedZoneId` lines**: the SPA
  then serves on the CloudFront hostname and the API on the API Gateway one, with no DNS,
  certificates or us-east-1 bootstrap needed. Everything else works identically. To use your own
  domain, replace both values instead (the zone must exist and be delegated). Left as shipped,
  the deploy requests a certificate for a domain you don't control and stalls. Every key is
  documented in place in `infra/cdk.json`; the full table is in
  [docs/deployment.md](docs/deployment.md).
- **Set `webCallbackUrl` - or a custom domain, which supplies it.** It is the sign-in link in
  the Cognito invite email, so with neither set your users get a `localhost` link. Put yours
  in `infra/cdk.context.json` or pass `-c webCallbackUrl=https://your-app/`. The synth warns
  only if BOTH it and `domainName` are missing.
- **The Cognito domain prefix is globally unique per region.** It defaults to
  `agency-auth`, so a second deployment in the same region needs
  `-c cognitoDomainPrefix=your-prefix` or the auth stack fails.
- **The sample pet-store API is opt-in.** It's only the integrations E2E target, so
  `cdk deploy --all` leaves it out; add `-c sampleApi=true` if you want it.
- **The runtime image is `linux/arm64`** (AgentCore requires it). On an x86 host you need
  buildx/qemu.
- **The pool has no self-signup.** Create the first user with
  `aws cognito-idp admin-create-user`; they get a temp password by email and must change it.

## Before you deploy

**This costs real money.** The per-invocation budget below is the only built-in guardrail:

- **A per-invocation budget exists** (turns, cumulative tokens, wall-clock - see
  `apps/agent-runtime/src/config.ts`), so a single runaway loop stops instead of running
  until the microVM dies. Note the scope: it bounds **one invocation**, not a session - each
  re-invoke gets a fresh allowance, which is what lets a capped run be continued. So it stops
  a runaway loop, not a caller who keeps invoking. There is still **no rate limit and no
  per-agent concurrency cap**, so nothing bounds how many invocations are started, in
  parallel or in sequence. Add an API Gateway usage plan / WAF and your own budget alarms
  before exposing this to anyone.
- **A VPC with PrivateLink interface endpoints bills hourly per endpoint per AZ**, used or
  not. The isolated network mode is not free to have.
- **`cdk destroy` does not clean up.** Nine of ten DynamoDB tables and the traces bucket are
  `RETAIN` (deliberately - they hold history and credential-adjacent data), so they survive
  and keep billing. See [docs/data-model.md](docs/data-model.md).
- Agents run **user-authored prompts with a bash tool** in a microVM. The isolation is real
  but the threat model matters: read [SECURITY.md](SECURITY.md), which lists the known
  accepted trade-offs rather than pretending there are none.

## Continuous deployment

Merges to `main` deploy to AWS through GitHub Actions, authenticated by **OIDC** - no AWS keys
are stored in the repository. A UI-only change takes a fast path (build the SPA, `s3 sync`,
invalidate the CDN) instead of a full CloudFormation run. PRs run the test gate with no
credentials at all. See [docs/deployment.md](docs/deployment.md#continuous-deployment-github-actions).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: keep the docs current in the same
change, prefer the simpler solution, no dead code, and run the end-to-end test - the
conventions are written down because they're what keeps this codebase legible.

Security issues: **please don't open a public issue.** See [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for third-party attribution.
