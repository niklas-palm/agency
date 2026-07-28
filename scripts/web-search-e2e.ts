/**
 * End-to-end test of the web tools (deployed stack only - web search needs the
 * AgentCore gateway). Creates an agent with webSearch on, asks a question that
 * requires current external info, and asserts the trajectory shows a web tool
 * call (web_search or fetch_webpage) and a final answer.
 */
import type { CreateAgentResponse, InvokeResponse, PollResponse, TrajectoryEvent } from "@agency/shared";

const API_URL = process.env.API_URL;
const TOKEN = process.env.TOKEN;
if (!API_URL || !TOKEN) {
  console.error("web-search-e2e requires API_URL + TOKEN (deployed stack only)");
  process.exit(1);
}
const mgmt = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`❌ ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ ${msg}`);
}

async function main(): Promise<void> {
  const createRes = await fetch(`${API_URL}/agents`, {
    method: "POST",
    headers: mgmt,
    body: JSON.stringify({
      name: "web-e2e",
      systemPrompt:
        "You are a research assistant. When a question needs current or external facts, " +
        "use web_search to find sources and fetch_webpage to read them, then answer with what you found.",
      model: "haiku-4.5",
      baseTools: true,
      webSearch: true,
      networkAccess: true,
    }),
  });
  assert(createRes.status === 201, `create returns 201 (got ${createRes.status})`);
  const { agent, apiKey } = (await createRes.json()) as CreateAgentResponse;
  const invokeHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

  // A prompt that clearly requires the live web.
  const body = JSON.stringify({
    prompt: "Search the web for who won the most recent FIFA World Cup and what year, then tell me. Cite the URL you used.",
  });
  let invoke: InvokeResponse | null = null;
  for (let attempt = 0; attempt < 20 && !invoke; attempt++) {
    const r = await fetch(agent.invokeUrl, { method: "POST", headers: invokeHeaders, body });
    if (r.status === 200) invoke = (await r.json()) as InvokeResponse;
    else {
      if (attempt === 0) console.log("   waiting for runtime READY…");
      await sleep(15000);
    }
  }
  assert(invoke !== null, "invoke eventually returns 200");
  const sessionId = invoke!.sessionId;

  const seen: TrajectoryEvent[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1500);
    const url = new URL(`${API_URL}/agents/${agent.id}/sessions/${sessionId}`);
    if (cursor) url.searchParams.set("after", cursor);
    const poll = (await (await fetch(url, { headers: invokeHeaders })).json()) as PollResponse;
    for (const ev of poll.events) seen.push(ev);
    if (poll.cursor) cursor = poll.cursor;
    if (poll.events.length) {
      console.log(`   [poll ${i}] ${poll.status}: ${poll.events.map((e) => `${e.type}${e.toolName ? `(${e.toolName})` : ""}`).join(", ")}`);
    }
    if (poll.status === "idle" && seen.some((e) => e.type === "session_end")) break;
  }

  const toolCalls = seen.filter((e) => e.type === "tool_input").map((e) => e.toolName ?? "");
  console.log(`   tool calls: ${toolCalls.join(", ") || "(none)"}`);
  // The AWS-managed web search surfaces as the MCP tool `web-search___WebSearch`;
  // the self-built fetch is `fetch_webpage`. Accept either.
  assert(
    toolCalls.some((t) => /web.?search/i.test(t) || t === "fetch_webpage"),
    `trajectory shows a web tool call - got [${toolCalls.join(", ")}]`,
  );
  assert(seen.some((e) => e.type === "session_end"), "session reaches session_end");

  const answer = seen.filter((e) => e.type === "session_end").pop()?.content ?? "";
  console.log(`\n📝 answer:\n${answer}\n`);
  console.log("🎉 WEB SEARCH E2E PASSED");
}

main().catch((err) => {
  console.error("web-search-e2e crashed:", err);
  process.exit(1);
});
