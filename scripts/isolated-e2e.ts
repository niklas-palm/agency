/**
 * Isolated network-mode E2E (deployed only). Proves the "no public internet,
 * Bedrock-private-only" runtime works end to end:
 *   1. Anthropic turn completes  → bedrock-runtime reachable privately.
 *   2. OpenAI is REFUSED at create → Mantle is us-east-1-only, unreachable from
 *      the isolated VPC (no cross-region PrivateLink), so isolated + an OpenAI
 *      model is rejected with 400 (isModelAllowedInNetworkMode).
 *   3. run_bash curl to the internet FAILS → public egress is truly cut.
 *   4. Config coupling holds: webSearch/networkAccess forced off.
 *
 * Usage: API_URL=<api> TOKEN=<pat-or-m2m> npx tsx scripts/isolated-e2e.ts
 */
const API = process.env.API_URL;
const TOKEN = process.env.TOKEN;
if (!API || !TOKEN) {
  console.error("set API_URL and TOKEN");
  process.exit(1);
}

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`✅ ${msg}`);
  } else {
    console.error(`❌ ASSERT FAILED: ${msg}`);
    failures++;
  }
}

async function mgmt(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

interface PollEvent { type: string; content?: string; error?: string }

/** Invoke with a fresh session, poll to terminal, return the events + final text. */
async function runTurn(agentId: string, apiKey: string, prompt: string): Promise<{ events: PollEvent[]; finalText: string }> {
  const invRes = await fetch(`${API}/agents/${agentId}/invoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const inv = (await invRes.json()) as { sessionId: string; status: string };
  const sessionId = inv.sessionId;
  const events: PollEvent[] = [];
  let cursor: string | null = null;
  let finalText = "";
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const url = `${API}/agents/${agentId}/sessions/${sessionId}${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const body = (await res.json()) as { status: string; events: (PollEvent & { cursor: string })[]; cursor: string | null };
    for (const e of body.events) {
      events.push(e);
      if (e.type === "text" || e.type === "session_end") finalText = e.content ?? finalText;
    }
    if (body.cursor) cursor = body.cursor;
    if (body.status === "idle") break;
  }
  return { events, finalText };
}

async function makeAgent(name: string, model: string): Promise<{ id: string; apiKey: string; config: Record<string, unknown> }> {
  const res = await mgmt("POST", "/agents", {
    name,
    systemPrompt: "You are a terse assistant. Answer in one short line.",
    model,
    baseTools: true, // for the egress test (run_bash)
    webSearch: true, // deliberately try to enable - must be forced off
    networkAccess: true, // ditto
    networkMode: "isolated",
    triggers: [{ type: "api" }],
  });
  assert(res.status === 201, `create isolated agent (${model}) → 201 (got ${res.status})`);
  // The one-time key is the TOP-LEVEL CreateAgentResponse.apiKey. It is never served
  // on a read, so this reply is the only place to capture it.
  const j = (await res.json()) as { agent: { id: string; config: Record<string, unknown> }; apiKey: string };
  return { id: j.agent.id, apiKey: j.apiKey, config: j.agent.config };
}

async function main(): Promise<void> {
  // ---- Anthropic on the isolated runtime -------------------------------------
  const anthropic = await makeAgent("iso-anthropic", "haiku-4.5");
  assert(anthropic.config.networkMode === "isolated", "config.networkMode is isolated");
  assert(anthropic.config.webSearch === false, "webSearch forced OFF in isolated mode");
  assert(anthropic.config.networkAccess === false, "networkAccess forced OFF in isolated mode");

  const a = await runTurn(anthropic.id, anthropic.apiKey, "Reply with exactly: anthropic-private-ok");
  assert(a.events.some((e) => e.type === "session_end"), "Anthropic isolated turn reached session_end (Bedrock reachable privately)");
  assert(!a.events.some((e) => e.type === "error"), "Anthropic isolated turn had no error event");
  console.log(`   anthropic answer: ${a.finalText.slice(0, 80)}`);

  // ---- OpenAI (Mantle) is REFUSED in isolated mode ---------------------------
  // Mantle is us-east-1-only and the isolated VPC has no cross-region PrivateLink,
  // so creating an isolated agent on an OpenAI model must be rejected at create.
  const openaiRes = await mgmt("POST", "/agents", {
    name: "iso-openai",
    systemPrompt: "unused",
    model: "gpt-5.6-terra",
    baseTools: false,
    webSearch: false,
    networkAccess: false,
    networkMode: "isolated",
    triggers: [{ type: "api" }],
  });
  assert(openaiRes.status === 400, `OpenAI + isolated is refused at create → 400 (got ${openaiRes.status})`);

  // ---- Egress cut: run_bash cannot reach the internet ------------------------
  // Ask the agent to curl a public URL with a short timeout and report the outcome.
  const egress = await runTurn(
    anthropic.id,
    anthropic.apiKey,
    "Run this exact bash command and tell me literally whether it succeeded or failed: " +
      "curl -s -m 8 -o /dev/null -w '%{http_code}' https://example.com ; echo \" exit=$?\". " +
      "Report the exit code you observed.",
  );
  const egressText = egress.finalText.toLowerCase();
  // A cut network shows as a nonzero curl exit (e.g. exit=28 timeout / 6 DNS / 7 connect).
  const looksBlocked = /exit=(6|7|28|35|56)|fail|timed out|could not|unable|no route|couldn't/.test(egressText);
  const looksConnected = /exit=0|\b200\b/.test(egressText);
  assert(looksBlocked && !looksConnected, `public egress is CUT for run_bash (agent reported: "${egress.finalText.slice(0, 120)}")`);

  // ---- Cleanup ----------------------------------------------------------------
  // Only the Anthropic agent was created (the OpenAI create was refused by design).
  const del = await mgmt("DELETE", `/agents/${anthropic.id}`);
  assert(del.status === 204, `deleted ${anthropic.id} → 204 (got ${del.status})`);

  if (failures) {
    console.error(`\n❌ ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n🎉 ISOLATED E2E PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
