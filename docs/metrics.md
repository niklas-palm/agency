# Versioning & metrics

How an agent's config history and operational metrics work. Both are built on two
small append/overwrite tables, keeping the write paths simple and the existing
agents/trajectory tables untouched.

## Versioning

The agent item on the **agents** table holds the *current* config plus a numeric
`version` (starts at 1). The full history lives on the **agent-versions** table
(`pk=agentId, sk=version`), one immutable snapshot per config change.

- **Create** writes the agent (version 1) and appends version 1.
- **Edit** (`PATCH /agents/:id`) - when the merged config differs from the
  current one, `applyNewVersion` reconciles the schedule **before** persisting (so a
  schedule EventBridge rejects fails the request with nothing written), appends the new
  config as `version+1`, and bumps the agent. If that write then loses, the schedule is
  **restored** - re-read the stored config and reconcile to that - because the mirror
  failure would otherwise leave EventBridge running a schedule the stored config never
  contained. Best-effort: the caller gets the original error either way. No runtime re-bake: config rides the next
  invoke to the shared runtime. A no-op config diff mints no version.
- **Restore** (`POST /agents/:id/versions/:version/restore`) appends the target
  version's config as a NEW version (with note `restored from vN`). History stays
  linear, so "latest = live" is never ambiguous - this also leaves room for A/B
  later without a rewrite.
- **Invoke always runs the latest.** The control-plane sends the agent's current
  `config` + `version` in the invoke payload; the runtime stamps `version` on the
  session summary it writes.

`description` is deliberately NOT versioned - it's metadata on the agent record
(a roster label), so editing it never bumps a version.

### The bump is a compare-and-swap

`version+1` is a read-modify-write, so the two writes are **conditional** and
`applyNewVersion` retries (bounded, with backoff) when it loses:

- `putVersion` claims the slot - `attribute_not_exists(agentId) AND
  attribute_not_exists(version)`.
- `updateAgent` guards on the version it read - `version = :expected` (or
  `attribute_not_exists(version)`, for legacy records that predate versioning).

On `ConditionalCheckFailedException` the loser backs off, re-reads the agent, **and
reconciles against history** (`highestVersion` - the max of the agent's `version` and the
highest version row that exists) before recomputing. That second read isn't redundant:
`putVersion` can succeed while the following `updateAgent` fails *non-conditionally*
(throttling, timeout), leaving an **orphaned** row at a version the agent doesn't point
at. Recomputing from the agent alone would re-claim that taken slot on every attempt, so
every config edit and every restore would 503 forever with no API path to recover. The
claim and `expectedVersion` are tracked separately, since they're different numbers once
history is ahead: the claim skips the orphan, the guard stays the record's real version.

A history row can therefore exist that the agent never pointed at (the orphan). It stays -
the next edit skips past it rather than reusing the slot - so history is append-only and
monotonic, but not gap-free with respect to what actually ran. Without this, two concurrent PATCHes both read
`version=5`, both compute 6, and one config silently vanishes from history while
the agent's live `config` can disagree with the v6 snapshot it points at - the
history would *lie* about what's running. Sustained contention (all attempts
lost) surfaces as a transient `503 retry shortly`, not a 500.

Two edits to the same field still resolve last-write-wins; the guarantee is that
every *applied* config appears in history exactly once, under the version the
agent actually points at.

## Metrics

The **agent-sessions** table (`pk=agentId, sk=runId`) holds one durable summary
per session - the source of truth for all operational metrics. No counters to
keep in sync; every dashboard number is a query + aggregate over these rows.

### The write path (runtime, at session-end)

A microVM serves one session for its whole lifetime (up to 8h, across many
back-and-forth triggers). The runtime accumulates in memory
(`session-metrics.ts`: turns, tool uses + per-tool breakdown, injections, and
token usage) and POSTs the summary to the control-plane's **ingest API** each
time the session goes idle, and on error - the runtime writes no DynamoDB itself
(its role is Bedrock-only; see docs/runtime.md). The breakdown is keyed by the tool
name `run.ts` recorded on the trajectory event, so an integration call is counted as
`call_integration:<integration name>` - one key per downstream API, not one for all
of them (docs/runtime.md explains the labelling; rows written before it keep the bare
`call_integration` key, so a window spanning the change shows both). The ingest
handler **overwrites**
one row per (agentId, runId). Token usage comes from the Strands Agent's own accumulator
(`agent.metrics.accumulatedUsage`, read in `run.ts` after each turn) - it's
**cumulative** across the session (the Meter is never reset), so the accumulator
stores the latest snapshot rather than summing per turn (summing would
double-count). The four token fields (input / output / cache read / cache write)
plus the session's `model` are written on the row - **exactly as the provider reported
them**, which is why the read side normalizes them (see below). The
row's sort key is `runId` - a per-microVM-lifetime nonce - so:

- a session's many triggers refresh **one** row (no double-counting);
- a client reusing a `sessionId` after its microVM exited spins up a fresh
  microVM → fresh `runId` → a **new** row (no clobbering a prior lifetime).

So "sessions" counts runtime lifetimes - the real unit of work - not
client-supplied ids that may repeat. Writes are best-effort (like trajectory): a
metrics failure never aborts a turn. A microVM that dies before going idle skips
its summary, so it never counts toward the error rate - an accepted gap. (Its
*trajectory* does get closed out: the poll path writes a synthetic terminal `error`
after 30 min of silence, so clients don't hang. That fix deliberately stops at the
trajectory - `ControlPlaneFn` holds READ-only on this table by design, and widening
that grant to fix a counter isn't a trade worth making. See docs/control-plane.md.)

### Run history (the durable trace archive)

The same summary rows are the **run list**: `GET /agents/:id/runs` reads them newest
first (`runId` is a UUIDv7, so a descending key query needs no in-code sort) and they're
retained forever - so the list covers runs of any age, with no extra storage.

A run's **trajectory** is the part that expires: the trajectory table carries a 30-day
TTL. So when a session summary lands, `IngestFn` archives that run's events to
`s3://<traces-bucket>/traces/<agentId>/<runId>.json`. `GET /agents/:id/runs/:runId` reads
the table first and falls back to the archive, reporting which via `archived`.

The stored object is **self-describing** (`StoredTrace` in `packages/shared`): a small
envelope naming the run (`agentId`, `runId`, `sessionId`, `version`, `model`, `startedAt`,
`endedAt`, `outcome`, `archivedAt`) around the `events` array. Traces are kept forever, so an
object outlives the trajectory rows and can outlive the agent record itself - a bare event
array couldn't say which agent or config version produced it. All of it is copied from the
run's session summary, so there's nothing extra to compute. The read path accepts both shapes
(objects written before the envelope are a bare array), because nothing deletes a trace.

Four things worth knowing:

- **The archiver is `IngestFn`, not the runtime.** The runtime's role is Bedrock-only by
  design and it doesn't retain events - it streams them out. `IngestFn` is the one
  component already holding both the trajectory read and the bucket write.
- **A run is addressed by `runId`, not `sessionId`.** A client may reuse one sessionId
  across microVM lifetimes, and each lifetime is its own run writing into that SAME
  trajectory partition. Keying the object by session therefore let a later run's archive
  OVERWRITE an earlier one - and once the earlier run's rows had TTL'd, its trace was
  gone and its row in the run list silently opened the newer run's steps. One object per
  run can't collide. The route resolves `runId` → the run's summary row first, so an
  unknown run is a 404 and the id that builds the S3 key is always one we wrote.
- **It re-archives.** The runtime posts a summary at every idle point, so a growing run
  is written repeatedly; events are append-only, so each write is a superset. An empty
  read is skipped, so a not-yet-visible or already-expired read never clobbers a good
  archive with `[]`.
- **A missing archive and a broken one are not the same as a failed read.** A
  `NoSuchKey`, or an object that isn't parseable JSON, reads as "no archive" (empty run).
  A throttled or unavailable S3, though, is re-thrown → a retryable 503, because telling
  someone their trace is permanently gone when a retry would serve it is a lie the UI
  can't walk back.

Archived traces are **kept forever** - there's no lifecycle expiry, and nothing deletes an
object either (no Lambda holds `s3:Delete*`, by design; deleting an agent or cascading an org
orphans its traces, leaving them unreachable but present). A trajectory is the record of what
an agent actually did, so a run stays openable for the life of the deployment. The accepted
cost is storage growth and indefinite retention of prompt content.

Archiving started when the feature shipped, so runs whose trajectories had already aged
out return `events: []` with `archived: false` too - the UI says the steps are gone
rather than rendering a blank successful run. Locally there's no bucket (`TRACES_BUCKET`
unset), so both sides no-op and runs serve from the table alone.

The response is **size-capped** (~2.5 MB of serialized events, the same order of budget
as the integrations proxy). A run can accrue many turns of events (the per-turn budget bounds
one invocation, but a session's many triggers all archive under one runId), and a trace is one
JSON body, so an unbounded response would blow the Lambda's ~6 MB ceiling - an opaque 502
that makes the run unopenable forever. A clipped trace keeps its OLDEST events (a trace is
read top-down: the prompt and first steps explain the run) and sets `truncated`, which the
UI states plainly rather than passing a partial trace off as complete.

*Known cost characteristic:* re-archiving at every idle point means a long
back-and-forth session re-reads and re-writes its whole trajectory once per idle point
(O(n²) in the number of idle points). Session trajectories are small and the ingest
Lambda has ample headroom, so this is accepted rather than optimized; archiving only on
the terminal post would fix it but loses the trace of a session that dies mid-flight.

### The read path (control-plane)

`GET /agents/:id/metrics?hours=N&version=V` (`repo/sessions.ts`; a non-numeric
`version` is a **400** rather than a NaN filter that would match nothing and render a
confident all-zeros dashboard) reads the agent's
summary rows, filters to the window (and optionally one version), and rolls them
up into a `MetricsSummary`: window totals (sessions, errors, tool calls, avg
duration, tokens + cost), a time series, and a window-wide tool breakdown.

The read is **bounded on the sort key**, not a whole-partition query: `runId` is a
UUIDv7, whose leading hex is the unix-ms timestamp, so `runId >= runIdLowerBound(t)`
range-scans by time. The dashboard polls every ~15s, and reading an agent's entire
lifetime history each time made cost grow without limit as the agent aged. The bound
is intentionally loose - it subtracts 8h (AgentCore's max session lifetime) from the
window start, because `runId` records when a session *started* while the window
filters on `endedAt`, so a long session can start before the window and end inside
it. `aggregate` still applies the exact window, so the bound narrows the read
without changing the result.
**Duration percentiles are per INVOCATION, not per session.** An invocation is one
continuous working span (the agent runs until it goes idle); a mid-work injected
message folds into the current span, a re-trigger after idle is a new span. The
runtime records each span's active duration (`invocationDurationsMs` on the row) -
that's "how long a run took." The row's `durationMs` is the whole-microVM-lifetime
span (incl. idle gaps between invocations) and is NOT used for percentiles; legacy
rows without the per-invocation array fall back to it as a single sample.
**Cost** is computed read-side: each session is priced at its own `model`'s rate
from the `MODEL_PRICING` map (`packages/shared/src/models.ts`, `costFor`), summed
over the window. Pricing on the read side means a rate correction re-prices
history on the next dashboard load (there's no frozen per-row cost). Aggregation is
done in code over
a bounded window - session volumes are modest, and this keeps the write path a
single Put with no rollup coordination. Add day-bucket rollup rows if volume ever
demands it.

#### The two providers count cache hits differently

A stored row's four token fields are whatever the provider reported, and the two
providers don't agree, so every read path runs the row through `normalizeUsage(model,
tokens)` (`packages/shared/src/models.ts`) before summing or pricing it:

- **Bedrock/Converse (Anthropic)** excludes cache tokens from `inputTokens`: total
  input = `inputTokens + cacheReadInputTokens + cacheWriteInputTokens`. The four
  drivers are already disjoint.
- **OpenAI (Mantle)** includes them: `cached_tokens` says how many of `input_tokens`
  were a cache hit, and the cached rate replaces the input rate for those tokens.
  Strands maps it onto the same `cacheReadTokens` field, so nothing downstream can
  tell the conventions apart.

Without the subtraction an OpenAI run's cache hits were counted twice in
`totalTokens` and charged twice in `costUsd` (input rate *and* cache rate). That is a
multiple, not a rounding error: on a long session most input is a cache hit - an
observed run had 4.4M of its 5.2M input tokens served from cache, so it read ~1.8x
the tokens and ~4.8x the cost. Normalizing read-side (rather than at write time)
means rows written before the fix also come out right.

#### Where the rates come from

Both providers' numbers are more specific than "the list price", and both
distinctions are worth real money:

- **Anthropic**: Bedrock's rate, not Anthropic's first-party one, and Bedrock has two
  tiers - a `global.` inference profile is 1x, a geo-pinned (`eu.`/`us.`) or in-region
  one is **1.1x**. `MODELS` uses `eu.` profiles (a profile prefix must match the
  calling region - see docs/models.md), so `MODEL_PRICING` carries the geo-tier rate.
  Within a tier the rate is the same in eu-north-1 and us-east-1. `sonnet-5` is on
  promotional pricing through **2026-08-31** ($2.2/$11 geo), reverting to $3.3/$16.5.
- **OpenAI via Mantle**: AWS publishes a Mantle rate for `gpt-oss-*` only (that one is
  exact, and identical in both regions); the gpt-5.6 family is priced from OpenAI's own
  standard short-context list, since AWS publishes nothing for it. Two bounded gaps
  remain, both stated in the map: Bedrock-brokered OpenAI billing "may differ" from
  OpenAI's list, and the long-context tier (2x) isn't modelled. Strands' Responses
  adapter never surfaces OpenAI's `cache_write_tokens`, so an OpenAI run reports no
  cache writes at all - they're priced in the map but always 0 today.

The single-rate-per-model table means a rate change re-prices *history* too. Doing that
properly needs an effective-dated table keyed on the run's `endedAt`; today's cost
figure is "what this run's tokens would cost at today's price", which is the honest
reading of a read-side price.

Every numeric on a summary row is **written by the runtime and not shape-validated at
ingest** (see CLAUDE.md's within-tenant ingest residual), so the read side coerces: a
missing or non-numeric field contributes `0` (or `1`, for `invocations`) rather than
`NaN`. One `NaN` would propagate through every sum, percentile and bucket and render the
whole window as `null` on the wire. `normalizeUsage` does that coercion for the token
bundle (`costFor` and `tokenTotal` harden their inputs too), and the run-list projection
defaults the same fields.

### The UI

The agent **detail page opens on the Monitor tab** (front and center): stat tiles,
a per-session cost strip (mean/p50/p95/p99), charts for sessions & invocations,
errors and spend (the last two only when there are any), and a per-tool chart +
breakdown - over a selectable 1h/6h/24h/7d/30d window (default 24h), refreshing
every 15s. The per-tool views are keyed by the same label the trajectory uses, so
an integration call counts under the downstream API it called instead of sharing
one `call_integration` bar (see docs/runtime.md); `prettyTool` renders that key as
the integration's own name. Buckets are hourly for windows up to 7 days and daily
above, so the
default view is hourly. A past-runs list sits below the charts. The **Versions tab** lists
the history; expanding a version shows its config, a restore action, and the same
Monitor scoped to that version. The agent list shows lifetime run counts on their
own row under each agent.

## Tenant isolation

Every version/metrics/runs route resolves the agent via `getAgent` and rejects with
**404 unless the caller can `canView` it** (same org, and shared-or-own - see
docs/auth.md) - identical to the other management routes, so a user only ever sees
versions + metrics for agents visible to them. The agent-versions and agent-sessions
rows carry no `orgId` because the owning agent is org-checked before any read. A run's
trace is additionally resolved through `getRun` in the agent's OWN partition, so a run id
from another agent is a 404 rather than a lookup with a caller-supplied key.
Covered by `org-isolation.test.ts` (agents + versions) and `runs-routes.test.ts` (the
runs routes).

**Run traces are `read`, not `write` - a deliberate choice.** Config `env` values are
redacted for a non-writer (see CLAUDE.md), and a trajectory can contain an env value the
agent echoed into a tool call, so the two rules aren't identical. `read` wins because a
team debugging an agent together needs its trajectory, and anyone holding the agent key
already sees the same content live on the Run tab. The redaction promise covers the config
surface, not agent output; scrubbing output would be best-effort (an agent can transform a
value past any pattern) and would imply a stronger guarantee than it delivers.

## Tables (infra)

Both are `PAY_PER_REQUEST`, `RETAIN`, PITR on (they hold history/credentials-
adjacent data, unlike the disposable TTL'd trajectory table). Created in prod by
`AgencyData` and locally by `scripts/ensure-tables.ts` - identical schema.
