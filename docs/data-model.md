# Data model

Every store in one place: what it holds, how it's keyed, what reads it, and why it's shaped
that way. The per-store detail lives with the code (`apps/control-plane/src/repo/*.ts`) and
the lifecycle rules live in the topic docs (docs/org-model.md, docs/metrics.md,
docs/integrations.md); this is the map that ties them together.

**Ten DynamoDB tables + one S3 bucket.** No RDS, no cache, no queue. Every table is
`PAY_PER_REQUEST` (no capacity to plan), and every access pattern below is a key lookup or a
bounded key range - there is no `Scan` on a hot path.

## The shape of the model

Three ideas explain nearly every key choice:

1. **The organization is the top ownership unit.** Every tenant-owned resource carries
   `orgId` + `createdBy` + `shared`, so authorization is decidable from the item alone
   (docs/auth.md). Where a resource is only ever listed *within* an org, `orgId` is the
   partition key directly (skills, integrations) - which makes "list my org's skills" a
   single-partition query and makes cross-tenant reads structurally impossible rather than
   merely checked.
2. **UUIDv7 keys sort chronologically.** A v7's leading 48 bits are a unix-ms timestamp, so
   a lexicographic sort on the id *is* a sort by creation time. That's why trajectory
   `cursor`, session `runId`, and the ids of skills/integrations/tokens are v7: newest-first
   listing and time-range reads need no GSI and no in-code sort
   (`repo/sessions.ts:runIdLowerBound` turns a timestamp into a key bound).
3. **Immutable history is append-only, live state is compare-and-swap.** Config history
   (agent-versions) is only ever appended; the agent record it points at is updated under a
   condition. See docs/metrics.md for why that pairing is load-bearing.

## The tables

`pk` = partition key, `sk` = sort key. "Retention" is the CloudFormation removal policy.

| Table | pk / sk | GSI | Retention | Holds |
|---|---|---|---|---|
| **agents** | `id` | `byOrg` (`orgId`) | RETAIN + PITR | One agent = pure config. The whole "creating an agent" operation is this single write. Also holds the two write-only credentials: `apiKeyHash` and, for a Slack trigger, `slackSecrets` (signing secret + bot token). `toPublic` strips both. |
| **agent-versions** | `agentId` / `version` (N) | - | RETAIN + PITR | One immutable config snapshot per change. Append-only. |
| **agent-sessions** | `agentId` / `runId` | - | RETAIN + PITR | One summary row per *runtime lifetime*: counts, duration, tokens, outcome. The source of every metric AND the durable run index. |
| **trajectory** | `sessionId` / `cursor` | - | **DESTROY**, 30-day TTL | One item per agent action (text, tool call, tool result, lifecycle). The only expiring store. |
| **skills** | `orgId` / `id` | - | RETAIN + PITR | Reusable Markdown instructions, attached to agents by id. |
| **integrations** | `orgId` / `id` | - | RETAIN + PITR | A downstream API + its **write-only** credential + the operation manifest. |
| **orgs** | `orgId` | - | RETAIN + PITR | One row per org, personal and team alike. |
| **memberships** | `orgId` / `userId` | `byUser` (`userId`) | RETAIN + PITR | The authority source: one row per (org, user) carrying the `role`. |
| **invites** | `email` / `orgId` | `byOrg` (`orgId`) | RETAIN + PITR | Pending email-keyed invitations. Deleted on accept/decline/rescind. |
| **tokens** | `tokenHash` | `byOwner` (`ownerId`) | RETAIN + PITR | Personal Access Tokens. Keyed by the hash so auth is one `GetItem`. |
| **traces bucket** (S3) | `traces/<agentId>/<runId>.json` | - | RETAIN, **no expiry** | A finished run's events + a self-describing envelope (agent, version, model, outcome), so they outlive the trajectory TTL. Kept forever. |

### Why each key is what it is

- **agents** is keyed by bare `id` because an invoke arrives with only the agent id (the
  caller holds an API key, not an org context). The `byOrg` GSI serves the roster. Every
  route that takes an id therefore org-checks the record *after* loading it - see
  `canView`/`authorize` in docs/auth.md.
- **skills / integrations** are keyed by `orgId` because they're only ever listed per-org.
  An id alone can't address them, so one org's id can't resolve in another's partition.
- **memberships** is `(orgId, userId)` for "what is this user's role here?" - the question
  asked on *every* request - and carries the `byUser` GSI for "which orgs am I in?" (the
  org switcher). Both directions are needed, so both are keyed.
- **invites** is keyed by `email` because an invite exists *before* the invitee has a
  userId; it's how a login gets matched to a pending invitation. The email is canonicalized
  (trimmed + lowercased) on both write and read - see docs/auth.md, where that invariant is
  load-bearing.
- **tokens** is keyed by `tokenHash`, not by a token id: authentication is then a single
  `GetItem` on a value derived from the presented secret, with no lookup table and no scan.
  The plaintext is never stored.
- **trajectory** is `(sessionId, cursor)` because polling wants "everything after cursor X"
  for one session - a key-range read. `cursor` is UUIDv7, so write order and sort order are
  the same thing.
- **agent-sessions** is `(agentId, runId)` because the runtime OVERWRITES one row per
  lifetime at each idle point: a session's many triggers stay one row, and a reused
  sessionId on a fresh microVM starts a new one. So "sessions" counts runtime lifetimes -
  the real unit of work - not client-supplied ids that may repeat.

## Retention, and what that means if you delete something

Nine of ten tables are `RETAIN` **with PITR on**: they hold history or credentials-adjacent
data, so `cdk destroy` leaves them behind rather than dropping them. The trajectory table is
the deliberate exception - `DESTROY` + a 30-day TTL, because it's the hot store for polling
and its durable copy lives in the traces bucket.

Consequences worth knowing before you rely on them:

- **`cdk destroy` does not clean up.** Ten tables and a bucket survive, still billable. This
  is the right default for real data and a trap for a throwaway deployment.
- **Deleting an agent leaves data behind.** `DELETE /agents/:id` removes the schedule and the
  agent record. Its **version history is orphaned** (there is no `deleteVersion`), its
  **session rows are retained** (they're the metrics history), and its **archived traces stay**
  in S3 indefinitely - there's no lifecycle expiry and no Lambda holds `s3:Delete*`, by
  design.  They're unreachable (every read goes through an authorized agent record), but
  they are not gone. Deleting an org cascades agents/skills/integrations/memberships/invites, with the
  same caveats.
- **A run stays openable indefinitely.** Both halves are durable: the run *list* (the
  retained summary rows) and the trace behind it - served from the trajectory table for its
  first 30 days, then from the archive, which never expires. Only a run whose trajectory
  aged out *before* archiving existed lists with `events: []`.

## Where the same data appears more than once

Deliberate duplication, each with a reason - worth knowing so a change lands everywhere:

- **Config** lives on the agent record (the live copy), in every agent-versions snapshot (the
  history), and in each invoke payload (the runtime never reads a table). One edit therefore
  writes two places; the CAS in `applyNewVersion` is what keeps them agreeing.
- **`config.env` values** are in the live config AND in every version snapshot, both at rest
  in plaintext. Redacted for non-writers on read, but a stored secret is stored many times.
  Encrypting them at rest (KMS, or secret references) is planned, not done.
- **A run's events** are in the trajectory table (30 days) and the traces bucket (forever).
  The read path tries the table first and reports which it served via `archived`.
- **A member's email** is on the membership row (a cache, for the roster) and authoritative in
  the identity provider. The cache self-heals; the write is conditional so it can never
  resurrect a removed member.

## Local ⇄ prod parity

`scripts/ensure-tables.ts` creates the same ten tables locally against DynamoDB Local, with
**identical key schemas and GSIs** (verified attribute-by-attribute). Two intentional
differences:

- **No TTL locally.** The local trajectory table has no `TimeToLive` spec, so rows never
  expire - harmless because DynamoDB Local runs `-inMemory` and the container is disposable,
  but it does mean the TTL path itself isn't exercised locally.
- **No traces bucket locally.** `TRACES_BUCKET` is unset, so archiving and archive-reads
  both no-op and past runs serve from the trajectory table alone. A local run whose rows
  aged out has no trace to fall back on.

## Reading a store from code

One module per table under `apps/control-plane/src/repo/`, and the routes never touch the
DynamoDB client directly. Each module owns its access patterns, so "how is this queried?" has
exactly one answer per table:

`agents.ts` · `versions.ts` · `sessions.ts` (+ metrics aggregation) · `trajectory.ts` ·
`skills.ts` · `integrations.ts` · `orgs.ts` · `memberships.ts` · `invites.ts` · `tokens.ts` ·
`traces.ts` (S3) · `metrics.ts` (the counters on the agent record).

Which Lambda may touch which table is itself part of the security model - the runtime holds
**no** table access at all, and `IngestFn` is scoped to the two telemetry tables plus a
traces PUT. See docs/deployment.md for the grant-by-grant list.
