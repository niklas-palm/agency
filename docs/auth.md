# Authentication & authorization

How a request to the control-plane is authenticated, and how we decide what it's
allowed to do. This is the model to extend when adding new capabilities.

## The organization model

Every resource (agent, skill, integration) lives in exactly one **organization**.
Every user has a **personal org** (auto-created lazily, id == their userId,
non-deletable) and can create **team orgs** and invite others by email. Membership
carries a **role** - `admin`, `editor`, or `viewer` (`packages/shared/src/org.ts`) -
and the role, not the credential kind, determines what the caller can do. This
replaced the old single-user-ownership model where a JWT carried unconditional full
authority; there is no back-compat (the affected tables were wiped).

## Three credential kinds

| Credential | Looks like | Who holds it | Authorizes | Populates |
|---|---|---|---|---|
| **Cognito JWT** | `eyJ…` (bearer) | signed-in user, or an M2M client-credentials script | the management API, at the caller's **role** in the active org | `principal` with the role's scopes, `kind: "jwt"` |
| **Personal Access Token (PAT)** | `agpat_…` (bearer) | a user's coding assistant / script | the management API, limited to (token scopes ∩ role scopes) in the token's bound org | `principal` with that intersection, `kind: "token"` |
| **Agent API key** | `ag_…` (bearer) | whoever triggers one agent | invoke + poll **that one agent** | (separate path - see below) |

The JWT and PAT authenticate the **management** API (`/agents`, `/skills`,
`/integrations`, `/orgs`, `/tokens`). The agent API key authenticates only the
**run** API (`/agents/:id/invoke`, `/agents/:id/sessions/:sessionId`) and is checked
independently in the route (`authAgentByKey`), never touching the scope system.

Two paths carry no Agency credential at all, and each has its own boundary:

- **The Slack webhook** (`POST /webhooks/slack/:agentId`) - Slack cannot hold a credential of
  ours, so an **HMAC over the raw body** with the agent's own signing secret is the entire
  boundary. `url_verification` is the one request that can't be verified (Slack fires it at
  app-creation, before we could know that app's secret), so the exemption is narrowed to a body
  that carries *no* `event` - see docs/triggers.md.
- **The `/internal/*` routes** - authed by the per-session capability token, below.

## The principal

Both credential kinds resolve to one `Principal` (auth.ts):

```ts
interface Principal {
  userId: string;   // the human: JWT sub / M2M client_id / PAT owner. Drives createdBy.
  orgId: string;    // the ACTIVE org - the tenant boundary for every resource
  role: Role;       // the caller's role in orgId (admin | editor | viewer)
  scopes: Scope[];  // effective scopes = role's scopes ∩ (jwt ? role's : token's)
  kind: "jwt" | "token";
  email?: string;   // access-token email claim, for matching email-keyed invites
}
```

> The SPA signs in with an **in-app SRP login form** (`amazon-cognito-identity-js`,
> `apps/web/src/auth.ts` + `views/Login.tsx`) - no hosted-UI redirect; the password
> never leaves the browser - and authenticates the API with the Cognito **access
> token** it mints. A **pre-token-generation V2 Lambda**
> (`apps/control-plane/src/pre-token-lambda.ts`, wired to the pool in the auth stack)
> shapes every access token in two ways:
> - It adds the **`agency/api` scope** (`scopesToAdd: ['agency/api']`). This is
>   load-bearing: `authorizePayload` requires that scope, and while the retired hosted
>   OAuth flow granted it as a resource-server scope, SRP `InitiateAuth` does **not**
>   put resource-server scopes on the token - so without the Lambda every SRP-minted
>   token would be rejected.
> - It copies the user's verified **`email`** attribute into the token - and ONLY when
>   `email_verified === "true"`; an unverified address yields no claim at all, so that
>   user sees no invites and accept/decline returns 400. `authorizePayload` then trims +
>   lowercases it, because invite rows are keyed by a lowercased email: a raw
>   `VICTIM@corp.com` would otherwise resolve the victim's invite while the membership is
>   written under the caller's own `sub`. Access tokens
>   have no `email` by default, so without it `principal.email` would be undefined and
>   every email-keyed feature (invite listing, accept/decline, the personal-org name)
>   would silently no-op.
>
> The email claim is also **stored on the membership** (`Membership.email`) -
> self-healed on auth if absent - so the members roster and the managers picker can
> show a readable email instead of the Cognito sub (see org-model.md). That self-heal
> only fires for the member who is signing in, though, so a co-member who hasn't
> authenticated since we started capturing it has no cached email. `GET /orgs/:id/members`
> therefore resolves a missing one from the identity store (`IdentityProvider.emailFor`
> → Cognito `AdminGetUser`) and **writes it back to the membership row**, so a member
> costs one lookup once it resolves, not one per read. (An email that DOESN'T resolve -
> a deleted user, or a throttled call - writes nothing, so it's re-asked next read.) If the store doesn't know either
> (a deleted user, or local dev with no pool) the field is simply absent and the UI
> falls back to the userId - a label is cosmetic and must never fail a roster read.

## The active org (the `X-Agency-Org` header)

A JWT does not name an org - the active org rides the **`X-Agency-Org`** header and
is **validated against membership every request**. Absent header → the caller's
personal org. Asserting a team org the caller isn't in → `403` (the escalation
guard: `resolveRole` only ever auto-provisions the caller's OWN personal org, never
a team org they merely claimed). A **PAT is bound to one org at mint time** and
ignores the header; its org is fixed.

> **One exception, by construction:** the routes that name an org in the *path*
> (`/orgs/:id/...`) are authorized by `requireOrgRole` against that **path** org, not
> the credential's bound org. Nearly all of them are also `requireUser` (JWT-only), so
> a PAT can't reach them - the sole exception is `GET /orgs/:id/members`, which a PAT
> can call for any org its owner belongs to. That exposes only the owner's own orgs'
> rosters (userId + role + email), and only to a credential that already reads on their
> behalf; it's scope-gated on `read` so a credential with no effective scopes is still
> refused. `GET /me` is likewise readable by any PAT and enumerates the owner's orgs.

`resolveRole` also lazily bootstraps the personal org: the first time a user touches
their personal org (id deterministically == userId, so the lookup is O(1) and
idempotent), it creates the org row + an `admin` membership on the spot, so a
brand-new user "just works".

## Roles

| Role | Scopes | Can |
|---|---|---|
| `viewer` | `read` | view shared resources; **no** create/edit/delete, no console run, no key rotation |
| `editor` | `read`, `write`, `delete` | create resources + edit/delete the ones **they** created |
| `admin` | `read`, `write`, `delete` | everything editor can, **plus** manage any shared resource, members, org config, and org deletion |

`scopesForRole` (`org.ts`) maps a role to its resource-scope set - `viewer → [read]`;
`editor` **and** `admin` → `[read, write, delete]` (they share a scope set). The
editor-vs-admin distinction lives NOT in scopes but in per-resource `canWrite`
(creator, admin, or a listed manager) and in the org-management routes'
`requireOrgRole("admin")` +
`requireUser` gate - so admin's extra powers can never be granted to a PAT.

## Per-resource visibility & write rules

The role sets the *capability* (can I write at all?); a per-resource rule sets
*which* resources. Every resource carries `{ orgId, createdBy, shared }`, and the
uniform rule lives in `authz.ts`:

- **`canView`** = same org **AND** (`shared` **OR** `createdBy === me`). Admin does
  **not** pierce privacy: a co-member's private resource is invisible to everyone
  but its creator.
- **`canWrite`** = visible **AND** (`createdBy === me` **OR** `role === "admin"` **OR**
  `me ∈ record.managers`). So an `editor` **cannot** edit a co-member's *shared*
  resource unless its creator lists them as a **manager**. The optional
  `managers?: string[]` (userIds) on each resource only ever **grants** extra writers;
  the creator and admins always retain write, and it does **not** pierce privacy - a
  private resource stays creator-only (a non-creator can't see it, so a manager grant
  on it is moot). Routes validate each listed manager is an org member and drop the
  creator from the list. The list is **capped at 50** (`MAX_MANAGERS`) - each id costs a
  membership read on the write path and the list is stored on the item - and the excess
  is dropped **silently** rather than 400ing an otherwise-valid edit, the same way a
  non-member id is dropped. **Only the creator or an admin may change the `managers`
  list**: a granted manager can edit the resource's content but not re-delegate the
  grant (add allies / prune peers) - `patchManagers` ignores the field for a plain
  manager and preserves the stored list. So the grant fans out one level only, from
  creator/admin. **Removing a member revokes their grants** (`revokeManagerGrants`
  strips their userId from every `managers` list in the org, storing an emptied list
  as absent). A grant names a userId and nothing re-validates it against membership at
  read time, so leaving it behind would be a latent write permission: the user is
  re-added later as a plain `editor` and silently regains write on resources nobody
  re-granted them. (While removed they can't act at all - `resolveRole` 403s every
  request - and a re-added `viewer` lacks the `write` scope; the `editor` case is the
  hole this closes.)

A single **`authorize(principal, record, need)`** helper does the load-then-classify
in one place (`authz.ts`), returning either the narrowed record or the status+message
to return: a resource that fails `canView` is **404** (never leak existence);
visible-but-not-writable (`need: "write"`) is **403** (you can already see it, so
refusing the edit isn't a secrecy concern). Handlers call it and early-return on
`!ok`, so the visibility/ownership rule can't drift per-route.

## The request pipeline (management routes)

```
requireAuth              → verifies the bearer, resolves the active org + role,
                           sets c.var.principal { userId, orgId, role, scopes, kind, email }
requireScope("…")        → asserts principal.scopes includes the needed scope (403 if not)
requireUser              → asserts principal.kind === "jwt" (token- + org-management routes)
requireOrgRole("admin")  → asserts admin in the PATH org (org/member/invite routes)
handler                  → org-scoped DB access via principal.orgId, per-resource
                           gated by authorize() / canView
```

`requireAuth` (apps/control-plane/src/auth.ts) branches on the bearer:
- Prefix `agpat_` → look the token up **by SHA-256 hash** in the tokens table (an
  O(1) `GetItem`; the hash is the partition key, so there's no brute-forceable
  lookup and no timing-attack surface). Then re-check the owner's membership in the
  token's bound org: **if the owner has lost membership (or been removed), the token
  is dead → 401.** Effective scopes = the token's stored scopes ∩ the role's scopes.
  `lastUsedAt` is bumped best-effort.
- Anything else → verify as a Cognito JWT against the pool JWKS
  (`authorizePayload` is the pure, unit-tested core), then resolve the active org +
  role from the `X-Agency-Org` header. The principal carries **exactly its role's
  scopes** - a JWT no longer bypasses the scope system.

Because membership + role are re-read on **every** request, a role change or a
removal is effective immediately - a demoted user's next write 403s; a removed
user's PAT 401s.

`AUTH_DISABLED=true` (local dev only) short-circuits to a fixed `local-dev`
principal but **still runs org resolution** (bootstrapping the personal org), so the
local stack is a faithful replica.

It makes every caller an admin, so `config.ts` **refuses to start** with it set unless the
deployment is genuinely local: `MODE` must not be `prod` AND `PUBLIC_API_URL`'s host must be
loopback. The check is positive (allow loopback) rather than negative (deny prod) because
`MODE` defaults to `local` - a deployer who self-hosts the container and copies the compose
env without knowing to set `MODE=prod` would otherwise have served a wide-open admin API.
The URL is **parsed**, not pattern-matched: `http://localhost:8787@evil.com/` starts with a
loopback-looking prefix but its real host is `evil.com` (the leading part is userinfo).

## Scopes

Scopes are the single source of truth for *capabilities*, defined in
`packages/shared/src/scopes.ts`. They're resource-**neutral** capability tiers, not
per-resource scopes: each one spans every org-scoped resource - agents, skills, and
integrations - because they're one interdependent workspace. We deliberately keep
them broad (no `integrations:read` etc.).

Scopes now come from the **role** (`scopesForRole`): every principal carries exactly
its role's set, and a PAT further narrows that by its own minted scopes. Scopes
answer "can this caller write at all?"; the per-resource `canView`/`canWrite` rules
answer "which resources?".

| Scope | Grants |
|---|---|
| `read` | read your agents, skills, and integrations (config, metrics, trajectories) |
| `write` | create + update agents, skills, and integrations; rotate agent keys |
| `delete` | permanently delete agents, skills, and integrations |

The tiers are cumulative in destructiveness - **read < write (author) < delete
(destroy)** - and the split is along that axis and nothing else, so each spans all
three resources. `delete` is the one scope **excluded from `DEFAULT_SCOPES`**, so a
token minted for day-to-day agentic access can author freely but destroy nothing.

> **Why `delete` covers all three resources, not just agents.** An integration holds
> the write-only `secret`, which no endpoint can read back, so deleting one destroys a
> credential you must re-fetch from the downstream provider - *less* recoverable than
> deleting an agent, whose every config survives in `agent-versions`. Gating that on
> `write` would have let a default PAT pasted into a coding assistant wipe every skill
> and integration in the org.
>
> **The tiers bound blast radius, not recoverability.** `write` can still make things
> unrecoverable: it may overwrite an integration's `secret`, or replace a skill's content
> with different content - and skills have no version history, only agents do. So `write`
> means "may author, including destructively overwriting what it authors"; `delete` means
> "may remove the record itself", which additionally breaks every agent attached to it.
> Don't read `delete` as "the only scope that can lose data".

Each management route declares the scope it needs with `requireScope(...)`:

```ts
app.get("/agents", requireScope("read"), handler);
app.post("/agents", requireScope("write"), handler);
app.delete("/agents/:id", requireScope("delete"), handler);
app.delete("/skills/:id", requireScope("delete"), handler);
```

The one authority rule now lives in **`hasScope(principal, scope)`** (auth.ts) as a
plain membership test:

```ts
principal.scopes.includes(scope)
```

There is **no JWT bypass** anymore. A JWT principal carries its role's scopes, a PAT
carries (token scopes ∩ role scopes), and `hasScope` checks the resolved set for
both. A `viewer` (JWT or PAT) genuinely lacks `write`/`delete`, so `requireScope`
403s them. `requireScope` is a thin middleware over `hasScope`.

**Minting is also gated by role** (`POST /tokens` → 403): you can't stamp a token with
a scope your own role doesn't hold. The per-request intersection already makes such a
token *inert*, so this isn't closing an escalation - it closes a **dormant** one. A
viewer could otherwise mint a token carrying `delete`, and the day an admin promotes
them to editor that same token string would silently become able to destroy, with no
re-mint and no re-consent. Minting is the moment you consent to a capability, so that's
where it's checked.

Beyond the resource scopes, **`requireOrgRole("admin")`** gates the elevated
org-management surface (rename/delete org, manage members + invites). Those powers
are *not* expressible as a scope, so they can never be handed to a PAT - and the
same routes also carry `requireUser` (JWT-only). Note the distinction on the org
routes: they name the org in the *path*, so an extra `requireOrgRole` middleware
checks the caller's role **in the path org** (which may differ from the active-org
header) - a non-member gets 404, an insufficient role 403.

> **`DELETE /orgs/:id` cascades past the `delete` scope - deliberately.** It tears down
> every resource in the org (see docs/org-model.md) gated only by `requireUser` +
> `requireOrgRole("admin")`.
> Adding `requireScope("delete")` would be a BUG, not a fix: `principal.scopes` derive
> from the **active-org** header, so an admin of org-A whose active org is org-B would be
> refused deletion of their own org. Deleting an org is org-*management*, authorized by
> the admin role in the path org, and `requireUser` keeps it away from PATs - so the
> guarantee the `delete` scope gives ("a token pasted into a coding assistant destroys
> nothing") is unaffected.

## Personal Access Tokens

- **Minted** at `POST /tokens` with `{ name, scopes }`; the plaintext (`agpat_…`)
  is returned **once**. Only the hash is stored (`repo/tokens.ts`). The token is
  **bound to the caller's active org at mint time** (`record.orgId`) - it acts only
  in that org, whatever `X-Agency-Org` a request sends.
- **Effective authority** = the token's stored scopes ∩ the owner's *current* role
  in that org, recomputed every request. Minting can't over-grant in the first place
  (see the mint gate above), so what this intersection covers is what happens LATER:
  demoting or removing the owner immediately narrows or kills an already-minted token
  (a removed owner → `401`, a dead token).
- **Listed** at `GET /tokens` (metadata only, never the secret) and **revoked**
  at `DELETE /tokens/:id` (owner-scoped: you can only revoke your own).
- All three routes are guarded by **`requireUser`** - a PAT cannot manage tokens
  (mint more, or escalate its own scopes). Only an interactive login can. This is
  the key containment property: a leaked PAT is bounded by its scopes AND its role,
  in one org, and cannot bootstrap a wider one. (Read of `GET /me` + `GET /orgs/:id/members`
  spans the owner's other orgs - see the path-org note above.)
- The web app exposes this on the **Settings** page (create / copy-once / revoke).

## Extending - adding a new capability

1. Add the scope to `SCOPES` in `packages/shared/src/scopes.ts` (one line + a
   human description). `ALL_SCOPES` and the `Scope` type update automatically. Decide
   which **roles** grant it and add it to the right arms of `scopesForRole` (`org.ts`):
   a scope no role grants is not just dead but **un-mintable**, and the token-create UI
   won't list it (the picker offers only what your role can grant).
2. Guard the relevant route(s) with `requireScope("<new-scope>")`. For a power that
   should never reach a PAT (org/member management), gate with `requireOrgRole` instead
   of a scope.
3. If the scope is destructive or privileged, leave it OUT of `DEFAULT_SCOPES`
   (scopes.ts) so a token must opt into it (this is why `delete` is a separate scope,
   off by default in the token-create UI).
4. The OpenAPI `Scope` enum derives from `ALL_SCOPES` and the Settings toggle list
   from `scopesForRole`, so both update automatically.
5. If the capability is a new endpoint, register `app.use("/newpath", requireAuth)`
   alongside the others so the principal is populated before the scope check.

That's the whole surface: a scope constant, a `requireScope` on the route, and
(for a new endpoint) a `requireAuth` registration. Enforcement stays centralized
in auth.ts, and `routes-scope.test.ts` asserts each route carries the right scope
(so a dropped `requireScope` fails a test, not just the deployed E2E).

> **Scopes come from the role now.** A JWT no longer carries `[...ALL_SCOPES]` - it
> carries `scopesForRole(role)`, so a `viewer` genuinely lacks `write`/`delete`
> whether they hold a JWT or a PAT. To make a scope narrower for some callers, put
> it in fewer arms of `scopesForRole`; to make a power un-delegatable to PATs, gate
> it with `requireOrgRole` (not a scope) since only a JWT can hold the elevated role
> paths (they also carry `requireUser`).

## Threat notes

- **The `email` claim is an authority input.** It selects which pending invite a caller
  may accept, and accepting writes a membership under the caller's `sub` at the invited
  role - so a forgeable address is an org takeover at up to `admin`. Three independent
  layers hold it: the pre-token Lambda emits the claim only when `email_verified` is
  true; `authorizePayload` canonicalizes it once at the trust boundary; and the pool
  requires re-verification to change `email` while the web client can't write the
  attribute at all (see docs/deployment.md). Any one suffices - the app half
  deliberately doesn't depend on a Cognito default staying put.
- Tokens are hashed at rest; a DB read never yields a usable credential.
- A PAT's blast radius is its scopes ∩ its role, in one org (bar the path-org roster
  read noted above); it cannot touch token management, invite members, or manage an
  org. Losing membership kills it (401).
- Everything downstream is org-scoped by `principal.orgId` and further gated by the
  per-resource `canView`/`canWrite` rules, so a PAT (or JWT) only ever
  sees/mutates the shared resources in its active org plus the caller's own private
  ones - a co-member's private resource is invisible, and its shared resource is
  read-only to a non-creator editor unless the creator lists them as a manager.
- Membership + role are re-checked on every request, so revocation (removal or
  demotion) is immediate - there's no cached-authority window, and no write path can durably
  undo a removal (every membership write is conditional on the row still existing; see
  docs/org-model.md).
- Deferred: per-token rate limiting and expiry/rotation. Tokens are currently
  non-expiring until revoked (like a classic PAT); add TTL + a `lastUsedAt`-based
  staleness sweep when the surface warrants it.
