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

## slack

The agent runs when its bot is **@-mentioned** in an allowed channel, and answers in that
thread. `apps/control-plane/src/slack-*.ts` holds the whole feature.

### One app per agent

The Slack app **is** the agent's identity: it has one name, one avatar, one bot user, and
people address the agent by @-mentioning it. A shared per-org app would need a sub-addressing
convention (`@agency deploy-bot: …`), which is strictly worse than what Slack gives free. One
app per agent also means several agents can sit in one channel, each answering only to its own
name, plus per-agent scopes, per-agent revocation and a per-agent blast radius.

### The user creates the app; we hold no config token

Slack has an `apps.manifest.create` API, but it needs an app-configuration token that can
create or modify **any** app in the workspace, is single-use with a ~12h rotation, and dies
silently if a rotation isn't persisted. That's survivable for a script a human is watching and
a support ticket in a self-service UI - so instead we generate a **complete manifest**
(`packages/shared/src/slack-manifest.ts`) and the user pastes it into Slack's *From a manifest*
flow. It costs them one paste and costs us no high-value credential.

The manifest is complete on purpose - scopes, the `app_mention` subscription, and the agent's
own webhook URL are all baked in. A "manifest minus events" approach leaves the user to enable
things by hand, and when they forget, the app looks installed but never delivers.

### Setup does NOT mint config versions

Connecting Slack, storing credentials, picking channels and toggling the allowlist all write the
trigger directly rather than through `applyNewVersion`. Version history answers "what did this
agent do differently?" - a prompt, a model, a skill - and connection plumbing is none of those.
Routing it through the version path meant a freshly-created agent read as **version 8** before it
had ever run, burying the history that makes the Versions tab worth opening.

### Setup states

Derived from the trigger + whether the secrets exist, never stored - so it can't go stale, and
an abandoned setup resumes where it left off:

`manifest_ready` → `url_verified` → `needs_bot_token` → `verified` → `live`

Two of those transitions are the ones that make the setup feel managed:

- **`url_verified` arrives on its own.** Slack POSTs its `url_verification` challenge the
  moment the app is created, we answer it, and the UI ticks without the user doing anything.
  If it never arrives, the manifest was pasted somewhere else - which is exactly the
  diagnostic we can then give.
- **`verified` reports what Slack actually granted.** `auth.test` returns an `x-oauth-scopes`
  header and the workspace name, so the user sees the real grant, not our request.

`live` additionally requires a channel: a connected agent with an empty allowlist answers
nowhere, and that must not read as "done".

### The security boundary is the HMAC

The webhook (`POST /webhooks/slack/:agentId`) is public and unauthenticated - Slack can hold no
credential of ours - so the signature is the entire boundary. `slack-verify.ts` verifies over
the **raw** body (re-serialized JSON breaks it), with a 5-minute replay window and a
constant-time compare.

**One request cannot be verified: `url_verification`.** Slack fires it when the app is created,
before we could know that app's signing secret. So `isUrlVerification` is deliberately narrow -
it refuses any body that also carries an `event`, because without that clause an unsigned
request could reach the invoke path. Two regression tests pin it.

That's also why **the agentId rides the URL path**: at challenge time there is no
app-to-agent mapping to look it up from. It's the safer design anyway - a forged path selects
the wrong signing secret and fails verification, whereas trusting `api_app_id` from the body
would mean the body chose the key that validates it.

After verification: the bot's own events are dropped (or an agent that mentions itself storms
the channel), a Slack retry is acked without re-dispatching (a duplicate run would double-post
and double-bill), and anything outside the channel allowlist is dropped with a 200 - a
deliberate drop is not a failure, and a non-2xx would make Slack retry.

### One thread = one session = mid-turn injection

`thread_ts` is stable for a thread's life, so the session id is
`slack-<channel>-<threadTs>`. A follow-up mention in a live thread therefore lands on the
**same session** and is *injected into the running turn* rather than starting a second one -
the platform's load-bearing feature surfacing as something a Slack user can feel.

(The runtime-facing id is still hashed per-agent by `runtimeSessionIdFor`, so two agents in
one thread can't collide on a microVM.)

### The agent never holds the bot token

`slack_reply` and `slack_set_status` are wired **only when the invoke payload carries
`fromSlack`** - the trigger is the signal, exactly as integration tools are wired only when
integrations were resolved. Both POST to `/internal/slack/call` with the per-session
capability token, and the control-plane derives the target channel + thread from that token's
`sessionId`. So there is no channel parameter for a prompt-injected agent to aim elsewhere,
and a compromised microVM has no Slack credential to steal.

**The agent can read the thread it was called into** (`slack_read_thread` → the proxy's
`conversations.replies`, capped at 50 messages and flagged when truncated). This is what makes it
useful rather than literal: an invoke carries only the mention's own text, so without it the agent
is guessing at what "this" refers to. The prompt tells the model to call it first whenever the
mention references something it can't see.

### The reaction protocol

**👀 lands the moment a mention arrives**, added by the webhook itself before the agent starts.
That answers "did it hear me?" in the second before anything else can happen - the difference
between a bot that feels alive and one that looks broken. It's awaited (a Lambda freezes on
response, the trap that once silently dropped the dispatch) but never blocks the run: a missing
scope or an unjoined channel must not cost the user their answer.

The four **statuses are mutually exclusive** - setting one clears the others, so a message shows
one state rather than an accumulated history: 🟡 `working` → 🟢 `done` / 🔴 `failed` / ❓
`needs_input`. The emoji match the sibling slack-dev agent's, so both read identically in a
workspace running the two. The removes go out concurrently and their failures are ignored, since a
stale reaction is cosmetic and must not stop the new status landing.

The prompt tells the model to set `working` once it can see the task is slow, and to make the
terminal status its LAST tool call - otherwise it can claim `done` before the reply is posted.

Status reactions map the run's lifecycle: 🟡 working → 🟢 done / 🔴 failed / ❓ needs input. They
target the message that **invoked** the agent, which is not the same as the session key: for a
mention inside a thread the session key is the thread PARENT (often someone else's message, days
old), so reacting to it would decorate the wrong message. The invoking ts therefore rides the
session token as an appended `replyToTs` claim - the token is per-invoke and already verified, so
the agent still has no way to choose its own target. A reply always goes to the thread; only the
reaction needs the exact message.

### Almost no infrastructure - with one grant that is easy to miss

The Slack trigger adds **no CDK resources and no networking**: the secrets live on the agent
record, the user registers the webhook themselves by pasting the manifest, and neither Lambda is
VPC-attached so both reach `slack.com` over normal egress. There is no `SlackProvisioner` either -
unlike `schedule` there's no AWS resource to reconcile; the provisioner seam is for providers we
must register with, and here the user does it.

It does need **one IAM grant**, and getting this wrong is invisible until a real mention arrives.
`/internal/slack/call` is mounted on the shared Hono app, so in prod it runs on **`IngestFn`** -
that's the only ingest URL the runtime has - not on `ControlPlaneFn`. `IngestFn` therefore needs
`AGENTS_TABLE` + agents-table **read**, to reach the bot token and re-check the allowlist. Without
it the table name falls back to a literal that doesn't exist and every reply fails with a 500,
while the agent runs to completion and posts nothing: from Slack, indistinguishable from a broken
bot. This is exactly the shape of the integrations proxy's grant, and for the same reason.

The accepted cost: `IngestFn` can now read the agents table, which carries `slackSecrets` and
`apiKeyHash`. The alternative - carrying the reply target in the session token so the record is
never read - would drop the allowlist re-check that makes a revoked channel take effect on a
thread that's already running.

### Disconnecting

`DELETE /agents/:id/slack` forgets the app: it clears the credentials and everything the app taught
us (app id, workspace, bot user, granted scopes, channels) while KEEPING the trigger, so the setup
panel reappears at step 1. That matters because the Slack app and our record can drift in ways only
a reset fixes - a bot renamed in Slack, an app deleted there, a reinstall into a different
workspace.

Toggling the trigger off in the config form is not the same thing and used to leave a live bot
token on the record; it now clears the secrets too. Deleting the app inside Slack stays the user's
own step - we hold no configuration token, by design.

**Removing a channel needs no Slack connection.** Validation exists to stop a foreign channel id
being stored, so only genuinely NEW ids are checked; shortening or clearing the list works even
after a disconnect. Re-validating the whole list on every save also cost a Slack round trip per
channel, so a ten-channel agent paid ten calls to drop one.

### The channel allowlist is a security control

An agent with a bash tool that answers anywhere it's invited means **anyone who can `/invite`
it can direct it**. So the allowlist is a required, explicit list; empty means nowhere; and
every id is validated against the connected workspace at save time (`conversations.info`),
because channel ids are workspace-scoped and a foreign one produces an agent that looks
configured and silently ignores every mention.

**`allChannels` is the opt-out**, off by default: the agent then answers wherever the bot is
invited, which hands the gate to whoever can `/invite` it. That's the right call for a private
workspace or a low-privilege agent and the wrong one for an agent with powerful integrations,
which is why the UI labels the trade rather than presenting it as a convenience. All three
decision points honour it - the webhook gate, the proxy's mid-thread re-check, and the
setup-state derivation (an agent with `allChannels` is `live` without an explicit list).

Private channels are supported - the manifest requests `groups:read`, which is what lets a private
channel be validated at setup. **The bot must be `/invite`d to any channel, public or private:**
Slack only delivers `app_mention` to an app that's in the conversation, so a channel it hasn't
joined validates green, reports live, and drops every mention.

The scope set describes what the FEATURE needs, not what the code calls today. An earlier version
applied "one scope per call site" and produced an agent that could read a single mention and post a
reply - barely an agent, since a mention three messages into a thread ("can you fix this?") was
unanswerable. So `*:history` is requested for `slack_read_thread`, `files:*` so an agent can attach
a diff or read an upload, and `users:read` so it can name people instead of emitting raw `U0…` ids.

The non-obvious pair is still `channels:read` + `groups:read`, required by `conversations.info` and
`conversations.list`: Slack's hierarchy does NOT let `channels:history` imply `channels:read`.

What's deliberately excluded, so the token can't do more than the product: `chat:write.customize`,
`channels:manage`, `channels:join` (the user invites the bot; we never self-join), `im:history` (we
subscribe only `app_mention`), and anything `admin`.

## Adding a managed trigger later (GitHub, …)

The shape is deliberately uniform, so a new trigger is:

1. A new member of the `Trigger` union in `packages/shared` (provider fields + an optional
   `prompt`).
2. A `parseTriggers` branch validating it.
3. Where the provider needs registration, the same reconcile/remove seam (`schedule`) or a
   signature-verified webhook + setup endpoints (`slack`).
4. A card in `apps/web/src/Triggers.tsx` - a toggle, provider fields, and a **clear "what
   you must configure on your side"** panel (the GitHub card is stubbed there today as
   "Soon"; the Slack card is the worked example).

The design goal is *as managed as possible*: the platform owns the AWS/infra side; the user
does the minimum, clearly-instructed setup on the provider side.
