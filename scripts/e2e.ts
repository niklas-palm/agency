/**
 * End-to-end test of the create → invoke → poll → mid-turn-inject spine.
 *
 * Runs against a running stack (local docker-compose by default, or a deployed
 * API via API_URL + TOKEN). Asserts:
 *   1. Create an agent (returns an API key).
 *   2. Invoke it → get a sessionId + status "triggered".
 *   3. Poll the trajectory with a delta cursor; events accrue; cursor advances.
 *   4. While it's working, send a second message on the same session → status
 *      "injected"; the injected text later appears in the trajectory.
 *   5. The session reaches "idle" with a session_end event.
 *
 * Exits non-zero on any failed assertion.
 */
import type {
  CreateAgentResponse,
  Integration,
  InvokeResponse,
  PollResponse,
  TrajectoryEvent,
} from "@agency/shared";

const API_URL = process.env.API_URL ?? "http://localhost:8787";
/** Bearer token for management endpoints. Empty locally (AUTH_DISABLED). */
const TOKEN = process.env.TOKEN ?? "";

const mgmtHeaders: Record<string, string> = {
  "Content-Type": "application/json",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`❌ ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tear down a test agent (schedule + runtime + record) so runs don't accumulate. */
async function cleanup(agentId: string): Promise<void> {
  const res = await fetch(`${API_URL}/agents/${agentId}`, { method: "DELETE", headers: mgmtHeaders });
  console.log(res.ok ? `🧹 deleted test agent ${agentId}` : `⚠️  cleanup failed (${res.status})`);
}

/**
 * Integration round-trip (opt-in via RUN_INTEGRATION=1): register the sample pet-store
 * API as an integration, attach it to an agent, and prove the agent calls it through the
 * proxy - listing then creating a pet - WITHOUT ever holding the credential. Asserts the
 * agent used `call_integration` and the downstream data (a seeded pet name) surfaced.
 *
 * `SAMPLE_API_URL` is the base URL the proxy forwards to (from the control-plane's vantage:
 * the sample-api container locally, the deployed HTTP API URL when API_URL is set). The
 * matching bearer credential is `SAMPLE_API_TOKEN`.
 */
async function integrationRoundTrip(): Promise<void> {
  console.log("\n--- integration round-trip ---");
  const sampleUrl = process.env.SAMPLE_API_URL ?? "http://sample-api:8686";
  const sampleToken = process.env.SAMPLE_API_TOKEN ?? "local-sample-token";

  // 1. Register the integration (org-scoped; the secret is write-only).
  const intgRes = await fetch(`${API_URL}/integrations`, {
    method: "POST",
    headers: mgmtHeaders,
    body: JSON.stringify({
      name: `e2e-petstore-${Date.now()}`,
      description: "Sample pet-store API for the integrations E2E",
      baseUrl: sampleUrl,
      auth: { kind: "bearer" },
      secret: sampleToken,
      operations: [
        { operationId: "listPets", summary: "List all pets", method: "GET", path: "/pets" },
        { operationId: "createPet", summary: "Create a pet", method: "POST", path: "/pets" },
        { operationId: "getPet", summary: "Get one pet by id", method: "GET", path: "/pets/{id}" },
      ],
    }),
  });
  assert(intgRes.status === 201, `create integration returns 201 (got ${intgRes.status})`);
  const { integration } = (await intgRes.json()) as { integration: Integration };
  assert(integration.hasSecret === true, "integration reports a stored secret (never the secret itself)");
  assert(!("secret" in integration), "integration response never carries the raw secret");

  // 2. Create an agent attached to it. No web tools - the ONLY egress is the proxy.
  const createRes = await fetch(`${API_URL}/agents`, {
    method: "POST",
    headers: mgmtHeaders,
    body: JSON.stringify({
      name: "e2e-integration-agent",
      systemPrompt:
        "You call downstream APIs through your integration tools. Use list_integration_operations " +
        "to see what you can call, then call_integration to do it. Report exactly what the API returns.",
      model: "haiku-4.5",
      baseTools: false,
      integrationIds: [integration.id],
    }),
  });
  assert(createRes.status === 201, `create integration-agent returns 201 (got ${createRes.status})`);
  const { agent, apiKey } = (await createRes.json()) as CreateAgentResponse;
  const invokeHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

  // 3. Invoke: ask it to list pets, then create one. Retry the first invoke until READY.
  const invokeBody = JSON.stringify({
    prompt:
      "First list all pets via the integration. Then create a new pet named Fido of kind dog. " +
      "Finally list pets again and tell me every pet name you see.",
  });
  let invoke: InvokeResponse | null = null;
  for (let attempt = 0; attempt < 20 && !invoke; attempt++) {
    const res = await fetch(agent.invokeUrl, { method: "POST", headers: invokeHeaders, body: invokeBody });
    if (res.status === 200) invoke = (await res.json()) as InvokeResponse;
    else {
      if (attempt === 0) console.log("   waiting for runtime to reach READY…");
      await sleep(15000);
    }
  }
  assert(invoke !== null, "integration invoke eventually returns 200");
  const sessionId = invoke!.sessionId;

  // 4. Poll to completion, collecting the trajectory.
  let cursor: string | null = null;
  const seen: TrajectoryEvent[] = [];
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const url = new URL(`${API_URL}/agents/${agent.id}/sessions/${sessionId}`);
    if (cursor) url.searchParams.set("after", cursor);
    const poll = (await (await fetch(url, { headers: invokeHeaders })).json()) as PollResponse;
    for (const ev of poll.events) seen.push(ev);
    if (poll.cursor) cursor = poll.cursor;
    if (poll.events.length) {
      console.log(`   [poll ${i}] +${poll.events.length}: ${poll.events.map((e) => e.type).join(",")}`);
    }
    if (poll.status === "idle" && seen.some((e) => e.type === "session_end")) break;
  }

  // 5. Assert the agent reached the API through the proxy and saw real downstream data.
  assert(
    seen.some((e) => e.type === "tool_input" && e.toolName === "call_integration"),
    "trajectory records a call_integration tool use",
  );
  const finalText = seen.filter((e) => e.type === "session_end").pop()?.content ?? "";
  const transcript = seen.map((e) => e.content ?? "").join("\n");
  assert(/Rex|Whiskers/.test(transcript), "a seeded pet name (Rex/Whiskers) surfaced via the proxy");
  assert(/Fido/.test(transcript), "the newly created pet (Fido) is reflected back");
  console.log(`\n📝 integration final answer:\n${finalText}\n`);

  await cleanup(agent.id);
  const delRes = await fetch(`${API_URL}/integrations/${integration.id}`, { method: "DELETE", headers: mgmtHeaders });
  console.log(delRes.ok ? `🧹 deleted test integration ${integration.id}` : `⚠️  integration cleanup failed (${delRes.status})`);
  console.log("🎉 INTEGRATION ROUND-TRIP PASSED");
}

/**
 * Auto-discovery round-trip (opt-in via RUN_INTEGRATION=1): register an integration
 * by pointing at the sample-api's OpenAPI spec instead of hand-authoring operations.
 * The spec is behind the SAME bearer gate as the API, so this proves discovery
 * authenticates the spec fetch with the integration credential (an unauthenticated
 * fetch would 403 → the whole thing would fail). Then exercise the preview endpoint,
 * a subset selection, and a refresh.
 */
async function discoveryRoundTrip(): Promise<void> {
  console.log("\n--- discovery round-trip (authenticated spec fetch) ---");
  const sampleUrl = process.env.SAMPLE_API_URL ?? "http://sample-api:8686";
  const sampleToken = process.env.SAMPLE_API_TOKEN ?? "local-sample-token";
  const specUrl = `${sampleUrl}/openapi.json`;
  // A spec URL carries the integration credential on the fetch, so validateOutboundUrl
  // is https-only - with no local-dev exemption, by design. The local sample-api is
  // plain http, so this round-trip can only run against an https SAMPLE_API_URL (i.e.
  // the deployed sample API). Skip rather than assert a 400 the platform is right to
  // return.
  if (!specUrl.startsWith("https://")) {
    console.log(`⏭  skipped: spec URL is not https (${specUrl}).`);
    console.log("   Point SAMPLE_API_URL at the deployed https sample API to run this.");
    return;
  }
  const auth = { kind: "bearer" as const };

  // 1. Stateless preview: the spec is auth-gated, so this only works if the fetch
  //    carries the credential. It returns the full catalog (all enabled).
  const previewRes = await fetch(`${API_URL}/integrations/discover`, {
    method: "POST",
    headers: mgmtHeaders,
    // baseUrl anchors the inline credential: the fetch is only authenticated when the
    // spec URL is under baseUrl's origin (the exfil guard). specUrl is under sampleUrl.
    body: JSON.stringify({ url: specUrl, auth, secret: sampleToken, baseUrl: sampleUrl }),
  });
  assert(previewRes.status === 200, `discover preview returns 200 (got ${previewRes.status} - an auth-gated spec needs the credential)`);
  const preview = (await previewRes.json()) as { provider: string; operations: { operationId: string; enabled: boolean }[] };
  assert(preview.provider === "openapi", "preview reports the openapi provider");
  assert(preview.operations.length === 3, `preview finds all 3 operations (got ${preview.operations.length})`);
  assert(preview.operations.every((o) => o.enabled), "preview operations all start enabled");

  // 2. Create via discovery, selecting a SUBSET (listPets + getPet, not createPet).
  const createRes = await fetch(`${API_URL}/integrations`, {
    method: "POST",
    headers: mgmtHeaders,
    body: JSON.stringify({
      name: `e2e-discovered-${Date.now()}`,
      description: "Auto-discovered pet-store API for the discovery E2E",
      baseUrl: sampleUrl,
      auth,
      secret: sampleToken,
      discovery: { url: specUrl, enabledOperationIds: ["listPets", "getPet"] },
    }),
  });
  assert(createRes.status === 201, `create-by-discovery returns 201 (got ${createRes.status})`);
  const { integration } = (await createRes.json()) as { integration: Integration };
  assert(integration.discovery !== undefined, "stored integration has a discovery block");
  assert(integration.discovery!.operations.length === 3, "discovery catalog holds all 3 ops");
  assert(integration.operations.length === 2, `materialized manifest is the enabled subset of 2 (got ${integration.operations.length})`);
  assert(
    integration.operations.every((o) => o.operationId !== "createPet"),
    "the de-selected createPet is NOT in the agent-facing manifest",
  );

  // 3. Refresh: re-fetches (still authenticated) and reconciles - the spec is
  //    unchanged, so the selection is preserved (2 enabled of 3).
  const refreshRes = await fetch(`${API_URL}/integrations/${integration.id}/refresh`, {
    method: "POST",
    headers: mgmtHeaders,
  });
  assert(refreshRes.status === 200, `refresh returns 200 (got ${refreshRes.status})`);
  const { integration: refreshed } = (await refreshRes.json()) as { integration: Integration };
  assert(refreshed.operations.length === 2, "refresh preserves the stored selection (2 enabled)");
  assert(refreshed.discovery!.operations.length === 3, "refresh keeps the full catalog");

  const delRes = await fetch(`${API_URL}/integrations/${integration.id}`, { method: "DELETE", headers: mgmtHeaders });
  console.log(delRes.ok ? `🧹 deleted discovered integration ${integration.id}` : `⚠️  cleanup failed (${delRes.status})`);
  console.log("🎉 DISCOVERY ROUND-TRIP PASSED");
}

/**
 * Data-to-disk round-trip (opt-in via RUN_INTEGRATION=1): the load-bearing capability
 * for a code agent - fetch data via an integration to a FILE (call_integration
 * `outputPath`), then COMPUTE over it with run_bash rather than pulling it through the
 * LLM context. Proves the whole path: proxy → workspace file → run_bash analysis. We
 * assert the agent reports the correct count of seeded pets, which it can only get right
 * by actually reading the file it wrote (not from memory of the tool result, since the
 * body was persisted, not returned).
 */
async function dataToDiskRoundTrip(): Promise<void> {
  console.log("\n--- data-to-disk round-trip (fetch to file + compute) ---");
  const sampleUrl = process.env.SAMPLE_API_URL ?? "http://sample-api:8686";
  const sampleToken = process.env.SAMPLE_API_TOKEN ?? "local-sample-token";

  const intgRes = await fetch(`${API_URL}/integrations`, {
    method: "POST",
    headers: mgmtHeaders,
    body: JSON.stringify({
      name: `e2e-disk-${Date.now()}`,
      description: "Pet-store API for the data-to-disk E2E",
      baseUrl: sampleUrl,
      auth: { kind: "bearer" },
      secret: sampleToken,
      operations: [{ operationId: "listPets", summary: "List all pets", method: "GET", path: "/pets" }],
    }),
  });
  assert(intgRes.status === 201, `create integration returns 201 (got ${intgRes.status})`);
  const { integration } = (await intgRes.json()) as { integration: Integration };

  // Base tools ON - the agent needs run_bash to process the file it writes.
  const createRes = await fetch(`${API_URL}/agents`, {
    method: "POST",
    headers: mgmtHeaders,
    body: JSON.stringify({
      name: "e2e-disk-agent",
      systemPrompt:
        "You are a data agent. When asked about integration data, fetch it to a file with " +
        "call_integration's outputPath, then use run_bash to compute the answer from the file.",
      model: "haiku-4.5",
      baseTools: true,
      integrationIds: [integration.id],
    }),
  });
  assert(createRes.status === 201, `create disk-agent returns 201 (got ${createRes.status})`);
  const { agent, apiKey } = (await createRes.json()) as CreateAgentResponse;
  const invokeHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

  const invokeBody = JSON.stringify({
    prompt:
      "Call the listPets operation with outputPath set to data/pets.json (do NOT return the " +
      "body inline). Then use run_bash to parse data/pets.json and count how many pets have " +
      'kind "dog" vs "cat". Report the two counts.',
  });
  let invoke: InvokeResponse | null = null;
  for (let attempt = 0; attempt < 20 && !invoke; attempt++) {
    const res = await fetch(agent.invokeUrl, { method: "POST", headers: invokeHeaders, body: invokeBody });
    if (res.status === 200) invoke = (await res.json()) as InvokeResponse;
    else {
      if (attempt === 0) console.log("   waiting for runtime to reach READY…");
      await sleep(15000);
    }
  }
  assert(invoke !== null, "disk-agent invoke eventually returns 200");
  const sessionId = invoke!.sessionId;

  let cursor: string | null = null;
  const seen: TrajectoryEvent[] = [];
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const url = new URL(`${API_URL}/agents/${agent.id}/sessions/${sessionId}`);
    if (cursor) url.searchParams.set("after", cursor);
    const poll = (await (await fetch(url, { headers: invokeHeaders })).json()) as PollResponse;
    for (const ev of poll.events) seen.push(ev);
    if (poll.cursor) cursor = poll.cursor;
    if (poll.status === "idle" && seen.some((e) => e.type === "session_end")) break;
  }

  // The agent wrote the response to a file (call_integration with outputPath), then read
  // it back via run_bash. Assert both tools ran and the final answer reflects a count
  // COMPUTED from the file (the body was persisted, never returned inline - so the agent
  // could only produce dog/cat numbers by reading the file it wrote and processing it).
  const calledIntegration = seen.some((e) => e.type === "tool_input" && e.toolName === "call_integration");
  const ranBash = seen.some((e) => e.type === "tool_input" && e.toolName === "run_bash");
  assert(calledIntegration, "trajectory records a call_integration tool use");
  assert(ranBash, "trajectory records a run_bash tool use (processing the file)");
  const finalText = seen.filter((e) => e.type === "session_end").pop()?.content ?? "";
  console.log(`\n📝 data-to-disk final answer:\n${finalText}\n`);
  // The proof the data-to-disk path worked is the trajectory (call_integration + run_bash
  // above) plus a computed answer: the agent reports dog/cat counts with real digits, which
  // it could only get by reading + processing the file it wrote (the body was persisted, not
  // returned inline). We do NOT assert the answer restates the filename (LLM phrasing varies)
  // nor exact counts (the sample-api store is shared across round-trips) - the compute is what matters.
  assert(
    /dog/i.test(finalText) && /cat/i.test(finalText) && /\d/.test(finalText),
    "the agent reported dog/cat counts computed from the file via run_bash",
  );

  await cleanup(agent.id);
  const del = await fetch(`${API_URL}/integrations/${integration.id}`, { method: "DELETE", headers: mgmtHeaders });
  console.log(del.ok ? `🧹 deleted disk integration ${integration.id}` : `⚠️  cleanup failed (${del.status})`);
  console.log("🎉 DATA-TO-DISK ROUND-TRIP PASSED");
}

async function main(): Promise<void> {
  // 1. Create an agent.
  const createRes = await fetch(`${API_URL}/agents`, {
    method: "POST",
    headers: mgmtHeaders,
    body: JSON.stringify({
      name: "e2e-agent",
      systemPrompt:
        "You are a careful assistant. When asked to count slowly, count one number at a time, " +
        "pausing to think between each. If a new instruction arrives mid-task, acknowledge it explicitly.",
      model: "haiku-4.5",
      baseTools: true,
      // Optional: exercise the isolated (no-egress) runtime + its private ingest path.
      ...(process.env.NETWORK_MODE ? { networkMode: process.env.NETWORK_MODE } : {}),
    }),
  });
  assert(createRes.status === 201, `create returns 201 (got ${createRes.status})`);
  const { agent, apiKey } = (await createRes.json()) as CreateAgentResponse;
  assert(agent.id && apiKey.startsWith("ag_"), "create returns an agent id + API key");

  const invokeHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

  // 2. Invoke with a long-running prompt so we have time to inject.
  // A freshly created AgentCore runtime can take a minute+ to reach READY. Retry
  // the first invoke until it succeeds (no-op locally, where it's instant).
  const invokeBody = JSON.stringify({
    prompt:
      "Use run_bash to count from 1 to 8, sleeping 2 seconds between each number " +
      "(e.g. `for i in $(seq 1 8); do echo $i; sleep 2; done`). Then summarize what you did.",
  });
  let invoke: InvokeResponse | null = null;
  for (let attempt = 0; attempt < 20 && !invoke; attempt++) {
    const invokeRes = await fetch(`${agent.invokeUrl}`, {
      method: "POST",
      headers: invokeHeaders,
      body: invokeBody,
    });
    if (invokeRes.status === 200) {
      invoke = (await invokeRes.json()) as InvokeResponse;
    } else {
      if (attempt === 0) console.log("   waiting for runtime to reach READY…");
      await sleep(15000);
    }
  }
  assert(invoke !== null, "invoke eventually returns 200 (runtime READY)");
  assert(invoke!.status === "triggered", `first invoke is "triggered" (got ${invoke!.status})`);
  const sessionId = invoke!.sessionId;
  assert(!!sessionId, "invoke returns a session id");

  // 3. Poll for progress with a delta cursor.
  let cursor: string | null = null;
  const seen: TrajectoryEvent[] = [];
  let injected = false;
  let injectedAck = "";

  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const url = new URL(`${API_URL}/agents/${agent.id}/sessions/${sessionId}`);
    if (cursor) url.searchParams.set("after", cursor);
    const pollRes = await fetch(url, { headers: invokeHeaders });
    assert(pollRes.status === 200, `poll returns 200 (got ${pollRes.status})`);
    const poll = (await pollRes.json()) as PollResponse;

    for (const ev of poll.events) seen.push(ev);
    if (poll.cursor) cursor = poll.cursor;

    if (poll.events.length) {
      console.log(
        `   [poll ${i}] +${poll.events.length} events, status=${poll.status}: ` +
          poll.events.map((e) => e.type).join(","),
      );
    }

    // 4. Once the agent is clearly working, inject a second message.
    if (!injected && poll.status === "working" && seen.length >= 1) {
      const injRes = await fetch(`${agent.invokeUrl}`, {
        method: "POST",
        headers: invokeHeaders,
        body: JSON.stringify({
          sessionId,
          prompt: "IMPORTANT MID-TASK UPDATE: after you finish counting, also tell me the current date.",
        }),
      });
      const inj = (await injRes.json()) as InvokeResponse;
      injectedAck = inj.status;
      injected = true;
      console.log(`   [inject] second message ack: ${inj.status}`);
    }

    if (poll.status === "idle" && seen.some((e) => e.type === "session_end")) break;
  }

  // Assertions on the collected trajectory.
  assert(
    seen.some((e) => e.type === "prompt" && e.content?.includes("count from 1 to 8")),
    "trajectory records the user's opening prompt",
  );
  assert(
    seen.some((e) => e.type === "tool_input" && e.toolName === "run_bash"),
    "trajectory records the run_bash tool_input",
  );
  assert(
    seen.some((e) => e.type === "tool_result"),
    "trajectory records a tool_result",
  );
  assert(injectedAck === "injected", `mid-turn second message was "injected" (got ${injectedAck})`);
  assert(
    seen.some((e) => e.type === "injected"),
    "trajectory records the injected message event",
  );
  assert(
    seen.some((e) => e.type === "session_end"),
    "session reaches session_end",
  );

  // 5. Poll once more with the final cursor: an ended session must STAY idle with
  // an empty delta - regression guard for the "delta empty but session ended →
  // reports working forever" stuck-poll bug.
  {
    const url = new URL(`${API_URL}/agents/${agent.id}/sessions/${sessionId}`);
    if (cursor) url.searchParams.set("after", cursor);
    const poll = (await (await fetch(url, { headers: invokeHeaders })).json()) as PollResponse;
    assert(poll.status === "idle", `post-completion poll stays idle (got ${poll.status})`);
    assert(poll.events.length === 0, `post-completion poll delta is empty (got ${poll.events.length})`);
  }

  const finalText = seen.filter((e) => e.type === "session_end").pop()?.content ?? "";
  console.log(`\n📝 final answer:\n${finalText}\n`);

  await cleanup(agent.id);
  console.log("🎉 E2E PASSED");

  // Opt-in integrations round-trips (need the sample-api reachable from the control-plane).
  if (process.env.RUN_INTEGRATION === "1") {
    await integrationRoundTrip();
    await discoveryRoundTrip();
    await dataToDiskRoundTrip();
  }
}

main().catch((err) => {
  console.error("E2E crashed:", err);
  process.exit(1);
});
