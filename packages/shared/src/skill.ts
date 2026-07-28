/**
 * The Agency "skill": a self-contained SKILL.md-format document (YAML frontmatter
 * with name + description, then an imperative Markdown body) that gives a coding
 * agent everything it needs to create and manage agents via the API - what the
 * system is, how to authenticate, agent config, and copy-paste recipes for the
 * core flows.
 *
 * This is the ONLY reference we hand coding agents, so it must be complete on its
 * own. It's built here (beside the wire types + scopes it describes) so the scope
 * list and model list can't drift from the platform; the control-plane serves it
 * at `GET /skill.md` with the deployed origin baked in, and the web Docs page
 * offers it as a download.
 */
import { SCOPES, type Scope } from "./scopes.js";
import { MODEL_KEYS } from "./models.js";

/** Build the skill Markdown with a concrete API origin (no trailing slash). */
export function buildSkill(baseUrl: string): string {
  const origin = baseUrl.replace(/\/+$/, "");
  const scopeLines = (Object.keys(SCOPES) as Scope[])
    .map((s) => `| \`${s}\` | ${SCOPES[s]} |`)
    .join("\n");
  const models = MODEL_KEYS.map((m) => `\`${m}\``).join(", ");

  return `---
name: agency
description: Create and operate AI agents on the Agency platform via its HTTP API. Use when the user wants to build, configure, run, inspect, update, or delete an Agency agent, or trigger one and read its results (trajectory). Covers authentication (Personal Access Tokens and per-agent API keys), scopes, agent config, and the async invoke/poll/inject lifecycle.
---

# Agency

Create and operate AI agents on **Agency** through a small HTTP API. This document
is self-contained; the exact request/response schemas live in the OpenAPI 3.1 spec
at \`${origin}/openapi.json\` - fetch it when a field or endpoint here is unclear.

## What Agency is

An **agent** is a model + a system prompt + tools + triggers, running in its own
isolated microVM (AWS Bedrock AgentCore). Agents run **asynchronously**: you
trigger one and get a \`sessionId\` immediately; the agent works in the background
while you poll that session for its **trajectory** (the ordered list of events -
reasoning, tool calls, results, final answer). You can also inject a new message
into a session that's still working.

Base URL: \`${origin}\`

## Authentication

Two kinds of credential, for two kinds of call:

1. **Personal Access Token** (\`agpat_…\`) - authenticates the **management** API
   (create / list / update / delete agents). The user creates one in the Agency
   console under **Settings → Access tokens** and gives it to you. Send it as
   \`Authorization: Bearer agpat_…\`. A token is bound to **one organization** and is
   **scoped** (see below); its effective power is its scopes ∩ the owner's role in
   that org. If a call returns \`403\`, either your token lacks the required scope or
   your role can't perform that action; ask the user to mint a token with the scope,
   or to grant you a higher role.
2. **Agent API key** (\`ag_…\`) - returned once when an agent is created (and
   rotatable). It authenticates **only that agent's** invoke + poll endpoints.
   Use it to trigger and observe a specific agent; it cannot manage agents.

### Scopes and roles

Every request runs as a member of an organization with a **role**, and the role
determines the resource-scope set the caller effectively holds:

| Role | Scopes | Can |
|---|---|---|
| \`viewer\` | \`read\` | view shared resources; no create/edit/delete, no console run, no key rotation |
| \`editor\` | \`read\`, \`write\`, \`delete\` | create resources + manage the ones they created |
| \`admin\` | \`read\`, \`write\`, \`delete\` | everything an editor can, plus manage any shared resource, members, and org settings |

Management calls check the scope for the route:

| Scope | Grants |
|---|---|
${scopeLines}

A PAT's **effective scopes are its own scopes ∩ its role's scopes** - a token can
never widen past its role, and a role change (or removal from the org) takes effect
on the next request. If you need a scope the token lacks, ask the user to mint a new
token with it; if your role can't perform the action, ask an admin to raise it.
\`delete\` is deliberately separate and off by default: the tiers are read < write
(author) < delete (destroy), so a token can be allowed to build and update agents,
skills, and integrations without the power to destroy any of them.

### The active organization

Every management request acts within one organization. Send it with the
\`X-Agency-Org: <orgId>\` header - it's validated against your membership every
request. **Omit it to act in your personal org.** A PAT is pinned to one org at
mint time, so it ignores this header. Fetch \`GET /me\` (below) to discover which
orgs you belong to and their ids.

## Organizations

Resources belong to organizations, not individual users. Every user has a
**personal org** (auto-created, non-deletable) and can create **team orgs** and
invite others.

\`\`\`bash
# Who am I, which orgs am I in (with my role in each), which org is active?
curl -s "$BASE/me" -H "Authorization: Bearer $PAT"
# → { userId, email, orgs: [{ orgId, name, kind, role }], activeOrgId }

# Create a team org (you become its admin). Interactive login only.
curl -sX POST "$BASE/orgs" -H "Authorization: Bearer $JWT" \\
  -H "Content-Type: application/json" -d '{ "name": "Acme" }'

# Act in a specific org: pass its id (JWT callers). A PAT is pinned at mint time.
curl -s "$BASE/agents" -H "Authorization: Bearer $JWT" -H "X-Agency-Org: <ORG_ID>"
\`\`\`

Members have a role (\`admin\` / \`editor\` / \`viewer\` - see the table above).
Inviting members, accepting invites, and org management are **interactive-login
only** (a PAT can't do them) - do these in the console, not with a coding-assistant
token. New resources default to \`shared: true\` (org-visible); set \`shared: false\`
on the create body to keep one private to you.

## Agent configuration

When creating or updating an agent, the config fields are:

- \`name\` (string, required) - a human-readable name.
- \`systemPrompt\` (string, required) - the agent's instructions. Appended to the
  platform's base harness prompt.
- \`model\` (string, required) - one of: ${models}.
- \`baseTools\` (boolean) - enable the base coding tools (read/write/edit files,
  run bash) in a sandboxed workspace.
- \`webSearch\` (boolean) - enable built-in web search + fetch (requires public \`networkMode\`).
- \`networkMode\` (string) - \`"public"\` (default): outbound internet. \`"isolated"\`: no public
  egress at all - the agent reaches Bedrock privately for model inference only, and web
  search/fetch are unavailable. Setting \`"isolated"\` forces \`webSearch\` and
  \`networkAccess\` off. **Only Anthropic models run isolated**: the OpenAI models are served
  via Bedrock Mantle, which needs cross-region egress, so pairing one with
  \`"isolated"\` is rejected with a 400.
- \`networkAccess\` (boolean) - whether web tools are wired; forced false in isolated mode.
- \`triggers\` (array) - how the agent is invoked. Always includes \`{ "type": "api" }\`.
  Add \`{ "type": "schedule", "expression": "rate(1 hour)", "prompt": "…", "timezone": "UTC" }\`
  to run it unattended on a cron/interval (EventBridge Scheduler expression).
  Add \`{ "type": "slack", "channels": [] }\` to make the agent answer Slack @-mentions;
  finish the connection with the \`/agents/{id}/slack*\` endpoints (see below). An EMPTY
  \`channels\` list means the agent answers NOWHERE - that's the fail-closed default.
- \`skillIds\` (string[]) - ids of reusable skills to attach (manage via \`/skills\`).
  The agent loads a skill's instructions on demand; editing a skill updates every
  agent using it on the next run.
- \`integrationIds\` (string[]) - ids of downstream-API integrations to attach
  (manage via \`/integrations\`). The agent calls these APIs through a platform
  proxy that holds the credential and forwards the request - the agent never sees
  the secret. It discovers the available operations at runtime.
- \`env\` (object) - per-agent environment variables (key → value) made available
  to the agent's tools (e.g. read \`$API_KEY\` in run_bash). For third-party keys.

Alongside the config fields, the create/update body takes \`shared\` (boolean,
**default true**): a shared resource is visible to everyone in the org; \`false\`
makes it visible only to its creator (and admins can't pierce that). The same
\`shared\` flag applies to skills and integrations. It's metadata, not versioned
config, so toggling it never bumps the agent version.

Optionally set \`managers\` (an array of member userIds) to grant edit/delete on the
resource to specific org members beyond its creator + admins; it only widens who can
write, never who can see it.

Config changes take effect on the agent's next run - no redeploy.

## Recipes

Set your token once. Management calls are org-scoped: you see the shared resources
in your active org plus your own private ones (a PAT acts in the org it was bound
to at mint; a JWT selects the org with the \`X-Agency-Org\` header, else personal).

\`\`\`bash
PAT="<YOUR_PAT>"
BASE="${origin}"
\`\`\`

### Create an agent

\`\`\`bash
curl -sX POST "$BASE/agents" \\
  -H "Authorization: Bearer $PAT" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "news-summarizer",
    "systemPrompt": "You summarize the top AI news of the day in five bullet points.",
    "model": "${MODEL_KEYS[0]}",
    "baseTools": false,
    "webSearch": true,
    "networkAccess": true
  }'
# → { "agent": { "id": "…", "invokeUrl": "…", … }, "apiKey": "ag_…" }
# Save apiKey - it is shown ONCE and authenticates this agent's invoke/poll.
\`\`\`

Requires scope \`write\`.

### List / inspect agents

\`\`\`bash
curl -s "$BASE/agents"        -H "Authorization: Bearer $PAT"   # all your agents
curl -s "$BASE/agents/<AGENT_ID>" -H "Authorization: Bearer $PAT" # one agent (config + metrics)
\`\`\`

Requires scope \`read\`.

### Update an agent

\`\`\`bash
curl -sX PATCH "$BASE/agents/<AGENT_ID>" \\
  -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \\
  -d '{ "systemPrompt": "New instructions.", "model": "${MODEL_KEYS[0]}" }'
\`\`\`

Partial - send only the fields you want to change. Requires \`write\`.

### Trigger an agent and wait for the result

Uses the **agent API key** (\`ag_…\`), not the PAT.

\`\`\`bash
KEY="<AGENT_API_KEY>"
# 1. Trigger - returns a session id immediately; the agent runs in the background.
SID=$(curl -sX POST "$BASE/agents/<AGENT_ID>/invoke" \\
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\
  -d '{ "prompt": "Summarize the top AI news of today." }' | jq -r .sessionId)

# 2. Poll until the agent is done (status leaves "working").
while : ; do
  sleep 1
  RESP=$(curl -s "$BASE/agents/<AGENT_ID>/sessions/$SID" -H "Authorization: Bearer $KEY")
  [ "$(echo "$RESP" | jq -r .status)" != "working" ] && break
done

# The final answer is the last event's content (or .error if it failed).
echo "$RESP" | jq -r '.events[-1].content // .events[-1].error'
\`\`\`

To **stream the trajectory** instead of just the final answer, pass the previous
poll's \`cursor\` back as \`?after=<cursor>\` to get only new events each poll, and
print each event's \`type\` + \`content\`/\`toolName\`. Poll until \`status\` is \`idle\`.

To **steer a running agent**, POST the same \`invoke\` endpoint with the same
\`sessionId\` while it's still working - the message is injected into the running
turn. The response \`status\` is \`injected\` (mid-turn), \`triggered\` (started fresh),
or \`rejected\` (busy - back off and retry).

### Delete an agent

\`\`\`bash
curl -sX DELETE "$BASE/agents/<AGENT_ID>" -H "Authorization: Bearer $PAT"
# → 204 No Content
\`\`\`

### Connecting an agent to Slack

One Slack app per agent - the app IS the agent's identity, since people @-mention it by name.
Three calls, and the user does three things in Slack that no API can do for them:

1. \`GET /agents/{id}/slack\` → returns \`state\` plus a COMPLETE app \`manifest\` (scopes,
   event subscription, and the agent's webhook URL already baked in). Hand the manifest to the
   user to paste into Slack's *Create New App → From a manifest* flow.
2. Slack POSTs a \`url_verification\` challenge to the webhook as soon as the app is created;
   we answer it automatically, and \`state\` becomes \`url_verified\` on its own. Poll the GET
   to show progress - if it never flips, the manifest went somewhere else.
3. The user installs the app (workspace consent - no API for it) and copies two values:
   \`PUT /agents/{id}/slack/credentials\` with \`{ botToken, signingSecret }\`. Both are
   write-only. We verify with Slack's \`auth.test\` BEFORE storing, and the response tells you
   which workspace was connected and which scopes Slack actually granted.
4. \`PUT /agents/{id}/slack/channels\` with \`{ channels: ["C…"] }\`. Every id is validated
   against the connected workspace, because channel ids are workspace-scoped and a foreign id
   produces an agent that looks configured and silently ignores every mention.

Once live, mentioning the bot starts a run; **replying in the same thread injects into the run
already in progress** rather than starting a second one. The agent gets \`slack_reply\` and
\`slack_set_status\` tools automatically - it never holds the bot token, and it can only post
to the thread it was invoked from.

Requires the \`delete\` scope (destructive; removes the agent's schedule + record. Its
config version history is orphaned, not deleted, but nothing can read it back).

### Versions & metrics

Every config change (via \`PATCH\`) creates a new version; invokes always run the
latest. Inspect and restore history, and read operational metrics:

\`\`\`bash
# List config versions (newest first). Requires read.
curl -s "$BASE/agents/<AGENT_ID>/versions" -H "Authorization: Bearer $PAT"

# Restore an earlier version (appends it as a new latest). Requires write.
curl -sX POST "$BASE/agents/<AGENT_ID>/versions/1/restore" -H "Authorization: Bearer $PAT"

# Operational metrics over a window (hours, default 24; hourly buckets up to 7d,
# daily above). Add &version=N to scope to one version. Requires read.
curl -s "$BASE/agents/<AGENT_ID>/metrics?hours=24" -H "Authorization: Bearer $PAT"
# → { sessions, errors, toolUses, avgDurationMs, p50/p95/p99DurationMs, toolBreakdown, series[] }
\`\`\`

A "session" counts one runtime lifetime (a microVM lives up to 8h across many
triggers), not each invoke.

### Past runs (inspect a finished run)

\`\`\`bash
# List past runs, newest first (default 50, max 200). Requires read.
curl -s "$BASE/agents/<AGENT_ID>/runs" -H "Authorization: Bearer $PAT"
# → { "runs": [ { runId, sessionId, version, startedAt, durationMs, turns,
#                 toolUses, outcome, totalTokens, costUsd }, … ] }

# Open one run's trajectory - pass the run's runId. Requires read.
curl -s "$BASE/agents/<AGENT_ID>/runs/<RUN_ID>" -H "Authorization: Bearer $PAT"
# → { runId, sessionId, events: [ … ], archived: true|false, truncated?: true }
\`\`\`

Address a run by \`runId\`, not \`sessionId\`: a caller may reuse one sessionId for
several runs (each microVM lifetime is its own run), so a sessionId doesn't identify one.

The run LIST is durable, so it covers runs of any age. A trajectory is kept in live
storage for 30 days and archived after that - \`archived\` tells you which you got. A run
older than that which was never archived returns \`events: []\` with
\`archived: false\`; that means the steps are gone, not that the run did nothing.

A very large run is clipped to its OLDEST events and flagged \`truncated: true\` - expect
gaps rather than treating it as the whole run.

Pair a \`tool_result\` with the \`tool_input\` it answers by \`toolUseId\`, not by
position - a run can have several calls in flight at once, so adjacency lies.

### Skills (reusable instructions)

A skill is ONE Markdown document - a \`SKILL.md\` - that you attach to agents by id.
The agent sees only its name + description up front and loads the full instructions
on demand, so attaching several skills costs little context. Editing a skill reaches
every agent using it on the next run (content is never copied into agent config).

**The document must be a valid SKILL.md or the create 400s.** The body of the request
is just \`{ "content": "<the whole document>" }\` - \`name\` and \`description\` are PARSED
from the frontmatter, not sent as fields. Required structure:

1. YAML frontmatter first: a \`---\` block with \`name\` and \`description\`.
2. \`name\`: 1-64 chars, lowercase letters/digits/hyphens only (no spaces, no capitals).
3. A title (\`# \` heading) and at least one section (\`## \` heading).

\`\`\`bash
# Create a skill. The whole SKILL.md goes in the content field; name + description
# are read from its frontmatter. Requires write.
curl -sX POST "$BASE/skills" \\
  -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' \\
  -d '{"content":"---\\nname: refund-policy\\ndescription: How to decide and process a customer refund. Use when a customer asks for money back.\\n---\\n\\n# Refund policy\\n\\n## When to use\\n\\nA customer asks for a refund or disputes a charge.\\n\\n## Steps\\n\\n1. Check the order date. Within 30 days, refunds are automatic.\\n2. Beyond 30 days, refund only if the item is faulty.\\n3. Record the reason on the order.\\n"}'
# → { "skill": { "id": "…", "name": "refund-policy", "description": "…", … } }

# List / read. Requires read.
curl -s "$BASE/skills" -H "Authorization: Bearer $PAT"
curl -s "$BASE/skills/<SKILL_ID>" -H "Authorization: Bearer $PAT"

# Update: send the full replacement document (not a patch of the body text).
curl -sX PATCH "$BASE/skills/<SKILL_ID>" \\
  -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' \\
  -d '{"content":"---\\nname: refund-policy\\ndescription: Updated guidance.\\n---\\n\\n# Refund policy\\n\\n## Steps\\n\\n1. …\\n"}'

# Attach to an agent by id (versioned config - this mints a new agent version).
curl -sX PATCH "$BASE/agents/<AGENT_ID>" \\
  -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' \\
  -d '{"skillIds":["<SKILL_ID>"]}'

# Delete. Requires the \`delete\` scope. Agents keep the dangling id; skipped at run time.
curl -sX DELETE "$BASE/skills/<SKILL_ID>" -H "Authorization: Bearer $PAT"
\`\`\`

A \`400\` returns \`details\` listing exactly what's wrong with the document - read it
rather than guessing. Skill **names are unique per org**, so creating (or renaming to)
a name already in use returns \`409\`; a skill keeps its own name on update.

### Integrations (downstream APIs)

Onboard a downstream API once, then attach it to agents by id (like skills). The
agent calls it through a platform **proxy** that holds the credential and forwards
the request, so plaintext credentials never reach the agent. Declare operations up
front (a manual manifest) OR let the platform auto-discover them from a spec URL; the
agent discovers and calls them by id.

\`\`\`bash
# Create an integration with a MANUAL manifest. secret is write-only (never returned).
curl -sX POST "$BASE/integrations" \\
  -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \\
  -d '{
    "name": "petstore",
    "description": "Internal pet inventory API.",
    "baseUrl": "https://api.example.com",
    "auth": { "kind": "bearer" },
    "secret": "the-downstream-token",
    "operations": [
      { "operationId": "listPets", "summary": "List all pets", "method": "GET", "path": "/pets" },
      { "operationId": "getPet", "summary": "Get one pet", "method": "GET", "path": "/pets/{id}" }
    ]
  }'

# OR auto-discover operations from an OpenAPI spec (omit "operations"; the server
# fetches + parses the spec). Omit enabledOperationIds to enable ALL discovered ops,
# or send an array to enable exactly those. POST /integrations/:id/refresh re-syncs
# (a daily sweep does too); new upstream ops arrive DISABLED, preserving your picks.
curl -sX POST "$BASE/integrations" \\
  -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \\
  -d '{
    "name": "petstore",
    "description": "Internal pet inventory API.",
    "baseUrl": "https://api.example.com",
    "auth": { "kind": "bearer" },
    "secret": "the-downstream-token",
    "discovery": { "url": "https://api.example.com/openapi.json" }
  }'

# List your integrations (hasSecret + usedByAgentCount, never the secret).
curl -s "$BASE/integrations" -H "Authorization: Bearer $PAT"

# Delete. Requires the \`delete\` scope. This destroys the stored credential too -
# no endpoint can read it back, so you'd have to re-fetch it from the provider.
curl -sX DELETE "$BASE/integrations/<INTEGRATION_ID>" -H "Authorization: Bearer $PAT"
\`\`\`

Attach with \`"integrationIds": ["<INTEGRATION_ID>"]\` on create/update. \`auth.kind\`
is \`"none"\`, \`"bearer"\` / \`"apiKey"\` (a static token; \`apiKey\` needs a \`"header"\`),
or \`"oauth2Client"\` (OAuth2 client-credentials/m2m: give \`tokenUrl\`, \`clientId\`,
\`authStyle\` \`"basic"|"body"\`, optional \`scope\`/\`audience\`, and the client secret as
\`secret\` - the proxy mints + caches a short-lived token). On update, omit \`secret\`
to keep the stored credential.

Unlike an agent \`PATCH\` (partial), an integration \`PATCH\` is **full-body**: send the
complete integration (\`name\`, \`baseUrl\`, \`auth\`, \`operations\`/\`discovery\`), not just the
changed fields - a partial body is rejected \`400\`. Moving \`baseUrl\` (or \`tokenUrl\`) to a
different origin while keeping the stored credential is refused; re-send \`secret\` to prove
you hold it.

## Notes for reliability

- **Async, always.** Never expect a result from \`invoke\`; always poll the session.
- **First invoke after create** can take ~1-2 min while the runtime becomes ready
  - retry the invoke until it returns 200.
- **Never blind-retry an invoke.** It is NOT idempotent: a repeat on the same
  \`sessionId\` is *injected* into the running turn, so the agent sees the prompt
  twice. A \`504\` means the outcome is unknown and carries the \`sessionId\` - poll
  it, and only re-invoke if no turn started.
- **A session can be closed out.** If an agent's environment dies mid-turn, the
  trajectory gets a terminal \`error\` event ("stopped responding") and the status
  goes \`idle\`, so a poll loop always terminates - it never hangs on \`working\`.
- **A long task can end on a per-turn budget.** One invocation is capped on turns,
  cumulative tokens, and wall-clock, so a run can finish with a terminal \`error\`
  reading "Stopped: the turn hit its …". That is a deliberate cost guard, not a
  platform fault: don't retry from scratch. Invoke the SAME \`sessionId\` again to
  continue - the conversation is intact and the next invocation gets a fresh budget.
- **\`invalid api key\` on invoke/poll means the id OR the key.** Those two endpoints
  return the SAME 401 for an unknown agent id and a wrong key - deliberately, so agent
  ids can't be enumerated. So check both: that you substituted the real agent id into
  the URL (not the \`<AGENT_ID>\` placeholder), and that the key is that agent's CURRENT
  one (rotating replaces it, and a key from a deleted agent never works). \`GET /agents\`
  with the PAT lists the ids. Note \`Bearer\` is optional on these two endpoints.
- **Errors return JSON** \`{ "error": "…" }\`. \`400\` = bad input, \`401\` = bad/missing
  credential, \`403\` = your scope or role can't do this (or you asserted an org
  you're not in; the message says which), \`404\` = not visible to you / not found,
  \`409\` = a concurrent change (re-read, then retry), \`503\` = transient (retry),
  \`504\` = unknown outcome (see above - poll, don't blind-retry).
- **The OpenAPI spec** at \`${origin}/openapi.json\` is the exact, authoritative
  contract - consult it for full schemas and any endpoint not shown here.
`;
}
