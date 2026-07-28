# Triggers

A trigger is *how an agent gets invoked*. An agent's config carries a list -
`triggers: Trigger[]` in `packages/shared` - a discriminated union so new managed triggers
(Slack, GitHub, …) slot in as new members without reshaping config. An agent can hold
several triggers at once.

```ts
type Trigger =
  | { type: "api" }                                          // always present
  | { type: "schedule"; expression: string; timezone?: string; prompt: string };
```

## api

The baseline, always present. The agent's per-agent API key authorizes `POST /invoke`
(and `GET /sessions/...` for polling). This is what the UI playground and the integration
snippets use. Nothing to provision.

## schedule

A recurring, unattended run. Backed by **one EventBridge Scheduler schedule per agent**,
named `af-<agentId>` in the `agency` schedule group.

- `expression` - an EventBridge Scheduler expression: `rate(1 hour)` or
  `cron(0 9 * * ? *)`. Validated at the API boundary (`parseTriggers` /
  `validScheduleExpression`), which also enforces a **minimum cadence of
  `MIN_SCHEDULE_MINUTES` (5 min)** - the cron minute field is fully expanded
  (lists, ranges, steps, increments), so no syntax slips a sub-5-minute schedule
  past the floor. Each tick is an unattended billable run; the floor is a
  cost/abuse guard until a usage plan + per-agent concurrency cap land.
- `timezone` - IANA zone the cron is evaluated in (default `UTC`).
- `prompt` - the message delivered to the agent on each tick.

### How it fires

The schedule targets the **trigger Lambda** (`apps/control-plane/src/trigger-lambda.ts`)
with `{ agentId }`. On each tick the Lambda loads the agent, reads its schedule's stored
`prompt` from config, and invokes the runtime with a **fresh session** (unattended runs
don't share a conversation). Because the prompt lives in config (the single source of
truth), editing it needs no schedule change - only `expression`/`timezone` are reconciled
onto the EventBridge schedule.

**Retries are bounded** (`RetryPolicy`: 2 attempts, 5 min max age). Scheduler's default
for a Lambda target is up to 185 attempts over 24h, and each attempt mints a FRESH
sessionId - so one failing tick could start 185 billable agent runs. A tick is periodic
by nature: a couple of retries covers a transient blip, and the next tick is the real
retry. There's no DLQ; a tick that exhausts its retries is dropped (visible in the
Lambda's logs/metrics). The failure modes that matter now throw rather than run a
degraded agent - see `resolve-attachments.ts`.

### The seam

`ScheduleProvisioner.reconcile(agentId, schedule | null)` is idempotent: upsert when a
schedule is present, delete when null. Called on create and on any `PATCH` that touches
`triggers`.
It is also called once more, compensating, if that PATCH's config write then fails - so
EventBridge never runs a schedule the stored config doesn't contain (see docs/metrics.md).

- **prod** - `EventBridgeScheduleProvisioner` (create/update/delete schedule; the
  control-plane role holds scoped `scheduler:*` on `schedule/agency/*` and `PassRole`
  on the scheduler role).
- **local** - `LocalScheduleProvisioner`, a no-op: docker-compose has no EventBridge, so a
  scheduled agent's recurrence isn't fired automatically. Exercise it by invoking the agent
  directly (the schedule's stored prompt is what the prod trigger Lambda would send).

## Adding a managed trigger later (Slack, GitHub, …)

The shape is deliberately uniform, so a new trigger is:

1. A new member of the `Trigger` union in `packages/shared` (provider fields + an optional
   `prompt`).
2. A `parseTriggers` branch validating it.
3. A provisioner implementing the same reconcile/remove seam for that provider's AWS
   resource (or external registration).
4. A card in `apps/web/src/Triggers.tsx` - a toggle, provider fields, and a **clear "what
   you must configure on your side"** panel (the Slack/GitHub cards are stubbed there today
   as "Soon").

The design goal is *as managed as possible*: the platform owns the AWS/infra side; the user
does the minimum, clearly-instructed setup on the provider side.
