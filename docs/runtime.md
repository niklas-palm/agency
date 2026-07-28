# Agent runtime

`apps/agent-runtime` is the Strands agent harness that runs inside each AgentCore microVM.
There is **one** container image; every created agent runs the same image, differentiated
only by the config the control-plane sends in each invoke payload. So a config edit in the
UI takes effect on the agent's next invoke with no rebuild or redeploy - and the runtime
needs no read access to the agents table (one agent's IAM role can't read another's config).

**The runtime's AWS role is Bedrock-only.** It does NOT write DynamoDB. Trajectory events and
session summaries are POSTed to the control-plane's telemetry **ingest API** (`ingest.ts`),
authenticated by a **per-session capability token** - so the role holds only model invoke
(+ logs, ECR pull, web-search gateway). An agent that steals the role's creds via MMDS can
invoke our models but cannot touch any table. The token is minted per invoke by the
control-plane (scoped to this agentId+sessionId, ~9h TTL), rides the invoke payload, and is
verified at ingest against the posted body - so the runtime holds **no long-lived secret**,
and a token leaked from a microVM only writes its own session's telemetry, never another
tenant's. The agent's `run_bash` also gets an explicit allow-listed environment (its own
`config.env` + PATH/HOME), NEVER the runtime's `process.env`. **But note the bash env-fence is
not the whole story: `cat /proc/1/environ` from `run_bash` still exposes PID 1's full env**
(verified on prod). So the real invariant is **never put a secret in the runtime's process
env** - `INGEST_URL` / gateway URLs are fine to leak, but the ingest auth is a per-session
token held in a module variable (from the invoke payload), never env, and AWS creds arrive via
MMDS, never env. There is nothing secret in the env for `/proc/1/environ` to reveal. See
docs/deployment.md.

## Files

- `server.ts` - the AgentCore entrypoint (`BedrockAgentCoreApp`). Owns the single warm
  Agent, the `working` flag, and the async turn lifecycle.
- `agent.ts` - composes the agent: model, tools, injection plugin, and the system prompt via
  `composeSystemPrompt` from `@agency/shared`'s prompt module (the single source of truth for
  the platform harness prompt - the web UI renders the same blocks so a creator previews the
  exact full prompt their agent runs with).
- `model.ts` - the model factory (see docs/models.md).
- `tools.ts` - the base coding toolset (read/write/edit/bash) over a single working
  directory (path-traversal-guarded); tools return `{ error, hint }` and never throw.
- `time-tool.ts` - `get_current_time` (current UTC date/time). Always on (every agent needs
  a clock; inputless + side-effect-free, so no toggle gates it); the base prompt tells the
  agent to use it for anything date-relevant.
- `web-tools.ts` - web access, wired only when `webSearch && networkAccess`: `fetch_webpage`
  (keyless outbound HTTPS + HTML→text, SSRF-guarded) and `web_search` (the AWS-managed
  AgentCore Web Search connector via a shared MCP Gateway, SigV4-signed - keyless; requires
  `WEB_SEARCH_GATEWAY_URL`). The managed web-search connector is **us-east-1-only**, so its
  gateway lives in the us-east-1 `AgencyWebSearch` stack and the eu-north-1 public runtime
  reaches it **cross-region** - the gateway client is signed to `WEB_SEARCH_REGION`
  (default us-east-1), not the run region, exactly like the Mantle path. So `web_search` is
  wired whenever `WEB_SEARCH_GATEWAY_URL` is set (the control-plane sets it on the public
  runtime only); locally it's unset and only `fetch_webpage` is wired.
- `integration-tools.ts` - downstream-API integration tools, wired only when the invoke
  payload carries resolved integrations: `list_integration_operations` (discovery - reads the
  in-memory manifest that rode the payload, so the model learns which operations it CAN call)
  and `call_integration` (POSTs to the control-plane proxy `/internal/integrations/call` via
  the same per-session ingest token). The credential + `baseUrl` never reach the runtime - the
  proxy authorizes the call against the token's grant, injects the secret, and forwards only to
  the stored base URL. `call_integration` also takes an optional `outputPath`: the response body
  is written to that workspace file (confined by the shared `sandboxed()` from tools.ts) instead
  of returned into context, so the agent can fetch a dataset and compute over it with `run_bash`
  - the load-bearing pattern for a code agent (the prompt teaches when to use it). Works in ANY
  network mode (the proxy is reachable via PrivateLink when isolated). See docs/integrations.md.
- `mailbox.ts` - mid-turn injection (see docs/injection.md).
- `run.ts` - walks the Strands stream and POSTs each event to the ingest API.
- `trajectory.ts` - builds trajectory events (UUIDv7-keyed) and posts them via `ingest.ts`.
- `ingest.ts` - best-effort HTTP client for the control-plane telemetry ingest API (the
  runtime writes no DynamoDB directly). `postIngestRaw` (used by the integration tools) also
  surfaces the response body so a proxied call's result can be handed back to the model.
- `config.ts` - runtime env config (ingest URL, region, web-search gateway URL +
  `WEB_SEARCH_REGION` (default us-east-1, the region the gateway client signs to); the
  per-session ingest token arrives in the invoke payload, not env - the runtime holds no
  ingest key).

## Network mode (public vs isolated)

The same image runs on a small pool of runtimes, one per network posture (see
docs/deployment.md for the infra):

- **`public`** (default): the runtime has outbound internet. Web tools (`web_search` +
  `fetch_webpage`) are available when `webSearch` is on.
- **`isolated`**: the runtime is placed in a VPC with **no public egress** (no IGW/NAT). It
  reaches AWS only through PrivateLink - `bedrock-runtime` (Anthropic) for model inference, the
  `bedrock-agentcore` data-plane endpoint (the microVM's own invocation/identity plumbing),
  plus logs/ecr/s3 + `execute-api` (the private ingest API for telemetry - no DynamoDB, the
  runtime role has no table access). So web search, fetch, and `run_bash` curl all genuinely
  fail - isolation is at the network, not just un-wired tools. **Region caveat:** there is no
  `bedrock-mantle` PrivateLink endpoint (Mantle is us-east-1-only, no cross-region PrivateLink),
  so **OpenAI models don't work in isolated mode** - only Anthropic. Public-mode agents reach
  Mantle cross-region over egress. `agent.ts` prepends `ISOLATED_PROMPT` (from `@agency/shared`'s prompt module) telling the model
  there's no internet so it doesn't waste turns trying.

The control-plane picks the runtime by `config.networkMode` at invoke; the runtime just reads
the config off the payload. `normalizeConfig` (control-plane) forces `webSearch` +
`networkAccess` off in isolated mode, so the runtime never even tries to wire web tools there.
The Dockerfile bakes in `tsx` (the entrypoint runner) so a no-egress microVM never tries to
download it at container start.

## Session model

- AgentCore runs each `runtimeSessionId` in its own isolated microVM, so this process only
  ever serves one session. We keep the built `Agent` warm (a single module-level variable)
  so follow-up messages continue the same conversation - the history lives in the Agent's
  memory for the microVM's lifetime.
- Invocations are **fire-and-forget**: the handler returns `{ status, sessionId }`
  immediately and runs the turn via `app.asyncTask`, which reports `HealthyBusy` on `/ping`
  so AgentCore keeps the session alive while the turn runs.
- A message arriving while a session is working is injected (docs/injection.md); otherwise
  it starts a fresh turn. Messages that arrive too late to be injected into a finishing turn
  are re-dispatched as follow-up turns on the same warm agent. On a turn error the warm
  agent is dropped (before the error is recorded) so a half-formed message list can't poison
  future turns; both terminal writes (`session_end`/`error`) are best-effort.

## Per-turn budget

Nothing else bounds one invocation: there is no rate limit and no concurrency cap, and a
microVM lives up to 8h - so a tool-looping model could hold a billable session for hours and
accrue unbounded model cost. `runAgentTurn` therefore passes caps to `agent.stream`:

| Env var | Default | Bounds |
|---|---|---|
| `MAX_TURNS_PER_INVOCATION` | 60 | model-call-plus-tools iterations (`limits.turns`) |
| `MAX_TOKENS_PER_INVOCATION` | 2,000,000 | cumulative input + output (`limits.totalTokens`) |
| `INVOCATION_DEADLINE_MS` | 1,800,000 (30 min) | wall-clock, via `cancelSignal` |

Deliberately generous - a real coding task takes many turns - but finite. Set any to `0` to
disable that dimension. A value outside `0..2^31-1` warns and falls back to the default:
that's Node's `setTimeout` maximum (~24.9 days), which `AbortSignal.timeout` uses. The bound
is the *usable* ceiling, not the throwing one - past 2^32-1 it raises a `RangeError`, but
anything past 2^31-1 silently **clamps to 1 ms**, so an over-large deadline would abort every
turn instantly instead of being rejected. Either way the shared runtime is bricked.

Caps are checked at a **turn boundary** and are **per-invocation**, not cumulative over the
microVM's lifetime - a warm agent's second turn starts with a fresh allowance and a fresh
deadline, so a long conversation isn't penalised for its history. That is deliberate (it's
what lets a capped run be continued) but it means the budget is **not a spend cap**: a client
that keeps invoking, or keeps injecting into a live session, gets a fresh allowance each time,
so one microVM can spend a multiple of these numbers over its lifetime. What the budget stops
is a runaway *loop*; bounding a caller needs the rate limit / concurrency cap that is still
deferred (see CLAUDE.md).

The SDK **returns** a `limit*`/`cancelled` stop reason rather than throwing, and `for await`
discards a generator's return value - so `runAgentTurn` reads the stop reason off the terminal
`agentResultEvent` and `budgetTripMessage` maps a trip to a thrown error. The run therefore
ends as an `error` naming the cap it hit, rather than a success with a blank answer: an
operator sees why it stopped, and the error rate moves so the caps are tunable. Because the
cap lands at a turn boundary, `agent.messages` stays reinvokable - the session can continue.

## Trajectory

`run.ts` records `session_start`, `text`, `tool_input` (with inputs), `tool_result`,
`injected`, `session_end`, and `error` events. The runtime generates each event's UUIDv7
cursor (preserving write order) and POSTs it to the ingest API; the control-plane persists it
as a DynamoDB item keyed by (sessionId, cursor). This is the single source of truth the poll
API reads from.
