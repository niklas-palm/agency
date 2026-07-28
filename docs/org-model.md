# Organization model

The top of the ownership hierarchy. Every resource (agent, skill, integration)
belongs to exactly one **organization**; users belong to orgs via **memberships**
that carry a **role**; and each resource has a **`shared`** flag that decides
whether the rest of the org can see it. This doc covers the data model, the
lifecycle (bootstrap / invite / cascade), and the access patterns. The
*authorization* rules (roles → scopes, `canView`/`canWrite`, the request pipeline)
live in [auth.md](auth.md); this doc is the data + lifecycle companion.

## The shape in one paragraph

A user signs in and gets a **personal org** for free (auto-created, non-deletable,
`orgId == userId`). They can create **team orgs** and invite others by email; an
invitee sees the pending invite on their next sign-in and accepts it, becoming a
member. Membership role is `admin` / `editor` / `viewer`. When someone creates an
agent/skill/integration it's stamped with the active `orgId` + their `userId`
(`createdBy`) + a `shared` flag (default true). A shared resource is visible to the
whole org; a private one only to its creator. The active org rides the
`X-Agency-Org` header on every management request.

## Tables (`infra/lib/data-stack.ts`, mirrored in `scripts/ensure-tables.ts`)

| Table | PK | SK | GSI | Purpose |
|---|---|---|---|---|
| **orgs** | `orgId` | — | — | one row per org (personal + team alike): `name`, `kind` (`personal`/`team`), `createdBy`, `createdAt` |
| **memberships** | `orgId` | `userId` | `byUser` (pk=`userId`) | the **authority source**: `role` + `joinedAt` + `email` (captured at join - invite-accept / personal-org bootstrap / team-org create - and self-healed from the token's email claim on auth; a member who has never signed in has none, so `GET /orgs/:id/members` resolves it via `IdentityProvider.emailFor` and writes it back, so it's one lookup per member once it resolves rather than one per read. So the roster + managers picker show a readable email, not the Cognito sub. Two caveats at scale: an email that does NOT resolve (deleted user, throttled call) caches nothing and is re-asked next read, and `AdminGetUser` counts toward Cognito's billable MAU - so a very large cold org would want `ListUsers` (not MAU-billable) instead). `byUser` answers "which orgs am I in" for the switcher |
| **invites** | `email` (lowercased) | `orgId` | `byOrg` (pk=`orgId`) | pending invite: `role`, `orgName`, `invitedBy`, `createdAt`. email-keyed so the invitee's inbox is one query |

The **existing** resource tables gained org columns (and re-keyed where owner-scoped):

| Table | Key | Org columns |
|---|---|---|
| **agents** | pk=`id`, GSI `byOrg`(pk=`orgId`) | `orgId`, `createdBy`, `shared`, `managers?` |
| **skills** | pk=`orgId`, sk=`id` | (`orgId` is the partition key) `createdBy`, `shared`, `managers?` |
| **integrations** | pk=`orgId`, sk=`id` | (`orgId` is the partition key) `createdBy`, `shared`, `managers?` |
| **tokens** | pk=`tokenHash`, GSI `byOwner`(pk=`ownerId`) | `ownerId` (=userId) + `orgId` (the token's bound org) |
| versions / sessions / trajectory | keyed by `agentId` / `sessionId` | **none** - scoped transitively through the (org-checked) agent |

`versions`/`sessions`/`trajectory` carry no org column: they're only ever reached
through an agent that's already been `canView`-checked, so they re-scope for free.

The optional **`managers`** column (a list of member userIds) **grants** write to
specific co-members beyond the creator + admins; it never widens visibility (a
private resource stays creator-only) - see `canWrite` in [auth.md](auth.md).

## Why `orgId == userId` for personal orgs

A personal org's id is deterministically the user's id. This makes bootstrap **O(1)
and idempotent** - `resolveRole` can create-or-noop the personal org without first
querying "which org is mine", and it's the anchor for the escalation guard
(`orgId === personalOrgId(userId)`). Team orgs get a minted `org_<uuidv7>` id, which
can't collide with a Cognito `sub`. The one wrinkle to remember: for a personal org,
`orgId === createdBy === userId` (the three alias).

## Wire types (`packages/shared/src/org.ts`)

- `Role` = `"admin" | "editor" | "viewer"`; `ROLES` (descriptions), `ALL_ROLES`,
  `isRole`, and `scopesForRole` (the role→scope map - see auth.md).
- `Org`, `Membership` (stored - now carries `email?`, captured at join, self-healed
  on auth, and backfilled from the identity store on a roster read), `OrgMembership` (an org + the caller's role, for `GET /me`), `Member` (the
  members-list projection, also carrying `email?`), `Invite`, `Me`.

Org/member/invite **request** bodies are small and validated inline in the routes +
described directly in the OpenAPI spec, so there are no TS interfaces for them (they'd
only be a drift risk).

## Lifecycle

**Bootstrap.** On the first authenticated request, `resolveRole` (auth.ts) creates
the caller's personal org + an `admin` membership if absent. `GET /me` returns the
identity + every org they're in (with role) + the active org.

**Create a team org** (`POST /orgs`, JWT-only). Mints `org_<uuidv7>`, writes the org
row + an `admin` membership for the creator.

**Invite → accept** (email-keyed, interactive-only):
1. An admin `POST /orgs/:id/invites` `{ email, role }` → a row in `invites`, and the
   `IdentityProvider` seam's `ensureUser(email)` lazily provisions a login: if the email has
   no Cognito account, `AdminCreateUser` creates one and Cognito emails the temp-password
   invite; an existing user is a no-op (idempotent - `UsernameExistsException` is swallowed,
   no email, no duplicate). So a pending invite can always be claimed. The `"created"` vs
   `"exists"` outcome is deliberately **not** returned: on a caller-chosen email that's a
   Cognito user-existence oracle at the app layer, re-opening what the pool's
   `preventUserExistenceErrors` closes - and nothing consumed it. Local dev uses a no-op
   provider; the seam is chosen by whether `USER_POOL_ID` is set (prod sets it via CDK), not
   by `MODE`.
2. The invitee `GET /invites` (matched to their JWT `email`) sees it, then
   `POST /invites/:orgId/accept` → a membership is created, the invite deleted.
   (`decline` just deletes it; an admin can `DELETE …/invites/:email` to rescind.)
   These are JWT-only because they're matched by the login's verified, canonicalized (trimmed +
lowercased in `authorizePayload`) email - the invites PK is lowercased too, so both
sides of the match are canonical and a case-variant claim can't resolve someone else's
invite - a PAT
   carries no email and can't join orgs.

**Role changes / removal** (`PATCH`/`DELETE /orgs/:id/members/:userId`, admin-only).
The **last-admin invariant** - an org always keeps at least one admin - is enforced
**atomically**, not by a count-then-write. A plain count can't hold it: in a 2-admin
org, two requests demoting the two *different* admins both count 2, both pass, and
the org ends with ZERO admins - a state no route can repair, since every route that
could requires an admin. So the route picks a **witness** (`otherAdmin`: another
member it just read as admin) and `demoteAdminIfWitnessRemains` applies the change
inside a DynamoDB transaction whose `ConditionCheck` requires that witness to *still*
be an admin. The loser of the race gets a **409** ("reload and try again"); on its
retry it may genuinely be the last admin and get the 400. Because membership + role
are re-read every request, an applied change is effective immediately - a removed
member's PAT 401s on its next call.

Both member writes are also **conditional on the row still existing**
(`attribute_exists(userId)` - on the plain `updateMembershipRole` and on the last-admin
transaction's `Put` alike), so a role change racing a concurrent removal LOSES instead of
resurrecting the removed member at the role being written. Without that, a promotion
restored them as an `admin` and re-armed their org-bound PATs; the loser now reports
**404 "not a member"**. **Removal also revokes the user's per-resource
manager grants** across the org's agents/skills/integrations - see docs/auth.md for why
a leftover grant would be a latent write permission.

**Org deletion** (`DELETE /orgs/:id`, admin-only). A **personal org can't be
deleted**. A team org cascades: every agent (+ its schedule), skill, integration,
membership, and invite in the org is torn down, then the org row.

## Access patterns

| Need | How |
|---|---|
| Resolve the caller's role in the active org | `getMembership(orgId, userId)` (one GetItem per management request) |
| Which orgs am I in (switcher) | `listMembershipsByUser(userId)` via the `byUser` GSI |
| Members of an org | `listMembersByOrg(orgId)` (partition query) |
| My pending invites | `listInvitesByEmail(email)` (partition query on the email PK) |
| An org's pending invites (admin) | `listInvitesByOrg(orgId)` via the `byOrg` GSI |
| List an org's visible agents | `listAgentsByOrg(orgId)` (byOrg GSI) → filter `canView` |
| List visible skills/integrations | partition query on `orgId` → filter `canView` |
| Resolve an agent's skills/integrations at invoke | by `(record.orgId, id)`, filtered by `visibleToCreator` against the agent's creator (the Q4 recheck - see below) |

## The invoke path (no principal)

Invoke + poll are authed by the agent's **API key**, not a user principal - so
visibility at invoke is judged against the **agent's creator** (`record.createdBy`),
not a caller. `resolveSkills`/`resolveIntegrations` filter attached resources by
`visibleToCreator(resource, agentCreatedBy)`: if a co-member un-shares (or deletes) a
skill an agent had attached, the next run silently resolves without it - graceful
degradation, never a hard failure. The per-session capability token carries
`orgId` + `agentCreatedBy` so the integrations proxy can resolve the (org-scoped)
integration record and re-run the same visibility check **without an agents-table
read** (keeping the ingest Lambda minimally privileged - see
[runtime.md](runtime.md) / [integrations.md](integrations.md)).

## IAM

`ControlPlaneFn` holds read/write on orgs + memberships + invites (it serves the
org/member/invite routes and resolves membership on every management request) plus
`cognito-idp:AdminCreateUser` + `AdminGetUser` on the user pool (the invite path's lazy
login provisioning, and the roster's userId → email lookup; `USER_POOL_ID` is env). The
schedule-trigger + ingest Lambdas need no new grant: the trigger resolves everything
from the agent record's `orgId`, and the proxy resolves integrations from the session
token's `orgId` claim on the integrations table it already reads.

## Testing

The org rules are the hard acceptance gate:
- `authz.test.ts` - the pure visibility/ownership matrix (canView/canWrite/authorize).
- `org-isolation.test.ts` - non-member denied; private invisible-to-admin (Q2);
  editor can't edit a co-member's shared resource, admin can (Q3); cross-org 404s;
  the API-key gate.
- `org-routes.test.ts` + `org-invites.test.ts` - `GET /me`, org CRUD + cascade, the
  member role/last-admin invariants, and the full invite lifecycle.
