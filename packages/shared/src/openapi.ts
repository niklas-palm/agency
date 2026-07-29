/**
 * The Agency public API described as an OpenAPI 3.1 document.
 *
 * This lives beside the wire types it documents (same package) so the two stay
 * in sync - when a shape here drifts from `index.ts`, it's one file over. The
 * control-plane serves it at `GET /openapi.json`; point a code assistant or an
 * SDK generator at that URL and it can write a correct client in any language.
 *
 * Hand-authored (not code-generated): the surface is small, and a readable spec
 * beats a build-time codegen dependency for something this size. The schemas
 * mirror the exported types in `index.ts` - keep them aligned.
 */
import { MODEL_KEYS } from "./models.js";
import { ALL_SCOPES } from "./scopes.js";
import { ALL_ROLES } from "./org.js";
import { TRAJECTORY_EVENT_TYPES } from "./trajectory-types.js";

/** Build the spec with a concrete server URL (the deployed API origin). */
export function buildOpenApiSpec(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Agency API",
      version: "1.0.0",
      description:
        "Create agents and run them from your own code. Management endpoints " +
        "(create/list/update/delete) use your account bearer token; the invoke " +
        "and poll endpoints use the agent's own API key, so you can trigger one " +
        "agent without account credentials. Agents run asynchronously: invoking " +
        "returns a session id immediately, and you poll that session for the " +
        "trajectory of events until it goes idle.\n\n" +
        "**Organizations.** Every resource lives in an org. Send the active org on " +
        "each management call with the `X-Agency-Org: <orgId>` header (validated " +
        "against your membership; omit it to use your personal org). Your role in " +
        "the active org (admin/editor/viewer) governs what you can do, and each " +
        "resource carries a `shared` flag: shared resources are visible to the whole " +
        "org, private ones only to their creator.",
    },
    servers: [{ url: serverUrl }],
    tags: [
      { name: "Agents", description: "Manage agents (account token)." },
      { name: "Run", description: "Trigger and observe an agent (agent API key)." },
      { name: "Tokens", description: "Personal Access Tokens for programmatic access (interactive login only)." },
      { name: "Skills", description: "Reusable instruction docs attachable to agents." },
      { name: "Integrations", description: "Downstream APIs attachable to agents; the agent calls them via a platform proxy that holds the credential." },
      { name: "Orgs", description: "Organizations, members, and invites. The X-Agency-Org header selects the active org." },
    ],
    // Two auth schemes: the account JWT for management, the per-agent API key
    // (an `ag_…` bearer) for invoke/poll. Both are HTTP bearer tokens on the wire.
    security: [],
    paths: {
      "/agents": {
        parameters: [ORG_HEADER_PARAM],
        post: {
          tags: ["Agents"],
          summary: "Create an agent",
          description: "Returns the agent and its API key. The key is shown exactly once.",
          security: [{ accountToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("AgentConfigInput") } } },
          responses: {
            "201": jsonResponse("Created.", "CreateAgentResponse"),
            "400": jsonResponse("Invalid config - `details` lists each bad field.", "ValidationError"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
          },
        },
        get: {
          tags: ["Agents"],
          summary: "List your agents",
          security: [{ accountToken: [] }],
          responses: { "200": jsonResponse("Your agents.", "AgentList"), "401": UNAUTHORIZED, "403": FORBIDDEN },
        },
      },
      "/agents/{id}": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Agent id.")],
        get: {
          tags: ["Agents"],
          summary: "Get an agent",
          security: [{ accountToken: [] }],
          responses: {
            "200": jsonResponse("The agent.", "AgentEnvelope"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
          },
        },
        patch: {
          tags: ["Agents"],
          summary: "Update an agent",
          description: "Partial config. Most fields take effect on the agent's next run - no redeploy.",
          security: [{ accountToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("AgentConfigPatch") } } },
          responses: {
            "200": jsonResponse("The updated agent.", "AgentEnvelope"),
            "400": jsonResponse("Invalid config - `details` lists each bad field.", "ValidationError"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
            "503": CONFLICT_RETRY,
          },
        },
        delete: {
          tags: ["Agents"],
          summary: "Delete an agent",
          description: `Tears down the agent's schedule and record. ${DELETE_SCOPE_NOTE}`,
          security: [{ accountToken: [] }],
          responses: {
            "204": { description: "Deleted." },
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
          },
        },
      },
      "/agents/{id}/rotate-key": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Agent id.")],
        post: {
          tags: ["Agents"],
          summary: "Rotate the agent's API key",
          description:
            "Invalidates the old key and returns a new one. The new key is also stored, so it stays " +
            "readable to anyone who can write the agent.",
          security: [{ accountToken: [] }],
          responses: {
            "200": jsonResponse("The new API key.", "RotateKeyResponse"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
          },
        },
      },
      "/agents/{id}/slack": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Agent id.")],
        get: {
          tags: ["Agents"],
          summary: "Slack setup state",
          description:
            "Where the agent's Slack setup has got to, plus the app manifest to paste into " +
            "Slack's from-a-manifest flow. The manifest already carries the scopes, the event " +
            "subscription and this agent's webhook URL, so nothing needs configuring afterwards. " +
            "Never returns a credential.",
          security: [{ accountToken: [] }],
          responses: {
            "200": jsonResponse("The setup state and manifest.", "SlackSetupResponse"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("No Slack trigger on this agent.", "Error"),
          },
        },
      },
      "/agents/{id}/slack/credentials": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Agent id.")],
        patch: {
          tags: ["Agents"],
          summary: "Store the Slack credentials",
          description:
            "Stores the bot token + signing secret (write-only, never returned) and verifies " +
            "them with Slack's auth.test before saving - so a token that doesn't work is never " +
            "recorded as connected. The response reports which workspace was connected and " +
            "which scopes Slack actually granted.",
          security: [{ accountToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("SlackCredentialsInput") } } },
          responses: {
            "200": jsonResponse("The verified workspace.", "SlackCredentialsResponse"),
            "400": jsonResponse("Slack rejected the token, or a field is missing.", "Error"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("No Slack trigger on this agent.", "Error"),
          },
        },
      },
      "/agents/{id}/slack/channels": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Agent id.")],
        patch: {
          tags: ["Agents"],
          summary: "Set the Slack channel allowlist",
          description:
            "Replaces the list of channels the agent may answer in. Each id is validated " +
            "against the CONNECTED workspace first: channel ids are workspace-scoped, and an id " +
            "from another workspace would leave an agent that looks configured but silently " +
            "ignores every mention. An empty list means the agent answers nowhere.",
          security: [{ accountToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("SlackChannelsInput") } } },
          responses: {
            "200": jsonResponse("The resolved channels.", "SlackChannelsResponse"),
            "400": jsonResponse("A channel id is invalid or in another workspace.", "Error"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "409": jsonResponse("Slack isn't connected yet.", "Error"),
          },
        },
      },
      "/agents/{id}/versions": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Agent id.")],
        get: {
          tags: ["Agents"],
          summary: "List config versions",
          description: "Every config change appends a version; newest first. The latest is live.",
          security: [{ accountToken: [] }],
          responses: {
            "200": jsonResponse("The version history.", "VersionsResponse"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
          },
        },
      },
      "/agents/{id}/versions/{version}/restore": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Agent id."), pathParam("version", "Version number to restore.")],
        post: {
          tags: ["Agents"],
          summary: "Restore a config version",
          description: "Appends the target version's config as a new version (history stays linear).",
          security: [{ accountToken: [] }],
          responses: {
            "200": jsonResponse("The updated agent.", "AgentEnvelope"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
            "503": CONFLICT_RETRY,
          },
        },
      },
      "/agents/{id}/runs": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Agent id.")],
        get: {
          tags: ["Agents"],
          summary: "List past runs",
          description:
            "The agent's runs, newest first - one entry per runtime lifetime (a microVM lives up " +
            "to 8h across many triggers). Read from durable summary rows, so this covers runs far " +
            "older than a trajectory's 30-day retention.",
          security: [{ accountToken: [] }],
          parameters: [
            {
              name: "limit",
              in: "query",
              required: false,
              description: "Runs to return (default 50, max 200).",
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": jsonResponse("The agent's recent runs.", "AgentRunsResponse"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
          },
        },
      },
      "/agents/{id}/runs/{runId}": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Agent id."), pathParam("runId", "Run id from the run list.")],
        get: {
          tags: ["Agents"],
          summary: "Get a past run's trajectory",
          description:
            "The run's full event list, addressed by `runId` (NOT `sessionId`, which a caller may " +
            "reuse across runs). Served from live storage while the run is recent and from the " +
            "archive afterwards; `archived` says which. A run older than the 30-day retention that " +
            "was never archived returns an empty `events` with `archived: false`.",
          security: [{ accountToken: [] }],
          responses: {
            "200": jsonResponse("The run's trajectory.", "AgentRunTrace"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
            // A transient archive-storage failure is retryable, and deliberately NOT
            // reported as "the steps are gone" - so a generated client must retry.
            "503": CONFLICT_RETRY,
          },
        },
      },
      "/agents/{id}/metrics": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Agent id.")],
        get: {
          tags: ["Agents"],
          summary: "Operational metrics",
          description:
            "Aggregated metrics over a window. Granularity is hourly for windows up to 7 days, " +
            "daily above. Sessions count runtime lifetimes.",
          security: [{ accountToken: [] }],
          parameters: [
            {
              name: "hours",
              in: "query",
              required: false,
              description: "Window size in hours (default 24, max 8760).",
              schema: { type: "integer" },
            },
            {
              name: "version",
              in: "query",
              required: false,
              description: "Scope to one config version (omit for across all versions).",
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": jsonResponse("Aggregated metrics.", "MetricsSummary"),
            // A non-numeric `?version=` is rejected rather than coerced to NaN, which
            // would match no session and render a confident all-zeros dashboard.
            "400": jsonResponse("`version` must be an integer.", "Error"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
          },
        },
      },
      "/skills": {
        parameters: [ORG_HEADER_PARAM],
        post: {
          tags: ["Skills"],
          summary: "Create a skill",
          description: "A reusable Markdown instruction doc attachable to agents by id.",
          security: [{ accountToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("SkillInput") } } },
          responses: {
            "201": jsonResponse("Created.", "SkillEnvelope"),
            "400": jsonResponse("Invalid SKILL.md - `details` lists each problem.", "ValidationError"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "409": jsonResponse("Name already in use.", "Error"),
          },
        },
        get: {
          tags: ["Skills"],
          summary: "List your skills",
          description: "Each includes `usedByAgentCount`.",
          security: [{ accountToken: [] }],
          responses: { "200": jsonResponse("Your skills.", "SkillsResponse"), "401": UNAUTHORIZED, "403": FORBIDDEN },
        },
      },
      "/skills/{id}": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Skill id.")],
        get: {
          tags: ["Skills"],
          summary: "Get a skill",
          security: [{ accountToken: [] }],
          responses: {
            "200": jsonResponse("The skill.", "SkillEnvelope"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
          },
        },
        patch: {
          tags: ["Skills"],
          summary: "Update a skill",
          description: "Editing a skill updates every agent that uses it, on their next run.",
          security: [{ accountToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("SkillInput") } } },
          responses: {
            "200": jsonResponse("The updated skill.", "SkillEnvelope"),
            "400": jsonResponse("Invalid SKILL.md - `details` lists each problem.", "ValidationError"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
            "409": jsonResponse("Name already in use.", "Error"),
          },
        },
        delete: {
          tags: ["Skills"],
          summary: "Delete a skill",
          description: DELETE_SCOPE_NOTE,
          security: [{ accountToken: [] }],
          responses: {
            "204": { description: "Deleted." },
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
          },
        },
      },
      "/integrations": {
        parameters: [ORG_HEADER_PARAM],
        post: {
          tags: ["Integrations"],
          summary: "Create an integration",
          description:
            "Onboard a downstream API: its base URL, auth mechanism, credential (write-only), " +
            "and an operation manifest. Attach it to agents by id; the agent calls it via the proxy.",
          security: [{ accountToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("IntegrationInput") } } },
          responses: {
            "201": jsonResponse("Created.", "IntegrationEnvelope"),
            "400": jsonResponse("Invalid integration - `details` lists each bad field.", "ValidationError"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "409": jsonResponse("Name already in use.", "Error"),
          },
        },
        get: {
          tags: ["Integrations"],
          summary: "List your integrations",
          description: "Each includes `usedByAgentCount` and `hasSecret` (never the secret).",
          security: [{ accountToken: [] }],
          responses: { "200": jsonResponse("Your integrations.", "IntegrationsResponse"), "401": UNAUTHORIZED, "403": FORBIDDEN },
        },
      },
      "/integrations/{id}": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Integration id.")],
        get: {
          tags: ["Integrations"],
          summary: "Get an integration",
          security: [{ accountToken: [] }],
          responses: {
            "200": jsonResponse("The integration.", "IntegrationEnvelope"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
          },
        },
        patch: {
          tags: ["Integrations"],
          summary: "Update an integration",
          description:
            "Full-body update (send the complete integration, not just changed fields - a " +
            "partial body is rejected). Editing an integration updates every agent that uses " +
            "it, on their next run. Omit `secret` to leave the stored credential unchanged.",
          security: [{ accountToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("IntegrationInput") } } },
          responses: {
            "200": jsonResponse("The updated integration.", "IntegrationEnvelope"),
            "400": jsonResponse("Invalid integration - `details` lists each bad field.", "ValidationError"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
            "409": jsonResponse("Name already in use.", "Error"),
          },
        },
        delete: {
          tags: ["Integrations"],
          summary: "Delete an integration",
          description: `${DELETE_SCOPE_NOTE} This removes the stored credential with the record; no endpoint can read one back, so you'd re-fetch it from the provider.`,
          security: [{ accountToken: [] }],
          responses: {
            "204": { description: "Deleted." },
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
          },
        },
      },
      "/integrations/{id}/refresh": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Integration id.")],
        post: {
          tags: ["Integrations"],
          summary: "Refresh a discovered integration's operations",
          description:
            "Re-fetch the integration's discovery spec and reconcile against the stored selection: " +
            "kept-enabled operations stay enabled, a newly-appeared operation defaults to disabled " +
            "(so an evolving API never silently grants a new capability), and a removed one drops. " +
            "Only valid for integrations created with a discovery URL. A daily sweep does this automatically.",
          security: [{ accountToken: [] }],
          responses: {
            "200": jsonResponse("The refreshed integration.", "IntegrationEnvelope"),
            "400": jsonResponse("Not a discovery-backed integration.", "Error"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not found.", "Error"),
            "409": jsonResponse(
              "The integration's discovery URL changed while refreshing, so the fetched " +
                "operations describe a spec it no longer points at. Reload and retry.",
              "Error",
            ),
            "502": jsonResponse("The spec could not be fetched or parsed.", "Error"),
          },
        },
      },
      "/integrations/discover": {
        parameters: [ORG_HEADER_PARAM],
        post: {
          tags: ["Integrations"],
          summary: "Preview operations from a discovery spec URL",
          description:
            "Fetch + parse a spec URL (e.g. an OpenAPI JSON document) WITHOUT saving anything, and " +
            "return the full operation catalog (all enabled) so a UI can render a pick-a-subset view " +
            "before creating the integration. The spec is often gated by the integration's own " +
            "credential, so pass `auth` (+ `secret`, or `integrationId` to reuse a stored secret when " +
            "editing) + `baseUrl` to authenticate the fetch. The credential is attached ONLY when the " +
            "spec URL is under `baseUrl`'s origin (the write-only secret can't be aimed at an arbitrary " +
            "host); an off-base spec is fetched unauthenticated. Nearly stateless (only reads the stored secret).",
          security: [{ accountToken: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["url"],
                  properties: {
                    url: { type: "string", description: "The spec URL to fetch (https only - it carries the credential; SSRF-guarded)." },
                    auth: { ...ref("IntegrationAuth"), description: "Optional: authenticate the fetch as the proxy would a downstream call." },
                    secret: { type: "string", description: "Optional credential for `auth` (write-only)." },
                    baseUrl: { type: "string", description: "The integration's base URL; the credential is attached only if the spec URL is under its origin." },
                    integrationId: { type: "string", description: "Optional: reuse this integration's STORED secret when `secret` is omitted (editing). When reused, the stored record's own `auth` + `baseUrl` are used (the request-body `auth`/`tokenUrl` is ignored) so the credential can't be redirected off its registered sink." },
                  },
                },
              },
            },
          },
          responses: {
            "200": jsonResponse("The discovered catalog.", "DiscoverResponse"),
            "400": jsonResponse("Invalid URL.", "Error"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "502": jsonResponse("The spec could not be fetched or parsed.", "Error"),
          },
        },
      },
      "/tokens": {
        parameters: [ORG_HEADER_PARAM],
        post: {
          tags: ["Tokens"],
          summary: "Create a Personal Access Token",
          description:
            "Mint a scoped token for programmatic access. The plaintext token is returned " +
            "once. Requires an interactive login (a PAT cannot mint tokens). You can only " +
            "grant scopes your own role holds - a viewer can't mint a `write` token.",
          security: [{ accountToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("CreateAccessTokenRequest") } } },
          responses: {
            "201": jsonResponse("Created; token shown once.", "CreateAccessTokenResponse"),
            "400": jsonResponse("Invalid name or scopes.", "Error"),
            "401": UNAUTHORIZED,
            "403": jsonResponse("A PAT cannot manage tokens, or your role can't grant a requested scope.", "Error"),
          },
        },
        get: {
          tags: ["Tokens"],
          summary: "List your Personal Access Tokens",
          description: "Never returns the secret - only metadata. Requires an interactive login.",
          security: [{ accountToken: [] }],
          responses: {
            "200": jsonResponse("Your tokens.", "AccessTokenList"),
            "401": UNAUTHORIZED,
            "403": jsonResponse("A PAT cannot manage tokens.", "Error"),
          },
        },
      },
      "/tokens/{id}": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Token id.")],
        delete: {
          tags: ["Tokens"],
          summary: "Revoke a Personal Access Token",
          description: "Requires an interactive login.",
          security: [{ accountToken: [] }],
          responses: {
            "204": { description: "Revoked." },
            "401": UNAUTHORIZED,
            "403": jsonResponse("A PAT cannot manage tokens.", "Error"),
            "404": jsonResponse("Not found.", "Error"),
          },
        },
      },
      "/me": {
        parameters: [ORG_HEADER_PARAM],
        get: {
          tags: ["Orgs"],
          summary: "Identity + org memberships + active org",
          description:
            "Bootstrap the client: who you are, the orgs you belong to (with your role in each), " +
            "and which org this request resolved as active (set via the `X-Agency-Org` header, else " +
            "your personal org). Creates your personal org on first call.",
          security: [{ accountToken: [] }],
          responses: { "200": jsonResponse("Your identity + orgs.", "Me"), "401": UNAUTHORIZED, "403": FORBIDDEN },
        },
      },
      "/orgs": {
        parameters: [ORG_HEADER_PARAM],
        post: {
          tags: ["Orgs"],
          summary: "Create a team organization",
          description: "The creator becomes the org's admin. Requires an interactive login.",
          security: [{ accountToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("CreateOrgRequest") } } },
          responses: {
            "201": jsonResponse("Created.", "OrgEnvelope"),
            "400": jsonResponse("Invalid name.", "Error"),
            "401": UNAUTHORIZED,
            "403": jsonResponse("Requires an interactive login.", "Error"),
          },
        },
      },
      "/orgs/{id}": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Org id.")],
        patch: {
          tags: ["Orgs"],
          summary: "Rename an organization",
          description: "Admin + interactive login only.",
          security: [{ accountToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("CreateOrgRequest") } } },
          responses: {
            "200": jsonResponse("Updated.", "OrgEnvelope"),
            "400": jsonResponse("Invalid name.", "Error"),
            "401": UNAUTHORIZED,
            "403": jsonResponse("Requires the admin role.", "Error"),
            "404": jsonResponse("Not found / not a member.", "Error"),
          },
        },
        delete: {
          tags: ["Orgs"],
          summary: "Delete a team organization (+ cascade)",
          description:
            "Tears down the org's agents (+ schedules), skills, integrations, memberships, and invites. " +
            "A personal org can't be deleted. Admin + interactive login only.",
          security: [{ accountToken: [] }],
          responses: {
            "204": { description: "Deleted." },
            "400": jsonResponse("A personal org can't be deleted.", "Error"),
            "401": UNAUTHORIZED,
            "403": jsonResponse("Requires the admin role.", "Error"),
            "404": jsonResponse("Not found / not a member.", "Error"),
          },
        },
      },
      "/orgs/{id}/members": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Org id.")],
        get: {
          tags: ["Orgs"],
          summary: "List members of an org",
          description:
            "Any member of the org can list its members (requires the `read` scope). " +
            "Authorized against your role in the org named in the PATH, so this reads any org " +
            "you belong to - not only the one a Personal Access Token is bound to.",
          security: [{ accountToken: [] }],
          responses: {
            "200": jsonResponse("The org's members.", "MembersResponse"),
            "401": UNAUTHORIZED,
            "403": FORBIDDEN,
            "404": jsonResponse("Not a member.", "Error"),
          },
        },
      },
      "/orgs/{id}/members/{userId}": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Org id."), pathParam("userId", "Member user id.")],
        patch: {
          tags: ["Orgs"],
          summary: "Change a member's role",
          description: "Admin + interactive login. Can't demote the last admin.",
          security: [{ accountToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("UpdateMemberRequest") } } },
          responses: {
            "200": jsonResponse("The updated member.", "MemberEnvelope"),
            "400": jsonResponse("Invalid role / would remove the last admin.", "Error"),
            "401": UNAUTHORIZED,
            "403": jsonResponse("Requires the admin role.", "Error"),
            "404": jsonResponse("Not a member.", "Error"),
            "409": ADMINS_CHANGED,
          },
        },
        delete: {
          tags: ["Orgs"],
          summary: "Remove a member",
          description: "Admin + interactive login. Can't remove the last admin.",
          security: [{ accountToken: [] }],
          responses: {
            "204": { description: "Removed." },
            "400": jsonResponse("Would remove the last admin.", "Error"),
            "401": UNAUTHORIZED,
            "403": jsonResponse("Requires the admin role.", "Error"),
            "404": jsonResponse("Not a member.", "Error"),
            "409": ADMINS_CHANGED,
          },
        },
      },
      "/orgs/{id}/invites": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Org id.")],
        post: {
          tags: ["Orgs"],
          summary: "Invite someone by email",
          description:
            "Admin + interactive login. If the email has no account yet, a login is provisioned " +
            "(the invitee gets a temp-password email); an existing user is a no-op. The invitee " +
            "sees the pending invite on their next sign-in and accepts it.",
          security: [{ accountToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("CreateInviteRequest") } } },
          responses: {
            "201": jsonResponse("Invite created.", "InviteEnvelope"),
            "400": jsonResponse("Invalid email/role, or a personal org.", "Error"),
            "401": UNAUTHORIZED,
            "403": jsonResponse("Requires the admin role.", "Error"),
            "404": jsonResponse("Not found / not a member.", "Error"),
            // Already a member: inviting them again would route around the role model
            // (and the last-admin guard), so change their role instead. Not retryable.
            "409": jsonResponse("Already a member - change their role instead.", "Error"),
          },
        },
        get: {
          tags: ["Orgs"],
          summary: "List an org's pending invites",
          description: "Admin + interactive login.",
          security: [{ accountToken: [] }],
          responses: {
            "200": jsonResponse("Pending invites.", "InvitesResponse"),
            "401": UNAUTHORIZED,
            "403": jsonResponse("Requires the admin role.", "Error"),
          },
        },
      },
      "/orgs/{id}/invites/{email}": {
        parameters: [ORG_HEADER_PARAM, pathParam("id", "Org id."), pathParam("email", "Invitee email.")],
        delete: {
          tags: ["Orgs"],
          summary: "Rescind a pending invite",
          description: "Admin + interactive login.",
          security: [{ accountToken: [] }],
          responses: {
            "204": { description: "Rescinded." },
            "401": UNAUTHORIZED,
            "403": jsonResponse("Requires the admin role.", "Error"),
          },
        },
      },
      "/invites": {
        parameters: [ORG_HEADER_PARAM],
        get: {
          tags: ["Orgs"],
          summary: "My pending invites",
          description: "Invites matched to your login email. Interactive login only (a PAT carries no email).",
          security: [{ accountToken: [] }],
          responses: { "200": jsonResponse("Your pending invites.", "InvitesResponse"), "401": UNAUTHORIZED, "403": jsonResponse("Requires an interactive login.", "Error") },
        },
      },
      "/invites/{orgId}/accept": {
        parameters: [ORG_HEADER_PARAM, pathParam("orgId", "Org id from the invite.")],
        post: {
          tags: ["Orgs"],
          summary: "Accept an invite",
          description: "Become a member with the invited role. Matched to your login email. Interactive login only.",
          security: [{ accountToken: [] }],
          responses: {
            "200": jsonResponse("Joined - the org and the role you now hold in it.", "AcceptInviteResponse"),
            "400": jsonResponse("No verified email.", "Error"),
            "401": UNAUTHORIZED,
            "403": jsonResponse("Requires an interactive login.", "Error"),
            "404": jsonResponse("No pending invite for you in that org.", "Error"),
          },
        },
      },
      "/invites/{orgId}/decline": {
        parameters: [ORG_HEADER_PARAM, pathParam("orgId", "Org id from the invite.")],
        post: {
          tags: ["Orgs"],
          summary: "Decline an invite",
          description: "Delete the pending invite. Interactive login only.",
          security: [{ accountToken: [] }],
          responses: { "204": { description: "Declined." }, "401": UNAUTHORIZED, "403": jsonResponse("Requires an interactive login.", "Error") },
        },
      },
      "/agents/{id}/invoke": {
        parameters: [pathParam("id", "Agent id.")],
        post: {
          tags: ["Run"],
          summary: "Trigger the agent",
          description:
            "Returns immediately with a session id; the agent works in the background. " +
            "Reusing a `sessionId` that is still working injects the message into the " +
            "running turn (status `injected`) instead of starting a new one.",
          security: [{ agentKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("InvokeRequest") } } },
          responses: {
            "200": jsonResponse("Accepted.", "InvokeResponse"),
            "400": jsonResponse("Missing prompt or invalid session id.", "Error"),
            "401": jsonResponse("Invalid API key.", "Error"),
            "504": jsonResponse(
              "Timed out with an UNKNOWN outcome - the turn may or may not have started. " +
                "Invoking is not idempotent (a repeat on the same session injects the prompt " +
                "again), so poll the returned `sessionId` to check before retrying.",
              "AmbiguousInvokeError",
            ),
          },
        },
      },
      "/agents/{id}/sessions/{sessionId}": {
        parameters: [pathParam("id", "Agent id."), pathParam("sessionId", "Session id from the invoke response.")],
        get: {
          tags: ["Run"],
          summary: "Poll a session",
          description:
            "Returns the session status and the trajectory delta since `after`. Pass the " +
            "returned `cursor` back as `after` on the next poll to stream only new events. " +
            "Poll until `status` is `idle`.",
          security: [{ agentKey: [] }],
          parameters: [
            {
              name: "after",
              in: "query",
              required: false,
              description: "Cursor from the previous poll. Omit to get the full trajectory.",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": jsonResponse("Session status + event delta.", "PollResponse"),
            "401": jsonResponse("Invalid API key.", "Error"),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        accountToken: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Your Agency account token (Cognito). Authorizes managing your agents.",
        },
        agentKey: {
          type: "http",
          scheme: "bearer",
          description:
              "An agent's API key (`ag_…`). Authorizes invoking ONLY that agent. Stored in plaintext " +
              "and returned on reads to callers who can write the agent, so tooling and the console " +
              "can prefill it; withheld from anyone who can only view.",
        },
      },
      schemas: buildSchemas(),
    },
  } as const;
}

/* ---- helpers -------------------------------------------------------------- */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
/**
 * The active-org header, declared on every management path so a generated client
 * can actually send it (it was prose-only before, which meant SDKs had no way to
 * select an org). Optional: omitted means your personal org. Not on the invoke/poll
 * paths - an agent key already implies exactly one agent in one org.
 */
const ORG_HEADER_PARAM = {
  name: "X-Agency-Org",
  in: "header",
  required: false,
  schema: { type: "string" },
  description:
    "The org to act in, validated against your membership. Omit to use your personal org. " +
    "A Personal Access Token is bound to one org at mint, so this header can't override it.",
} as const;
const jsonResponse = (description: string, schema: string) => ({
  description,
  content: { "application/json": { schema: ref(schema) } },
});
/** 401 for a management route (missing/invalid account token). */
const UNAUTHORIZED = jsonResponse("Missing or invalid account token.", "Error");
/**
 * 403 for a management route. Distinct from 404: you can SEE the resource, your
 * authority just doesn't reach it. Three causes, all real - your role lacks the
 * scope (a `viewer` on any write), you asserted an org you're not a member of, or
 * the resource is visible but not writable by you (a co-member's shared resource,
 * unless you're an admin or a listed manager).
 */
const FORBIDDEN = jsonResponse(
  "Your role, org membership, or per-resource authority doesn't allow this. The message says which.",
  "Error",
);
/** Appended to every delete route's description - `delete` isn't in a default token. */
const DELETE_SCOPE_NOTE =
  "Requires the `delete` scope, which is not granted to a token by default.";
/**
 * Declared on the two routes that bump a config version. The bump is a
 * compare-and-swap; if concurrent edits to the same agent keep winning the race,
 * the request is rejected as retryable rather than applied on a stale read.
 */
const CONFLICT_RETRY = jsonResponse("Concurrent update in progress - retry shortly.", "Error");
/**
 * The last-admin invariant is held by a conditional write, so a concurrent change
 * to the org's admins makes this request lose rather than jointly leave the org
 * with no admins. Reload the roster and retry.
 */
const ADMINS_CHANGED = jsonResponse("The org's admins changed concurrently - reload and retry.", "Error");
const pathParam = (name: string, description: string) => ({
  name,
  in: "path" as const,
  required: true,
  description,
  schema: { type: "string" as const },
});

/* ---- schemas (mirror packages/shared/src/index.ts) ------------------------
 * Built inside a function, not a module-level const: `openapi.ts` and `index.ts`
 * import from each other (index re-exports buildOpenApiSpec; this file imports
 * MODEL_KEYS), and a top-level const that reads MODEL_KEYS can evaluate before
 * that binding is initialized under the bundler's module order - which crashed
 * the whole control-plane Lambda at init. Deferring to call time removes the
 * init-order hazard entirely. */
function buildSchemas() {
  return {
  Error: {
    type: "object",
    properties: { error: { type: "string" } },
    required: ["error"],
  },
  ValidationError: {
    type: "object",
    description:
      "A 400 from a validating route. `details` names each field that's wrong and the rule " +
      "it broke, so the caller can fix the body without guessing.",
    properties: {
      error: { type: "string" },
      details: { type: "array", items: { type: "string" } },
    },
    required: ["error"],
  },
  AmbiguousInvokeError: {
    type: "object",
    description: "An invoke whose outcome is unknown. Poll `sessionId` to see whether the turn started.",
    properties: { error: { type: "string" }, sessionId: { type: "string" } },
    required: ["error", "sessionId"],
  },

  SlackSetupResponse: {
    type: "object",
    description: "The Slack setup state plus the manifest to paste. Carries no credential.",
    properties: {
      state: {
        type: "string",
        enum: ["manifest_ready", "url_verified", "needs_bot_token", "verified", "live"],
        description:
          "Derived, never stored: manifest_ready → url_verified (Slack reached our webhook) → " +
          "needs_bot_token → verified (workspace known) → live (a channel is set).",
      },
      manifest: { type: "object", description: "The complete Slack app manifest to paste." },
      requestUrl: { type: "string", description: "The webhook URL baked into the manifest." },
      requestedScopes: { type: "array", items: { type: "string" } },
      hasBotToken: { type: "boolean", description: "Whether a bot token is stored (never the token)." },
      appId: { type: "string" },
      teamId: { type: "string" },
      teamName: { type: "string" },
      botUserId: { type: "string" },
      grantedScopes: { type: "array", items: { type: "string" } },
      urlVerified: { type: "boolean" },
      channels: { type: "array", items: { type: "string" } },
    },
    required: ["state", "manifest", "requestUrl", "requestedScopes", "hasBotToken", "urlVerified", "channels"],
  },
  SlackCredentialsInput: {
    type: "object",
    description: "The two values only the workspace owner can get. Both are write-only.",
    properties: {
      botToken: { type: "string", description: "Bot User OAuth Token (xoxb-…), from OAuth & Permissions." },
      signingSecret: { type: "string", description: "Signing Secret, from Basic Information." },
    },
    required: ["botToken", "signingSecret"],
  },
  SlackCredentialsResponse: {
    type: "object",
    description: "What Slack reported when the token was verified.",
    properties: {
      teamId: { type: "string" },
      teamName: { type: "string" },
      botUserId: { type: "string" },
      grantedScopes: {
        type: "array",
        items: { type: "string" },
        description: "What Slack GRANTED, from the auth.test response - not what we requested.",
      },
    },
    required: ["teamId", "teamName", "botUserId", "grantedScopes"],
  },
  SlackChannelsInput: {
    type: "object",
    properties: { channels: { type: "array", items: { type: "string" } } },
    required: ["channels"],
  },
  SlackChannelsResponse: {
    type: "object",
    properties: {
      channels: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            isPrivate: { type: "boolean" },
          },
          required: ["id", "name", "isPrivate"],
        },
      },
    },
    required: ["channels"],
  },

  Trigger: {
    description: "What can trigger the agent. Always includes an `api` trigger.",
    oneOf: [
      { type: "object", properties: { type: { const: "api" } }, required: ["type"] },
      {
        type: "object",
        properties: {
          type: { const: "schedule" },
          expression: { type: "string", description: "EventBridge Scheduler expression, e.g. `rate(1 hour)`." },
          timezone: { type: "string", description: "IANA timezone (default UTC)." },
          prompt: { type: "string", description: "Message delivered to the agent on each tick." },
        },
        required: ["type", "expression", "prompt"],
      },
      {
        type: "object",
        description:
          "Slack: the agent runs when its bot is @-mentioned in an allowed channel. One Slack " +
          "app per agent - the app is the agent's identity in Slack. Everything but `channels` " +
          "is written by the /agents/{id}/slack endpoints, not by a config PATCH.",
        properties: {
          type: { const: "slack" },
          channels: {
            type: "array",
            items: { type: "string" },
            description:
              "Channel ids the agent may answer in. EMPTY MEANS NOWHERE - the agent is " +
              "connected but every mention is dropped.",
          },
          appId: { type: "string", description: "Slack app id (read-only here)." },
          teamId: { type: "string", description: "Slack workspace id (read-only here)." },
          teamName: { type: "string", description: "Workspace name, for display (read-only here)." },
          botUserId: { type: "string", description: "The bot's user id (read-only here)." },
          grantedScopes: {
            type: "array",
            items: { type: "string" },
            description: "Scopes Slack actually granted, read from auth.test (read-only here).",
          },
          urlVerified: {
            type: "boolean",
            description: "True once Slack's url_verification challenge has been answered.",
          },
        },
        required: ["type", "channels"],
      },
    ],
  },

  // The creator-controlled config. On create, name + systemPrompt + model are
  // required; the boolean capabilities and triggers default. The patch variant
  // is fully partial.
  AgentConfigInput: {
    type: "object",
    description: "Agent configuration, plus the resource metadata that isn't versioned config.",
    properties: { ...agentConfigProps(), ...resourceMetaProps() },
    required: ["name", "systemPrompt", "model"],
  },
  AgentConfigPatch: {
    type: "object",
    description: "Partial agent configuration; only the provided fields change. Metadata fields may be sent too.",
    properties: { ...agentConfigProps(), ...resourceMetaProps() },
  },
  // The config as RETURNED on an agent - always fully populated (the server
  // fills defaults on create), so every field is required here, unlike the input.
  AgentConfig: {
    type: "object",
    description: "An agent's full, resolved configuration.",
    properties: agentConfigProps(),
    required: ["name", "systemPrompt", "model", "baseTools", "webSearch", "networkAccess", "triggers"],
  },

  AgentMetrics: {
    type: "object",
    description:
      "Counters kept on the agent record. Error counts, durations, token usage and cost come from " +
      "GET /agents/{id}/metrics (per-session summaries), not from here.",
    properties: {
      invocations: { type: "integer" },
      lastInvokedAt: { type: ["string", "null"], format: "date-time" },
    },
    required: ["invocations", "lastInvokedAt"],
  },

  Agent: {
    type: "object",
    description: "An agent as returned by the API.",
    properties: {
      id: { type: "string" },
      orgId: { type: "string", description: "The org this agent lives in." },
      createdBy: { type: "string", description: "userId of the creator." },
      shared: { type: "boolean", description: "true = visible to the whole org; false = creator-only." },
      managers: MANAGERS_PROP,
      config: ref("AgentConfig"),
      description: { type: "string", description: "Non-versioned roster label." },
      version: { type: "integer", description: "Current config version (latest is live)." },
      invokeUrl: { type: "string", description: "The URL clients POST to in order to trigger this agent." },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      metrics: ref("AgentMetrics"),
    },
    required: ["id", "orgId", "createdBy", "shared", "config", "version", "invokeUrl", "createdAt", "updatedAt", "metrics"],
  },

  AgentVersion: {
    type: "object",
    description: "One immutable config snapshot in an agent's history.",
    properties: {
      agentId: { type: "string" },
      version: { type: "integer" },
      config: ref("AgentConfig"),
      createdAt: { type: "string", format: "date-time" },
      note: { type: "string", description: "How it came to be, e.g. 'restored from v2'." },
    },
    required: ["agentId", "version", "config", "createdAt"],
  },
  VersionsResponse: {
    type: "object",
    properties: { versions: { type: "array", items: ref("AgentVersion") } },
    required: ["versions"],
  },

  Skill: {
    type: "object",
    description: "A reusable instruction doc, org-scoped, attachable to many agents.",
    properties: {
      id: { type: "string" },
      orgId: { type: "string", description: "The org this skill lives in." },
      createdBy: { type: "string", description: "userId of the creator." },
      shared: { type: "boolean", description: "true = usable by the whole org; false = creator-only." },
      managers: MANAGERS_PROP,
      name: { type: "string", description: "Lowercase slug (also the model-facing skill name)." },
      description: { type: "string" },
      content: { type: "string", description: "The Markdown instructions (SKILL.md body)." },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      usedByAgentCount: { type: "integer", description: "Agents currently attaching this skill." },
    },
    required: ["id", "orgId", "createdBy", "shared", "name", "description", "content", "createdAt", "updatedAt"],
  },
  SkillInput: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "A SKILL.md document: YAML frontmatter (name + description) then a titled body " +
          "with sections. name + description are parsed from the frontmatter.",
      },
      shared: { type: "boolean", description: "Visible to the whole org (default true) or creator-only (false)." },
      managers: MANAGERS_PROP,
    },
    required: ["content"],
  },
  SkillEnvelope: { type: "object", properties: { skill: ref("Skill") }, required: ["skill"] },
  SkillsResponse: {
    type: "object",
    properties: { skills: { type: "array", items: ref("Skill") } },
    required: ["skills"],
  },

  IntegrationAuth: {
    description:
      "How the proxy authenticates to the downstream API (never the secret itself). The credential " +
      "is the separate write-only `secret`: a static token for bearer/apiKey, the client secret for oauth2Client.",
    oneOf: [
      { type: "object", properties: { kind: { const: "none" } }, required: ["kind"] },
      { type: "object", properties: { kind: { const: "bearer" } }, required: ["kind"] },
      {
        type: "object",
        properties: { kind: { const: "apiKey" }, header: { type: "string", description: "Header the secret is sent in." } },
        required: ["kind", "header"],
      },
      {
        type: "object",
        description: "OAuth2 client-credentials (m2m): the proxy mints + caches a short-lived token and injects it.",
        properties: {
          kind: { const: "oauth2Client" },
          tokenUrl: { type: "string", description: "Token endpoint the proxy POSTs the client-credentials grant to." },
          clientId: { type: "string", description: "OAuth client id (non-secret; the client secret is the write-only `secret`)." },
          scope: { type: "string", description: "Optional space-delimited scopes." },
          audience: { type: "string", description: "Optional audience (some providers require it)." },
          authStyle: { type: "string", enum: ["basic", "body"], description: "Send the client secret via HTTP Basic or the form body." },
        },
        required: ["kind", "tokenUrl", "clientId", "authStyle"],
      },
    ],
  },
  IntegrationOperation: {
    type: "object",
    description: "One declared operation - the unit the agent calls and the proxy authorizes.",
    properties: {
      operationId: { type: "string", description: "Stable id the agent names, e.g. `listPets`." },
      summary: { type: "string", description: "One-line model-facing description." },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      path: { type: "string", description: "Path relative to baseUrl, may contain `{param}` placeholders." },
    },
    required: ["operationId", "summary", "method", "path"],
  },
  DiscoveredOperation: {
    type: "object",
    description: "A discovered operation plus whether it's enabled (the selection that survives a refresh).",
    properties: {
      operationId: { type: "string" },
      summary: { type: "string" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      path: { type: "string" },
      enabled: { type: "boolean", description: "Whether this operation is granted to agents." },
    },
    required: ["operationId", "summary", "method", "path", "enabled"],
  },
  IntegrationDiscovery: {
    type: "object",
    description: "Auto-discovery state: the full last-seen catalog + per-op selection (the enabled subset is materialized into `operations`).",
    properties: {
      url: { type: "string", description: "The spec URL fetched." },
      provider: { type: "string", enum: ["openapi"], description: "Which provider parsed the spec." },
      syncedAt: { type: "string", format: "date-time", description: "Last successful fetch + parse." },
      operations: { type: "array", items: ref("DiscoveredOperation") },
    },
    required: ["url", "provider", "syncedAt", "operations"],
  },
  Integration: {
    type: "object",
    description: "A downstream-API integration, org-scoped, attachable to many agents.",
    properties: {
      id: { type: "string" },
      orgId: { type: "string", description: "The org this integration lives in." },
      createdBy: { type: "string", description: "userId of the creator." },
      shared: { type: "boolean", description: "true = usable by the whole org; false = creator-only." },
      managers: MANAGERS_PROP,
      name: { type: "string" },
      description: { type: "string" },
      baseUrl: { type: "string", description: "Base URL the proxy forwards to (operations are relative to it)." },
      auth: ref("IntegrationAuth"),
      operations: { type: "array", items: ref("IntegrationOperation"), description: "The agent-facing manifest (enabled subset when discovery is set)." },
      discovery: { ...ref("IntegrationDiscovery"), description: "Present when operations were auto-discovered from a spec URL." },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      hasSecret: { type: "boolean", description: "Whether a credential is set (never the secret)." },
      usedByAgentCount: { type: "integer", description: "Agents currently attaching this integration." },
    },
    required: ["id", "orgId", "createdBy", "shared", "name", "description", "baseUrl", "auth", "operations", "createdAt", "updatedAt"],
  },
  IntegrationInput: {
    type: "object",
    description:
      "Operations come from EITHER `operations` (manual) OR `discovery` (server fetches + parses the spec). " +
      "When `discovery` is set, `operations` is ignored.",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      baseUrl: { type: "string", description: "Base URL (http or https). The proxy forwards ONLY here." },
      auth: ref("IntegrationAuth"),
      operations: { type: "array", items: ref("IntegrationOperation"), description: "Hand-authored operations (required unless `discovery` is set)." },
      discovery: {
        type: "object",
        description: "Discovery mode. Omit `enabledOperationIds` to enable ALL discovered ops (first-import default); send an array to enable exactly those. Refresh reconciles against the stored selection.",
        properties: {
          url: { type: "string", description: "The spec URL to fetch + parse." },
          enabledOperationIds: { type: "array", items: { type: "string" } },
        },
        required: ["url"],
      },
      secret: { type: "string", description: "Write-only credential. Omit on update to keep the stored one." },
      shared: { type: "boolean", description: "Visible to the whole org (default true) or creator-only (false)." },
      managers: MANAGERS_PROP,
    },
    required: ["name", "description", "baseUrl", "auth"],
  },
  IntegrationEnvelope: { type: "object", properties: { integration: ref("Integration") }, required: ["integration"] },
  IntegrationsResponse: {
    type: "object",
    properties: { integrations: { type: "array", items: ref("Integration") } },
    required: ["integrations"],
  },
  DiscoverResponse: {
    type: "object",
    description: "A stateless discovery preview: the parsed catalog (all enabled) for a pick-a-subset UI.",
    properties: {
      provider: { type: "string", enum: ["openapi"] },
      operations: { type: "array", items: ref("DiscoveredOperation") },
    },
    required: ["provider", "operations"],
  },

  TokenUsage: {
    type: "object",
    description: "Token usage counters - the four LLM billing drivers.",
    properties: {
      inputTokens: { type: "integer" },
      outputTokens: { type: "integer" },
      cacheReadTokens: { type: "integer" },
      cacheWriteTokens: { type: "integer" },
    },
    required: ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"],
  },
  AgentRun: {
    type: "object",
    description: "One past run (one runtime lifetime). `runId` opens its trajectory.",
    properties: {
      runId: { type: "string", description: "Identifies the run; pass to /runs/{runId} for the trajectory." },
      sessionId: { type: "string", description: "The conversation this run belonged to (may be shared with other runs)." },
      version: { type: "integer", description: "The config version this run executed." },
      model: { type: "string", description: "Absent on runs from before model tracking." },
      startedAt: { type: "string", format: "date-time" },
      endedAt: { type: "string", format: "date-time" },
      durationMs: { type: "integer", description: "Whole-lifetime span, including idle gaps." },
      invocations: { type: "integer", description: "Triggers in this run (opening trigger + injections)." },
      turns: { type: "integer" },
      toolUses: { type: "integer" },
      outcome: { type: "string", enum: ["ok", "error"] },
      totalTokens: { type: "integer", description: "The four token drivers summed." },
      costUsd: { type: "number", description: "Priced at this run's own model's rate." },
    },
    required: [
      "runId", "sessionId", "version", "startedAt", "endedAt", "durationMs",
      "invocations", "turns", "toolUses", "outcome", "totalTokens", "costUsd",
    ],
  },
  AgentRunsResponse: {
    type: "object",
    properties: { runs: { type: "array", items: ref("AgentRun") } },
    required: ["runs"],
  },
  AgentRunTrace: {
    type: "object",
    properties: {
      runId: { type: "string" },
      sessionId: { type: "string", description: "The conversation this run belonged to." },
      events: { type: "array", items: ref("TrajectoryEvent") },
      archived: {
        type: "boolean",
        description: "true = served from the archive; false = from live storage, or nothing was found.",
      },
      truncated: {
        type: "boolean",
        description: "Present and true when the run was too large to return whole; `events` holds the oldest that fit.",
      },
    },
    required: ["runId", "sessionId", "events", "archived"],
  },
  MetricsBucket: {
    type: "object",
    properties: {
      bucket: { type: "string", description: "Bucket start (UTC): `YYYY-MM-DDTHH` hourly, `YYYY-MM-DD` daily." },
      sessions: { type: "integer", description: "Runtime lifetimes that ended in this bucket." },
      invocations: { type: "integer", description: "Triggers across those sessions (a session can be triggered many times)." },
      errors: { type: "integer" },
      toolUses: { type: "integer" },
      toolBreakdown: {
        type: "object",
        additionalProperties: { type: "integer" },
        description: "Tool call counts by tool name in this bucket.",
      },
      durationMsTotal: { type: "integer", description: "Sum of per-invocation working durations in this bucket." },
      tokens: { type: "integer", description: "Total tokens (all four drivers) in this bucket." },
      costUsd: { type: "number", description: "Dollar cost in this bucket (tokens × per-model price)." },
    },
    required: [
      "bucket", "sessions", "invocations", "errors", "toolUses", "toolBreakdown",
      "durationMsTotal", "tokens", "costUsd",
    ],
  },
  MetricsSummary: {
    type: "object",
    description: "Aggregated operational metrics over a window (a session = one runtime lifetime).",
    properties: {
      from: { type: "string", format: "date-time" },
      to: { type: "string", format: "date-time" },
      granularity: { type: "string", enum: ["hour", "day"] },
      version: { type: ["integer", "null"], description: "The version filtered on, or null for all versions." },
      sessions: { type: "integer", description: "Runtime lifetimes in the window." },
      invocations: { type: "integer", description: "Triggers across those sessions." },
      errors: { type: "integer" },
      toolUses: { type: "integer" },
      avgDurationMs: { type: "integer", description: "Mean PER-INVOCATION working duration (not per session, which includes idle gaps)." },
      p50DurationMs: { type: "integer" },
      p95DurationMs: { type: "integer" },
      p99DurationMs: { type: "integer" },
      toolBreakdown: { type: "object", additionalProperties: { type: "integer" } },
      tokens: ref("TokenUsage"),
      totalTokens: { type: "integer", description: "Sum of the four token drivers over the window." },
      costUsd: { type: "number", description: "Total dollar cost over the window (per-model priced)." },
      avgCostUsd: { type: "number", description: "Mean per-session dollar cost over the window." },
      p50CostUsd: { type: "number", description: "Median per-session dollar cost." },
      p95CostUsd: { type: "number", description: "95th-percentile per-session dollar cost." },
      p99CostUsd: { type: "number", description: "99th-percentile per-session dollar cost." },
      series: { type: "array", items: ref("MetricsBucket") },
    },
    required: [
      "from", "to", "granularity", "version", "sessions", "invocations", "errors", "toolUses",
      "avgDurationMs", "p50DurationMs", "p95DurationMs", "p99DurationMs", "toolBreakdown",
      "tokens", "totalTokens", "costUsd", "avgCostUsd", "p50CostUsd", "p95CostUsd", "p99CostUsd", "series",
    ],
  },

  AgentEnvelope: { type: "object", properties: { agent: ref("Agent") }, required: ["agent"] },
  AgentList: {
    type: "object",
    properties: { agents: { type: "array", items: ref("Agent") } },
    required: ["agents"],
  },
  CreateAgentResponse: {
    type: "object",
    properties: {
      agent: ref("Agent"),
      apiKey: { type: "string", description: "The agent's API key. Returned once; never retrievable again." },
    },
    required: ["agent", "apiKey"],
  },
  RotateKeyResponse: {
    type: "object",
    properties: { apiKey: { type: "string" } },
    required: ["apiKey"],
  },

  Scope: {
    type: "string",
    enum: [...ALL_SCOPES],
    description: "A permission a Personal Access Token can grant.",
  },
  AccessToken: {
    type: "object",
    description: "A Personal Access Token as returned by the API (never the secret).",
    properties: {
      id: { type: "string" },
      ownerId: { type: "string", description: "userId of the token owner." },
      orgId: { type: "string", description: "The org this token acts within (chosen at mint)." },
      name: { type: "string", description: "Human label to tell tokens apart." },
      scopes: { type: "array", items: ref("Scope") },
      createdAt: { type: "string", format: "date-time" },
      lastUsedAt: { type: ["string", "null"], format: "date-time" },
    },
    required: ["id", "ownerId", "orgId", "name", "scopes", "createdAt", "lastUsedAt"],
  },
  AccessTokenList: {
    type: "object",
    properties: { tokens: { type: "array", items: ref("AccessToken") } },
    required: ["tokens"],
  },
  CreateAccessTokenRequest: {
    type: "object",
    properties: {
      name: { type: "string", description: "A label for the token." },
      scopes: { type: "array", items: ref("Scope"), minItems: 1 },
    },
    // The token binds to the caller's ACTIVE org (X-Agency-Org) at mint; there's no
    // orgId body field. Effective authority is its scopes ∩ the owner's role there.
    required: ["name", "scopes"],
  },
  CreateAccessTokenResponse: {
    type: "object",
    properties: {
      accessToken: ref("AccessToken"),
      token: { type: "string", description: "The plaintext token (`agpat_…`). Returned once; store it now." },
    },
    required: ["accessToken", "token"],
  },

  // ---- Org model --------------------------------------------------------
  Role: {
    type: "string",
    enum: [...ALL_ROLES],
    description: "A member's role in an org: admin (manage members/org), editor (create/manage resources), viewer (read-only).",
  },
  Org: {
    type: "object",
    properties: {
      orgId: { type: "string" },
      name: { type: "string" },
      kind: { type: "string", enum: ["personal", "team"] },
      createdBy: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["orgId", "name", "kind", "createdBy", "createdAt"],
  },
  OrgMembership: {
    type: "object",
    description: "An org the caller belongs to, with their role in it.",
    properties: {
      orgId: { type: "string" },
      name: { type: "string" },
      kind: { type: "string", enum: ["personal", "team"] },
      role: ref("Role"),
    },
    required: ["orgId", "name", "kind", "role"],
  },
  Me: {
    type: "object",
    description: "Identity bootstrap: who you are, your orgs, and the active org.",
    properties: {
      userId: { type: "string" },
      email: { type: "string" },
      orgs: { type: "array", items: ref("OrgMembership") },
      activeOrgId: { type: "string", description: "The org this request resolved as active." },
    },
    required: ["userId", "orgs", "activeOrgId"],
  },
  Member: {
    type: "object",
    properties: {
      userId: { type: "string" },
      role: ref("Role"),
      joinedAt: { type: "string", format: "date-time" },
      email: { type: "string", description: "The member's email, when known (for a readable roster + the managers picker)." },
    },
    required: ["userId", "role", "joinedAt"],
  },
  Invite: {
    type: "object",
    description: "A pending invitation to join an org, tied to an email.",
    properties: {
      email: { type: "string" },
      orgId: { type: "string" },
      orgName: { type: "string" },
      role: ref("Role"),
      invitedBy: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["email", "orgId", "orgName", "role", "invitedBy", "createdAt"],
  },
  OrgEnvelope: { type: "object", properties: { org: ref("Org") }, required: ["org"] },
  MembersResponse: { type: "object", properties: { members: { type: "array", items: ref("Member") } }, required: ["members"] },
  MemberEnvelope: { type: "object", properties: { member: ref("Member") }, required: ["member"] },
  AcceptInviteResponse: {
    type: "object",
    description: "Accepting is idempotent: an already-accepted invite returns your existing role.",
    properties: { orgId: { type: "string" }, role: ref("Role") },
    required: ["orgId", "role"],
  },
  InvitesResponse: { type: "object", properties: { invites: { type: "array", items: ref("Invite") } }, required: ["invites"] },
  InviteEnvelope: {
    type: "object",
    properties: { invite: ref("Invite") },
    required: ["invite"],
  },
  CreateOrgRequest: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  CreateInviteRequest: {
    type: "object",
    properties: { email: { type: "string" }, role: ref("Role") },
    required: ["email", "role"],
  },
  UpdateMemberRequest: { type: "object", properties: { role: ref("Role") }, required: ["role"] },

  InvokeRequest: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The message for the agent." },
      sessionId: {
        type: "string",
        pattern: "^[a-zA-Z0-9_-]{33,100}$",
        description: "Optional. Omit for a fresh session; reuse to continue (or inject into) one.",
      },
    },
    required: ["prompt"],
  },
  InvokeResponse: {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      status: {
        type: "string",
        enum: ["triggered", "injected", "rejected"],
        description:
          "`triggered`: started a fresh turn. `injected`: added to the running turn. " +
          "`rejected`: the session's mailbox is full - back off and retry.",
      },
    },
    required: ["sessionId", "status"],
  },

  TrajectoryEvent: {
    type: "object",
    description: "A single logged action in an agent's run.",
    properties: {
      cursor: { type: "string", description: "Monotonic cursor (UUIDv7). Pass the newest back as `after`." },
      // Derived from the runtime source of truth, not restated: a hardcoded copy
      // silently dropped `prompt` when that event type was added.
      type: { type: "string", enum: [...TRAJECTORY_EVENT_TYPES] },
      ts: { type: "string", format: "date-time" },
      content: {
        type: "string",
        description: "The user's message on `prompt`, assistant text on `text`, or the final answer on `session_end`.",
      },
      toolName: { type: "string" },
      toolUseId: { type: "string" },
      input: { description: "Tool input args (on `tool_input`)." },
      result: { type: "string", description: "Tool result, truncated (on `tool_result`)." },
      error: { type: "string", description: "Error message (on `error`)." },
    },
    required: ["cursor", "type", "ts"],
  },
  PollResponse: {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      status: { type: "string", enum: ["working", "idle"] },
      events: { type: "array", items: ref("TrajectoryEvent") },
      cursor: { type: ["string", "null"], description: "Newest cursor seen; pass back as `after`." },
    },
    required: ["sessionId", "status", "events", "cursor"],
  },
  } as const;
}

/** The shared property map for both the create and patch config schemas. */
/**
 * The `managers` grant list - ONE definition, referenced by every schema that carries it.
 * It appeared verbatim in six places and drifted: only two learned about the cap.
 */
const MANAGERS_PROP = {
  type: "array",
  items: { type: "string" },
  maxItems: 50,
  description:
    "Org members (userIds) granted write access beyond the creator + org admins. " +
    "Non-members, the creator's own id, and anything past the first 50 are DROPPED " +
    "(silently - the rest of the edit still applies). Only the creator or an admin may " +
    "change this list.",
} as const;

/**
 * Resource metadata accepted on an agent create/update body ALONGSIDE the config,
 * but not part of the versioned config itself - editing any of these never mints a
 * new version. Skills + integrations carry the same three on their own inputs.
 */
function resourceMetaProps() {
  return {
    description: {
      type: "string",
      maxLength: 280,
      description: "Short human label shown on the roster. Not versioned - editing it mints no new version.",
    },
    shared: {
      type: "boolean",
      description:
        "Visible to the whole org (default true on create). When false, only you can see it. " +
        "On update, omitting the field leaves the current value alone.",
    },
    managers: MANAGERS_PROP,
  } as const;
}

function agentConfigProps() {
  return {
    name: { type: "string", description: "Human-readable name." },
    systemPrompt: { type: "string", description: "Your system prompt, appended to the platform base prompt." },
    model: { type: "string", enum: [...MODEL_KEYS], description: "Which model the agent runs on." },
    baseTools: { type: "boolean", description: "Base coding tools (read/write/edit/bash)." },
    webSearch: { type: "boolean", description: "Built-in web search + fetch (requires public networkMode)." },
    networkAccess: { type: "boolean", description: "Whether web tools are wired. Forced false in isolated networkMode." },
    networkMode: {
      type: "string",
      enum: ["public", "isolated"],
      description:
        "Network posture. 'public' (default): outbound internet. 'isolated': no public egress; reaches Bedrock privately for model inference only (web search/fetch unavailable, and setting it forces webSearch/networkAccess off).",
    },
    triggers: { type: "array", items: ref("Trigger") },
    skillIds: { type: "array", items: { type: "string" }, description: "Ids of attached skills (see /skills)." },
    integrationIds: {
      type: "array",
      items: { type: "string" },
      description: "Ids of attached integrations (see /integrations). The agent can call these downstream APIs via the platform proxy - it never receives the credential.",
    },
    env: {
      type: "object",
      additionalProperties: { type: "string" },
      description:
        "Per-agent environment variables, available to the agent's tools (the model is told the key names only). " +
        "Intended for per-agent third-party secrets, so on READ the VALUES are returned only to a caller who can " +
        "write the agent (creator/admin/manager); everyone else who can see the agent gets the key names with each " +
        "value redacted to '***' - on the agent and on its versions history alike.",
    },
  } as const;
}
