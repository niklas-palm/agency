# Integrations

An **integration** is a downstream API an agent can call - registered once, attached to
many agents (like a skill). The load-bearing property: **the agent never sees the
credential.** It calls a platform proxy that holds the secret, checks this agent is allowed
to use the integration, and forwards only to the configured base URL.

Four concerns, kept separate:

1. **Onboarding** - a user registers an API + credential (Integrations tab / `POST
   /integrations`). Org-scoped, reusable (shared with the org unless the creator opts out).
2. **Attachment** - an agent's `config.integrationIds` lists the integrations it may use
   (versioned config, like `skillIds`). Selectable per-agent in the UI.
3. **Discovery** - the agent learns *which* integrations + operations it CAN call. This
   rides the invoke payload as a manifest - no endpoint needed.
4. **Calling** - the agent invokes an operation by id; the proxy injects the credential and
   forwards to the base URL.

## The wire types (`packages/shared`)

```ts
type IntegrationAuth =
  | { kind: "none" }                       // public API / local test service
  | { kind: "bearer" }                     // static token: Authorization: Bearer <secret>
  | { kind: "apiKey"; header: string }     // static token: <header>: <secret>
  | { kind: "oauth2Client";                // OAuth2 client-credentials (m2m)
      tokenUrl: string; clientId: string;  //   proxy mints + caches a short-lived token
      scope?: string; audience?: string;   //   from tokenUrl using clientId + <secret>
      authStyle: "basic" | "body" };       //   (the client secret), injects it downstream

interface IntegrationOperation {
  operationId: string;   // stable id the agent names, e.g. "listPets"
  summary: string;       // one-line, model-facing
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;          // relative to baseUrl, may contain {param} placeholders
}

interface Integration {
  id; orgId; createdBy; shared;  // lives in one org; visible per the shared flag (see docs/auth.md)
  name; description;
  baseUrl;                       // the proxy forwards ONLY here
  auth: IntegrationAuth;         // NON-secret shape (how to apply the credential)
  operations: IntegrationOperation[];   // agent-facing manifest (enabled subset if discovered)
  discovery?: IntegrationDiscovery;      // present when auto-discovered from a spec URL
  hasSecret?; usedByAgentCount?; // secret itself is write-only, never returned
}
```

`IntegrationAuth` is a discriminated union on `kind` so a new mechanism (token exchange,
3-legged OAuth) slots in as a new member **without reshaping the agent-facing contract** -
the agent never sees auth; it just names an operation. **Pasting a raw bearer token is a
"static token"** (`bearer`/`apiKey`) - a real integration is usually `oauth2Client` (m2m) or
another preconfigured mechanism. The credential is the separate write-only `secret` on
`IntegrationInput` (a static token for `bearer`/`apiKey`, the *client secret* for
`oauth2Client`; set/rotate on write, never on any read; omit on update to keep the stored
value). The agent never sees the credential OR, for OAuth, the minted token.

An operation is *authored content*, like a skill doc: the platform (not generated code) is
the source of truth. It's authored two ways: **manually** (a hand-written `operations` list)
or by **auto-discovery** from a spec URL (see below). Either way a downstream API change is a
manifest edit (or a discovery refresh), never a code fix.

## Onboarding + attachment (control-plane)

CRUD lives at `/integrations` (`routes.ts`), org-scoped (`pk=orgId`, `sk=id`; see
`repo/integrations.ts`), gated by the `read` / `write` / `delete` scopes - integrations
are part of agent authoring, so they share the agents scopes rather than adding their own.
Deletion needs `delete` (it destroys the credential too - see docs/auth.md).
Each record carries `createdBy` + `shared` + an optional `managers?` list, so the
per-resource `canView`/`authorize` rules apply (see docs/auth.md): a listing returns the
org's shared integrations plus the caller's own private ones, and an editor can't edit a
co-member's shared integration (only its creator, an admin, or a listed manager can). Names are unique **per org** (agents reference them by name in
prompts, so a collision is ambiguous) and the check spans both shared and private records.
`toPublicIntegration` strips the secret on every read; `hasSecret` reports only whether one
is set. Editing an integration flows to every agent using it on the next run - content is
never copied into config. **`PATCH` is full-body** (re-parses the whole
`IntegrationInput` - `name`/`baseUrl`/`auth`/`operations`/`discovery`; a partial body is a
`400`), unlike the partial agent `PATCH` - because the credential-sink guard reasons over the
*complete* proposed record; only the write-only `secret` is optional (omit to keep it).

Attach by putting the id in `config.integrationIds` (create or `PATCH`). This is versioned:
attaching/detaching is a behavior change, so it bumps the agent version like `skillIds`.

## Auto-discovery of operations (`discover-operations.ts`)

Hand-authoring a manifest is tedious, so an integration can instead point at a **spec URL**
and have the platform materialize the operations. `IntegrationInput.discovery = { url,
enabledOperationIds? }`:

- **On create/update**, the control-plane fetches + parses the spec and stores an
  `IntegrationDiscovery` block: `{ url, provider, syncedAt, operations }` where each
  discovered op carries an `enabled` flag. The integration's top-level `operations` is the
  **materialized enabled subset** - so the runtime + proxy never need to know discovery
  exists (they see a normal manifest).
- **Selection.** Omit `enabledOperationIds` to enable ALL discovered ops (the "all-selected
  by default, then deselect" UX); send an array to enable exactly those. The web editor
  fetches a stateless preview (`POST /integrations/discover`) to render a searchable,
  select-all/none checklist, then sends the survivors.
- **Refresh + selection memory.** `POST /integrations/:id/refresh` (and a **daily
  EventBridge sweep** → `discovery-sweep-lambda.ts`, over every discovery-backed integration)
  re-fetches and **reconciles against the stored selection**: a still-present op keeps its
  `enabled` flag, a **newly-appeared op defaults OFF**, a removed op drops. So an evolving
  upstream API never silently grants the agent a new capability. A same-URL save re-selects
  against the cached catalog without a network fetch (a name edit or a toggle shouldn't hit,
  or be blocked by, the spec host).
- **A refresh can't clobber a concurrent edit.** Both refresh paths are read → *slow spec
  fetch* → write, so the window between the read and the write is a network round-trip wide.
  They persist through `updateDiscoveryResult`, an `UpdateItem` touching ONLY the three fields
  discovery owns (`operations`, `discovery`, `updatedAt`) - never a whole-item `Put`, which
  (built from the stale read) would silently revert a user PATCH that landed meanwhile,
  including `secret`, `shared`, `managers`, and `baseUrl`. Worst case there was the secret
  rollback: the proxy would keep sending a credential the user believed they had rotated away.
  The write is also **conditional on `discovery.url`** being the one that was fetched, so a
  refresh whose integration was re-pointed at a different spec (or switched to manual
  authoring) is dropped rather than applied - else it would grant operations from an upstream
  the user no longer asked for. The route answers **409**; the sweep counts it `superseded`.

**The provider seam.** `DiscoveryProvider` (`kind` + `parse(doc)`) is tried in registry
order until one recognizes the document, so new formats (GraphQL introspection, MCP
tool-listing) are a new entry in `PROVIDERS`, nothing else. We ship **OpenAPI (JSON)** first.
Every discovered candidate must pass the same `parseOperation` gate as a hand-authored op
(no traversal path, valid method), so a hostile spec can't smuggle a bad operation. The spec
URL is fetched through the shared **SSRF anchor** (`guardedFetch`, `outbound.ts`) - the same
guard as `baseUrl` and the OAuth `tokenUrl`.

**Spec fetch: try unauthenticated first, then authenticate.** A spec URL may be public (common,
even when the API itself is gated) or behind the same credential as the API. Rather than force a
choice, discovery **tries the bare fetch first and only retries with the credential if that fails**
(transport error, non-2xx like 401/403, or an unrecognized body). So a public spec needs no
credential at all - even on an integration that *has* one - and the write-only secret leaves only
when the endpoint actually demands it, never speculatively. The authenticated retry uses the shared
`credentialHeaders` (`integration-proxy.ts`) - the exact same header the proxy injects downstream
(bearer/apiKey static token, or a freshly-minted OAuth2 token). The stateless preview (`POST
/integrations/discover`) takes the entered `auth` + `secret` + `baseUrl` (or an `integrationId` to
reuse a stored secret when editing); create/PATCH use the effective secret (just-entered, else
stored); refresh + the sweep use the record's stored credential. (A public spec on a *different*
origin than `baseUrl` still works - the credential just isn't attached there; an auth-gated spec on
a different origin is the one unsupported case, by the exfil guard below.)

**Same-origin anchor (the exfil guard).** The credential is write-only and the spec URL is
caller-supplied, so it is attached **only when the spec URL's origin matches the integration's
`baseUrl` origin** (`credentialForSpec`, shared by create/PATCH, the preview, refresh, AND the
daily sweep, mirroring the proxy's `isUnderBase`); an off-base spec is fetched unauthenticated.
Without this, an `write` holder could point `discovery.url` at their own host and read
the injected secret out of the outbound header without ever knowing its value. Paths that reuse
a *stored* secret anchor to the *stored* record's `baseUrl` (unspoofable).

**The credential-sink mutation guard (the root fix).** The anchor trusts the credential's
*sink* URLs as legitimate - but they're caller-supplied on PATCH while the write-only secret is
preserved when omitted. So **changing the origin of any credential sink while keeping the stored
secret is rejected** (`PATCH` requires re-entering the credential, which proves the caller holds
it - someone who only knows `hasSecret` can't). The sinks (`credentialSinkOrigins`): `baseUrl`
(where bearer/apiKey ride the proxy forward + the discovery fetch) and, for `oauth2Client`, the
`tokenUrl` the client secret is POSTed to when minting. This closes the exfil at its source for
every sink: the proxy forward (`forwardCall` composes from the mutable `record.baseUrl` + injects
`record.secret`), the discovery fetch, and the OAuth mint. Within an unchanged origin, the URL
paths stay freely editable.

Additionally, because a spec URL isn't pinned to one origin like a proxy call, `guardedFetch`
**strips credential-bearing headers on a cross-origin redirect** (`Authorization`/`Cookie`
always, plus a named custom `apiKey` header) and **refuses** a cross-origin hop when the
credential is in the request body - a spec/token host that 302s elsewhere can't harvest it.

## Discovery (the manifest rides the payload)

> "Just because it can send a request doesn't mean it knows what requests it CAN send."

At invoke, the control-plane resolves `config.integrationIds` → `ResolvedIntegration[]`
(id + name + description + operations, **never the credential or even the baseUrl**) and
puts it in the invoke payload as `payload.integrations` - server-authoritative, exactly like
resolved skills (`resolveIntegrations` in `routes.ts`). The runtime surfaces it to the model
two ways:

- The system prompt names the attached integrations (`integrationsPrompt`, composed in
  `packages/shared/src/prompt.ts`) so the model knows they exist.
- The `list_integration_operations` tool returns the full manifest (integration id + name +
  description + each operation's id/summary/method/path) with **no network call** - it just
  reflects the payload.

So discovery needs no HTTP endpoint: the runtime already holds the manifest.

## Calling (the proxy)

The runtime's `call_integration` tool (`apps/agent-runtime/src/integration-tools.ts`) POSTs
to the control-plane proxy at **`POST /internal/integrations/call`** - the *only* endpoint
the proxy exposes. Body (`IntegrationCallRequest`): `agentId`, `sessionId`, `integrationId`,
`operationId`, optional `pathParams` / `query` / `body`. **Parameters are open per call**
(the manifest fixes *which* operation, not its args), so an agent pages a listing by calling
the same operation with a different `query` (`?page=2`, `?cursor=…`) or `pathParams`.

**Get-data-then-compute (`outputPath`).** By default the downstream body is returned into the
model's context (capped at 256 KiB to protect the context window). But a code agent usually
wants to *compute* over fetched data, not read it - so `call_integration` takes an optional
`outputPath`: a workspace-relative file the runtime writes the body to **instead of** returning
it, handing back a receipt `{ status, path, bytes }`. The agent then processes the file with its
own tools - far cheaper and more reliable than re-typing data through the context. When
`outputPath` is set the runtime sends `largeResponse: true`, and the proxy uses a larger **2.5 MiB**
cap - bounded so the JSON-escaped reply stays under the Lambda/API-Gateway ~6 MB response ceiling
(a body ~2x once escaped); it's a buffered reply, not a stream. A body that hits the
cap comes back `truncated: true`, and the receipt tells the agent to page rather than compute on
partial data; a non-success downstream status is flagged in the receipt too (don't parse an error
body as data). The path is confined to the workspace by the same `sandboxed()` guard as
`write_file` (no absolute paths, no `..`, not the root itself), validated *before* the network
call, and a proxy error never writes a file. Paging + `outputPath` compose: one file per page
(`data/page-1.json`, …), then one `run_bash` pass over all of them.

Authentication reuses the **per-session capability token** already minted for telemetry
ingest (no second mechanism): the token is scoped to `(orgId, agentCreatedBy, agentId,
sessionId)` and carries the granted `integrationIds`, sent as the `X-Agency-Ingest-Token`
header (via `postIngestRaw` in `ingest.ts`). The proxy route (`routes.ts`):

1. Verifies the token (signature + expiry + claims match the posted `agentId`/`sessionId`).
2. Checks `integrationId` is in the token's granted set → else **403**.
3. Loads the record scoped to the token's `orgId` (org-isolated) → **404** if since-deleted.
4. Re-checks the record is still **visible to the agent's creator** (`agentCreatedBy` from
   the token: `shared` or created by them) → else **403**, so un-sharing an integration
   after attach degrades gracefully (the agent's other integrations keep working). There's
   no principal on this hot path, so visibility is judged against the agent's creator, not a
   live caller.
5. Hands off to `forwardCall` (`integration-proxy.ts`).

`forwardCall` composes the outbound URL from the stored `baseUrl` + the operation's declared
`path` (placeholders filled from `pathParams`, URL-encoded), injects the credential per the
auth kind, forwards, and returns the downstream status + a size-capped text body. For
`oauth2Client`, `credentialHeaders` is async: it gets a token from `oauth-token.ts`, which mints
one from `tokenUrl` (client-credentials grant, `basic` or `body` style) and **caches it in
the warm process until near expiry** (skew-adjusted; a mint failure comes back as an
`{ error, hint }`, never an unauthenticated call). The calling agent's id is forwarded as a
NON-secret `X-Agency-Agent-Id` header (provenance for a downstream that attributes by caller;
m2m tokens are per-client, not per-agent, so this doesn't ride the credential). **SSRF
anchor:** the composed URL is re-parsed and asserted to stay under the base's origin *and*
path prefix, and path params can't smuggle a `/` or `..` - so a compromised agent can't aim
the proxy at an arbitrary host. Redirects are followed **manually**, re-validating that each
hop stays under the base URL (`fetch`'s own `redirect:"follow"` would jump to a `3xx` Location
without re-checking - and replay a custom `apiKey` header off-base, since undici doesn't strip
it cross-origin); an off-base redirect is refused. There's a 10s request deadline, a
256 KiB response cap (read as a bounded stream, never buffered whole), and at most 3 on-base
redirect hops. Registration also rejects a `baseUrl` pointing at `localhost` or a literal
private/loopback/link-local/metadata IP (`normalizeBaseUrl`), since the proxy runs in platform
infrastructure with platform network position.

Tools never throw: a 4xx from the proxy (unknown operation, bad params, not authorized) or a
transport failure comes back to the model as `{ error, hint }` so it can adapt.

**Works in every network mode.** The isolated (no-egress) runtime reaches the control-plane
over the same PrivateLink path it uses for telemetry ingest, so integrations are *not*
disabled by isolation - the egress is the platform proxy, not the open internet.

## Blast radius

- The runtime role has **no DynamoDB access** and holds **no long-lived secret** - only the
  minting (control-plane / trigger) and verifying (IngestFn) Lambdas hold the signing key.
- `IngestFn` is granted **read-only** on the integrations table (it resolves the record to
  forward); it can never write one. The secret leaves only via the outbound forward.
- A token leaked from a microVM calls only *its own* session's granted integrations, in its
  org and still visible to the agent's creator - it can't enumerate or reach another org's.

See `docs/runtime.md` (the tools), `docs/control-plane.md` (the proxy route + ingest auth),
and docs/runtime.md (the token design).

## The sample API (demo + E2E target)

`apps/sample-api` is a tiny pet-store Hono app used to prove the whole path end-to-end. It's
its **own removable stack** (`infra/lib/sample-api-stack.ts`, `cdk destroy AgencySampleApi`)
so it never entangles the platform; locally it's the `sample-api` docker-compose service on
port 8686. A bearer token gates it (`SAMPLE_API_TOKEN`; Secrets Manager in prod,
`local-sample-token` locally) - that token is exactly what a user registers as the
integration credential, so the proxy injects it and the agent calls the API without ever
seeing it. Operations:

```
GET  /pets           listPets
POST /pets           createPet   { name, kind }
GET  /pets/{id}      getPet
GET  /openapi.json   its own OpenAPI spec (behind the SAME bearer gate)
```

The local E2E (`scripts/e2e.ts`, `RUN_INTEGRATION=1`) has three round-trips: the
`integrationRoundTrip` registers this with a hand-authored manifest and asserts the agent
lists + creates a pet through the proxy; the `discoveryRoundTrip` points at the bearer-gated
`/openapi.json` and asserts the whole auto-discovery path - proving the spec fetch
**authenticates with the integration credential** (an unauthenticated fetch 401s), that a
selected subset materializes correctly, and that a refresh preserves the selection. The
`dataToDiskRoundTrip` exercises `outputPath`: the agent writes a response to a workspace file
and computes over it with `run_bash`, instead of pulling the data into context.

Only the discovery round-trip needs a **deployed** target: the spec URL must be https (it
carries a credential), and the local sample API is plain http - so it skips locally and runs
against the deployed sample API.

## Adding a new auth mechanism later

The contract is built for this - `oauth2Client` was added exactly this way, and the same
four steps add token-exchange or 3-legged OAuth:

1. A new member of `IntegrationAuth` in `packages/shared` (its non-secret fields).
2. A `parseIntegrationBody` branch validating it (`integration-validation.ts`).
3. A branch in `credentialHeaders` (`integration-proxy.ts`) that turns the stored secret (+ any
   token-mint/exchange step) into the outbound header. `credentialHeaders` is already async and any
   outbound call to a provider goes through `guardedFetch` (`outbound.ts`, the shared SSRF
   anchor) - see `oauth-token.ts` for the mint+cache pattern to copy.
4. An option in the UI auth selector (`apps/web/src/views/Integrations.tsx`).

The agent-facing surface - discovery + `call_integration` - never changes.

## Adding a new discovery provider later

Auto-discovery has its own seam (`discover-operations.ts`): implement a `DiscoveryProvider`
(`kind` + `parse(doc) → RawOperation[] | null`, returning null when it doesn't recognize the
document) and add it to the `PROVIDERS` registry. Providers are tried in order, and every
candidate is gated by the shared `parseOperation`, so a provider only extracts shape. Today:
OpenAPI (JSON). Candidates: GraphQL introspection, MCP tool-listing, YAML OpenAPI.
