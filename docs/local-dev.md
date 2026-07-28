# Local development

The whole platform runs locally via docker-compose as a faithful replica of prod. The only
calls that leave the laptop are Bedrock model invocations (which can't be emulated);
DynamoDB is local, and the control-plane talks to the agent-runtime over HTTP exactly as it
talks to AgentCore in prod (same session-id header, same payload shape).

## Run it

```bash
npm install
docker compose up --build     # dynamodb-local + agent-runtime + control-plane + sample-api
```

- Control-plane: http://localhost:8787 (`AUTH_DISABLED=true` locally)
- Agent-runtime: http://localhost:8080 (`/ping`, `/invocations`)
- DynamoDB Local: http://localhost:8000 (tables auto-created on control-plane boot)
- Sample API: http://localhost:8686 (the pet-store integration target; bearer
  `local-sample-token`, the credential a test integration stores - see docs/integrations.md)

Bedrock needs real credentials even locally. docker-compose passes the host shell's AWS
env vars (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`) into the
agent-runtime container. **Export them into the shell** before `docker compose up` -
profiles are deliberately not used. Either kind works: a long-lived IAM user key pair (no
session token) or temporary STS / Identity Center credentials (all three).
The runtime asserts the KEY PAIR is present at boot (`assertLocalCredentials` in
`agent-runtime/src/config.ts`) - `AWS_SESSION_TOKEN` is optional, since only temporary creds
have one - and fails fast with a clear message naming what's missing, and
it deletes `AWS_PROFILE` so the AWS SDK can never silently fall back to a profile. Make sure
the pasted credentials are for an account with Bedrock model access. The region is NOT a
choice: docker-compose pins `AWS_REGION: eu-north-1` because the Anthropic model ids are
`eu.` cross-region inference profiles, and a profile prefix must match the calling region
(see `packages/shared/src/models.ts`) - pointing the runtime at us-east-1 makes every model
call fail.

## Web UI

```bash
cd apps/web && npm run dev     # http://localhost:5173, proxies /api → :8787
```

The SPA is NOT a compose service - it runs on Vite outside the stack. Login-free local dev
comes from the tracked `apps/web/.env.development`, which sets `VITE_AUTH_DISABLED=true` to
match the local API's `AUTH_DISABLED`. Delete or rename that file and the console demands a
login the local API can't issue. Vite loads `.env.development` for `dev` only - never for
`build` - so the flag can't reach a deployed bundle (the SPA defaults to requiring auth).

## Unit tests

```bash
npm test            # vitest from the repo root: apps/*, packages/*, and infra/lib
                    # (excludes cdk.out staged copies)
```

Coverage focuses on the risk-bearing pure logic, extracted from the I/O so it can be
tested without AWS: config validation (`config-validation.ts`), the auth scope decision
(`authorizePayload`), API-key + session-id helpers, the transient-error → 503 mapping
(`isTransient`), the AgentCore retry logic (`isRetryableError` / `nextRetryDelay`), the
Strands stream → trajectory translation
(`parseStreamEvent`), the model-provider factory, the sandbox path guard (`sandboxed`,
incl. the sibling-prefix escape regression), the base tools against a real temp dir, and
the mid-turn injection mailbox/hook (incl. the `MAILBOX_CAP` flood cases).

## End-to-end test

```bash
npm run e2e:local              # against local docker-compose
# same, plus the integrations round-trip (registers the sample API, calls it via the proxy):
RUN_INTEGRATION=1 npm run e2e:local
# or against a deployed API:
API_URL=https://<api> TOKEN=<m2m-token> npx tsx scripts/e2e.ts
# all supported models (create+invoke+poll per model):
npx tsx scripts/models-e2e.ts
# the schedule trigger (deployed only - reads EventBridge Scheduler directly):
API_URL=https://<api> TOKEN=<m2m-token> npx tsx scripts/schedule-e2e.ts
# web search + fetch (deployed only - web search needs the AgentCore gateway):
API_URL=https://<api> TOKEN=<m2m-token> npx tsx scripts/web-search-e2e.ts
# isolated network mode (deployed only - proves Bedrock works privately while
# public egress is cut; needs the VPC runtime):
API_URL=https://<api> TOKEN=<token> npx tsx scripts/isolated-e2e.ts
```

`scripts/e2e.ts` creates an agent, invokes it, polls the trajectory delta, injects a second
message mid-turn, and asserts the injection is seen (see docs/injection.md). With
`RUN_INTEGRATION=1` it also registers the sample pet-store API as an integration, attaches it
to an agent, and asserts the agent lists + creates a pet through the proxy - proving the
credential never reaches the agent (see docs/integrations.md). Set `SAMPLE_API_URL` /
`SAMPLE_API_TOKEN` when running against a deployed stack. The auto-DISCOVERY round-trip is
skipped locally: a spec URL carries the integration credential, so it must be https, and the
local sample-api is plain http - point `SAMPLE_API_URL` at the deployed https sample API to
exercise it (locally these default to the `sample-api` container).
`scripts/models-e2e.ts` runs one agent per supported model and asserts each completes - run
sequentially locally, since the local runtime is a single shared process (one session at a
time), which mirrors the prod one-session-per-microVM guarantee.

**Org model coverage note.** The org model's *logic* (visibility/write rules, role gating,
managers grant, invite lifecycle, org scoping) is covered by the vitest suites
(`authz.test.ts`, `org-isolation.test.ts`, `org-invites.test.ts`, `routes-scope.test.ts`,
`skills-routes.test.ts`) against mocked repos. There is deliberately **no** wire-level org E2E:
locally `AUTH_DISABLED` yields a single fixed principal (one personal org), so cross-tenant
isolation and the invite→Cognito bridge can't be exercised without a real deployed stack + two
PATs in different orgs. If that wire-level cross-tenant assertion is ever wanted, add an
AWS-gated `scripts/org-e2e.ts` (two PATs: assert org-A resources are 404 to an org-B token, a
viewer PAT 403s on write, and a non-manager editor 403s on a co-member's shared resource).

## Config homes (local ⇄ prod seam)

- Structural constants (region) → `infra/lib/config.ts`. Table names are NOT pinned there:
  CDK derives unique physical names and passes them to consumers as env (locally they're set
  in `docker-compose.yml`).
- Runtime knobs → env vars (docker-compose locally; CDK-set on Lambda / AgentCore in prod).
- Resource ARNs → CDK refs / DynamoDB, never files.

The `MODE` env (`local`|`prod`) selects the scheduler + invoker in `app.ts`. `DDB_ENDPOINT`
switches the DynamoDB client to DynamoDB Local.

**Run traces locally**: `TRACES_BUCKET` is unset, so both sides of the S3 archive no-op
and past runs serve from the trajectory table alone. That table is TTL'd at 30 days, so a
local run older than that opens with no steps - in prod it would come from the archive.

**Slack locally**: the trigger works - the webhook, verification, routing and the reply proxy are
all plain app code - but Slack can't reach `localhost`, so nothing arrives on its own. Exercise it
by POSTing a **signed fixture** to `/webhooks/slack/<agentId>`: store a signing secret on the
agent, then sign `v0:{timestamp}:{rawBody}` with it exactly as Slack does (see
`slack-verify.test.ts` for the two lines that produce a valid header pair). The reply leg needs a
real bot token, so a local run posts nothing - assert on the trajectory instead. This is a
deliberate divergence: prod needs a publicly reachable URL, and tunnelling one from a dev machine
is the user's choice, not the platform's.

**Network mode locally**: `config.networkMode` ("public"|"isolated") rides the invoke payload
like any other config, so the local `HttpAgentInvoker` targets the single local runtime
container for both - the *routing* and the config coupling (isolated ⇒ web tools off,
ISOLATED_PROMPT added) are exercised faithfully. What can't be faithfully emulated locally is
the *network cut*: isolated mode's "no public egress" is a prod-only VPC/PrivateLink property
(there's no NAT-less microVM locally). Verify the real egress cut with `scripts/isolated-e2e.ts`
against a deployed API (it asserts Bedrock works privately while `run_bash` curl to the
internet fails).
