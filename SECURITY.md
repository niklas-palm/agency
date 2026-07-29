# Security

This project is a **reference implementation**, not an audited product. It is a multi-tenant
authorization model, an SSRF-guarded egress path, a credential-injecting proxy, and a sandbox
for running user-authored agent code. That is a lot of security surface, and it has not been
through an external review.

**If you deploy this, you own the risk.** Read this whole file first.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security problem.**

Use [GitHub's private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
on this repository (Security → Report a vulnerability). If that isn't available to you, open
an issue containing only "security report - please provide a private channel" and no detail.

What helps: the affected component, a reproduction, the impact you believe it has, and
whether it needs a deployment to reproduce or is visible in the source. Please give a
reasonable window before public disclosure.

What to expect honestly: this is a personal project maintained in spare time. I will
acknowledge reports and fix real issues, but I cannot commit to a professional SLA. If that
is not good enough for your use case, that itself is useful information about whether to
deploy this.

**In scope:** anything in this repository - the control-plane, the agent runtime, the web app,
the CDK infrastructure, and the documented security properties below.

**Out of scope:** vulnerabilities in AWS, Anthropic, or third-party dependencies (report those
upstream); the author's own deployment; and the accepted trade-offs listed below, which are
known. If you can show one of those trade-offs is *worse* than described, that is very much
in scope and worth reporting.

## The security properties this project tries to hold

Stated plainly so you can check them, and so a regression is recognizable:

1. **Tenant isolation.** A resource is visible only within its organization, and only if it's
   shared or you created it. Admin does **not** pierce privacy. For skills, integrations and
   memberships the table is keyed by `orgId`, so a cross-tenant read there is structurally
   impossible rather than merely checked. The agents table is keyed by bare `id` (an invoke
   arrives with only an agent id), so agent reads are **checked** - every route that takes an
   id org-checks the record after loading it. Uniform, and verified by tests, but enforced in
   the handler rather than by the key. See [docs/auth.md](docs/auth.md) and
   [docs/data-model.md](docs/data-model.md).
2. **The agent never holds a downstream credential.** Integration secrets are write-only and
   stay in the control-plane proxy; the agent calls operations by id. It also never holds a
   long-lived platform secret - telemetry is authed by a per-session capability token minted
   at invoke.
3. **The runtime's AWS role is Bedrock-only.** It has no DynamoDB access at all. An agent that
   steals its role credentials via instance metadata can invoke models and touch no table.
4. **Authentication never compares a plaintext credential.** A personal access token is not
   compared at all - authentication is a single lookup keyed by the hash of the presented
   token, so there is no comparison to leak timing from. An agent API key is compared with
   `timingSafeEqual` against its stored SHA-256. Note the scope carefully, because "hashed at
   rest" is **not** a property this project holds across the board: agent API keys are
   additionally stored in plaintext so the console can prefill them, and integration secrets
   plus `config.env` values are plaintext because they have to be replayed downstream. Only a
   PAT is hash-only. All three are in the trade-offs below.
5. **Tenant-supplied outbound URLs go through one SSRF anchor.** Literal private, loopback,
   link-local, CGNAT and metadata addresses are refused - including every IPv6 spelling that
   embeds an IPv4 address. Redirects are re-validated per hop and credential headers are
   stripped across origins.
6. **Authority is re-read every request.** Removing a member or changing their role takes
   effect immediately, and no write path can durably undo a removal.

## Accepted trade-offs (known, and deliberately documented)

These are real. They were accepted for a deployment whose users are trusted colleagues, and
**that assumption does not transfer to your deployment.** If you deploy this, treat the first
two as prerequisites, not footnotes.

- **No rate limiting and no concurrency cap.** A turn IS bounded - `MAX_TURNS_PER_INVOCATION`,
  `MAX_TOKENS_PER_INVOCATION` and `INVOCATION_DEADLINE_MS`
  (`apps/agent-runtime/src/config.ts`) stop a runaway loop at a turn boundary. But nothing
  bounds how many turns are *started*: there is no invoke/poll rate limit and no per-agent
  concurrency cap, so parallel sessions still multiply cost.
  **Add a usage plan / WAF and budget alarms before exposing this.** Note this matters more with
  a custom domain configured: the API is then at `api.<your-domain>` by construction, so a
  scanner finds it from the domain alone, where a raw `<random-id>.execute-api…` host gave the
  gap some accidental obscurity. That obscurity was never a control - but it was doing something,
  and a custom domain removes it.
- **Agents execute user-authored instructions with a bash tool.** The microVM is the security
  boundary, not the tool-level path checks. Anyone who can create an agent in your deployment
  can run code. Treat "can create an agent" as a privileged capability.
- **Broad model-invocation IAM.** The runtime role holds `bedrock:InvokeModel*` on `*`, because
  scoping to exact cross-region inference-profile and Mantle ARNs is fiddly and breaking it
  breaks invocation. Blast radius of a compromised agent: invoke other Bedrock models, drain
  shared quota. No table access.
- **DNS-resolution gap in the SSRF guards.** The guards validate the address, but the
  subsequent `fetch` resolves the hostname again - so a hostname publishing both a public and
  a private address can, in principle, slip a private connection past a guard that already
  approved it. Closing it needs socket-level IP pinning. Note the agent's bash tool is a wider
  egress path anyway, which is why this was accepted.
- **Self-reported telemetry is trusted within a tenant.** An agent posts its own metrics under
  a token scoped to its own `(agentId, sessionId)`, and the shape of those metric fields isn't
  validated. A compromised agent can therefore muddy **its own** tenant's telemetry. The claim
  lock means no cross-tenant reach; the read side coerces so one bad row can't break a
  dashboard.
- **Agent API keys are stored in plaintext, deliberately.** Each agent's `ag_…` key is kept on
  its record and returned on reads to any caller who can WRITE the agent, so the console can
  prefill it in the Run tab and the integration samples. This reverses an earlier
  hash-only design, and it is a considered DX trade rather than an oversight: a deployment has
  many agents with one key each, so a key visible exactly once means re-pasting a different
  secret per agent per browser, which in practice pushes people to store them somewhere worse.
  What bounds it: the key authorizes invoking ONE agent and nothing else; a viewer of a shared
  agent is refused it (same gate as `config.env` values); the SHA-256 hash is still what invoke
  verifies against, so the plaintext is never on the auth path; and rotation invalidates a leaked
  key immediately. **What it costs:** anything that can read the agents table - a PITR export, an
  over-broad IAM grant, or `IngestFn` (which holds agents-table read for the Slack proxy) - yields
  live invoke keys for every agent in every org. If you need that closed, store only
  `apiKeyHash` and drop `apiKey` from the record; the UI degrades to a paste field.
- **Other secrets are plaintext at rest in DynamoDB too.** Per-agent `config.env` values,
  integration secrets and a Slack trigger's `slackSecrets` (signing secret + bot token) are stored
  unencrypted beyond DynamoDB's own at-rest encryption, and `config.env` is
  duplicated into every config version snapshot. Values are redacted from API reads for
  non-writers. Encrypting them at rest (KMS, or secret references) is planned, not done.
- **Run traces are readable by anyone who can see the agent.** A trajectory contains prompts,
  tool inputs and outputs. This is a deliberate product decision (a team debugging an agent
  needs its trace) and it means `config.env` redaction covers the *config surface*, not agent
  *output*. Reasoning in [docs/metrics.md](docs/metrics.md).
- **A Slack-triggered agent can be directed by anyone who can invite its bot.** The channel
  allowlist is the control: the agent answers only in channels its owner listed, and an empty
  list means nowhere - **unless** the owner opts into `allChannels`, which answers in every
  channel the bot is invited to and makes an empty list mean *everywhere* instead. That opt-in
  hands the gate to whoever can `/invite`, which is the right trade for a private workspace and
  the wrong one for an agent holding powerful integrations. But *within* an allowed channel, any member can @-mention the agent and
  have it run with the agent's full toolset - including `run_bash` and its integrations. That is
  the feature, and it is why the setup UI states it plainly rather than burying it: treat an
  allowed channel as equivalent to handing its members the agent's API key. A Slack agent that
  holds powerful integrations belongs in a channel with a membership you control.
- **Slack loop protection rests on an upstream-supplied field.** A bot's own messages are dropped
  on `event.bot_id`, which Slack populates on `app_mention` from a bot - so two Agency agents in
  one channel can't mention each other into a loop. But there is no server-side per-thread turn
  counter, so that single field is the whole guard.
- **A crafted session id can name a Slack channel, so the channel allowlist - not the token
  derivation - is the real containment.** `slack-<channel>-<threadTs>` is deterministic, so a
  caller holding an agent's API key can invoke with a session id of that shape and mint a
  capability token naming a channel of their choosing. The normal invoke path does NOT set
  `fromSlack`, so no Slack tools are wired and the agent has no `slack_reply` to call - reaching
  the proxy needs the `run_bash` + token-from-`/proc` path already described above. The practical
  effect is bounded, but it means "the reply target is derived from the token, so there is no
  parameter to poison" is too strong a claim: what actually contains it is the proxy's re-check
  that the channel is still on the agent's allowlist. Treat that check as load-bearing.
- **`IngestFn` can read the agents table.** The Slack proxy runs there (it's the only ingest URL
  the runtime has) and needs the bot token plus the allowlist, so `IngestFn` holds agents-table
  READ - which covers every agent's `slackSecrets` and `apiKeyHash`. Combined with the
  signing-key exposure below, someone who can read that key can forge a token for any agent and
  reach the Slack proxy; the allowlist still bounds them to channels that agent already allows.
  This is a real widening of what `IngestFn` could previously touch, stated here rather than
  left implicit.
- **The Slack webhook is public, and its only boundary is the HMAC.** Verified over the raw body
  with a 5-minute replay window and a constant-time compare. `url_verification` is necessarily
  exempt (Slack fires it before the app's signing secret exists on our side); the exemption is
  narrowed to bodies carrying no `event`, and pinned by regression tests, because a wider
  version would let an unsigned request start a run. Note there is no per-agent rate limit here
  either, so the first bullet applies to inbound mentions too.
- **The ingest/proxy HMAC signing key is plaintext in three Lambdas' environment.** It's
  generated into Secrets Manager, but CloudFormation resolves it into
  `Environment.Variables` at deploy - so anyone with `lambda:GetFunctionConfiguration` on
  `ControlPlaneFn`, `ScheduleTriggerFn` or `IngestFn` can read it, a wider audience than
  `secretsmanager:GetSecretValue` on the secret. That matters because the proxy's
  authorization is **stateless from the token**: with the key you can forge a session token
  naming any org, any agent creator and any integration id, then call
  `POST /internal/integrations/call` and have the proxy inject that tenant's stored
  credential - cross-tenant, with no table access and no valid agent. Reading the secret in
  the handler instead would close it, at the cost of making config resolution async; it is
  not done. Keep those three functions' IAM tight, and treat `lambda:GetFunctionConfiguration`
  on them as equivalent to holding the key.
- **The agent process runs as root inside the microVM.** `apps/agent-runtime/Dockerfile` sets
  no `USER`, so `run_bash` executes as uid 0. The security boundary is the microVM and the
  Bedrock-only IAM role, not in-container privilege separation - an agent that escalates
  inside its own container gains nothing it didn't already have (it authors the commands).
  Adding a non-root `USER` is defence in depth we haven't done, and is worth doing if you
  harden this for multi-tenant use.
- **JWT `audience` is not validated.** `jwtVerify` (`apps/control-plane/src/auth.ts`) checks
  the `issuer` and the required `agency/api` scope, but not `aud`. So a token minted by the
  SAME Cognito pool for a different app client would be accepted. That's a single-pool
  deployment, so the practical blast radius is "another client of your own pool"; it matters
  more if you add app clients with different privilege levels, and it is on the backlog.
- **A few narrow concurrency residuals** are documented in `CLAUDE.md` (a straggler message
  during a terminal write; a shared-session *status-reporting* edge; conversation-window
  truncation at 40 turns). Each is described with the conditions that make it narrow. Note the
  serious version of the shared-session case - one client's session id reaching another
  agent's warm microVM - is **closed**, not accepted: the runtime-facing session id is derived
  from `(agentId, clientSessionId)`, so two agents cannot name one microVM.

Two facts that bound the residuals above, worth stating explicitly:

- **The control-plane Lambdas are not VPC-attached.** So the SSRF DNS gap has no internal
  network to pivot into, and Lambda exposes no instance metadata service. That is most of why
  that residual is benign rather than severe.
- **The public ingest API serves three unauthenticated routes** - `/health`,
  `/openapi.json`, `/skill.md` - and nothing else. Everything under `/internal/*` requires a
  per-session capability token, and the management routes are unreachable there.

## Deployment hardening checklist

Not exhaustive, but these are the ones that matter most:

- [ ] API Gateway usage plan or WAF in front of the control-plane; budget alarms on the account
- [ ] Review the runtime IAM role and scope model invocation to the models you actually use
- [ ] Decide who may create agents - that is code execution
- [ ] Set `webCallbackUrl` (the invite email's sign-in link) - or a custom `domainName`, which
      supplies it - and, if you share a region with
      another deployment, `cognitoDomainPrefix` - see the README
- [ ] Tune the per-invocation budget for your models and workload; the defaults are
      generous, and it bounds ONE invocation - a caller who keeps re-invoking gets a fresh
      allowance each time, so it is not a spend cap. Add billing alarms
- [ ] Confirm `AUTH_DISABLED` is unset in every deployed environment. The app refuses to boot
      with it set unless `PUBLIC_API_URL`'s host is loopback - but **verify rather than
      assume**: that variable is the origin the API advertises, not a bind address, so
      leaving it at its default while setting `AUTH_DISABLED=true` passes the check and
      serves an unauthenticated admin API on every interface. The guard catches a
      deployment configured for the internet, not one merely reachable from it
- [ ] Decide your retention posture: nine tables and the traces bucket are `RETAIN`,
      trajectories TTL at 30 days, and archived traces are kept FOREVER (no lifecycle
      expiry) - so prompt + tool-IO content accumulates indefinitely. Add a lifecycle rule
      if your jurisdiction or policy requires bounded retention. CloudWatch logs are the one
      store already bounded: every group the platform writes to expires at 30 days
      (`infra/lib/logging.ts`), and the logs deliberately carry ids rather than prompt
      content - see the Logs section of [docs/deployment.md](docs/deployment.md)
- [ ] If you federate to an external identity provider, re-read [docs/auth.md](docs/auth.md) -
      the email claim is an authority input for invite acceptance

## Supported versions

There are no releases yet; `main` is the only supported branch. Fixes land there.
