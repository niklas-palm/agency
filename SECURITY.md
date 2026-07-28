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
4. **Credentials are hashed at rest** (agent API keys, personal access tokens), so a read of
   those columns never yields a usable credential. An agent key is compared with
   `timingSafeEqual`; a PAT isn't compared at all - authentication is a single lookup keyed by
   the hash of the presented token, which has no comparison to leak timing from. Note the
   scope: integration secrets and `config.env` values are **not** hashed (they have to be
   replayed downstream) - see the trade-offs below.
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
- **Secrets are plaintext at rest in DynamoDB.** Per-agent `config.env` values and integration
  secrets are stored unencrypted beyond DynamoDB's own at-rest encryption, and `config.env` is
  duplicated into every config version snapshot. Values are redacted from API reads for
  non-writers. Encrypting them at rest (KMS, or secret references) is planned, not done.
- **Run traces are readable by anyone who can see the agent.** A trajectory contains prompts,
  tool inputs and outputs. This is a deliberate product decision (a team debugging an agent
  needs its trace) and it means `config.env` redaction covers the *config surface*, not agent
  *output*. Reasoning in [docs/metrics.md](docs/metrics.md).
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
      if your jurisdiction or policy requires bounded retention
- [ ] If you federate to an external identity provider, re-read [docs/auth.md](docs/auth.md) -
      the email claim is an authority input for invite acceptance

## Supported versions

There are no releases yet; `main` is the only supported branch. Fixes land there.
