/**
 * E2E across every supported model: create one agent per model, invoke a simple
 * deterministic prompt, poll until done, and assert it produced a final answer.
 * Runs against a running stack (local docker-compose by default, or a deployed
 * API via API_URL + TOKEN). Exits non-zero if any model fails.
 */
import type { CreateAgentResponse, InvokeResponse, PollResponse } from "@agency/shared";
import { MODEL_KEYS } from "@agency/shared";

const API_URL = process.env.API_URL ?? "http://localhost:8787";
const TOKEN = process.env.TOKEN ?? "";
const mgmt: Record<string, string> = {
  "Content-Type": "application/json",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function testModel(model: string): Promise<void> {
  const create = await fetch(`${API_URL}/agents`, {
    method: "POST",
    headers: mgmt,
    body: JSON.stringify({
      name: `model-check-${model}`,
      systemPrompt: "You are terse. Answer in one short sentence.",
      model,
      baseTools: false,
    }),
  });
  if (create.status !== 201) throw new Error(`create failed ${create.status}: ${await create.text()}`);
  const { agent, apiKey } = (await create.json()) as CreateAgentResponse;
  const keyHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

  try {
    // Invoke (retry until the runtime is READY - instant locally, ~1-2 min on AWS).
    let invoke: InvokeResponse | null = null;
    for (let i = 0; i < 20 && !invoke; i++) {
      const r = await fetch(agent.invokeUrl, {
        method: "POST",
        headers: keyHeaders,
        body: JSON.stringify({ prompt: "Reply with exactly: MODEL OK" }),
      });
      if (r.status === 200) invoke = (await r.json()) as InvokeResponse;
      else await sleep(15000);
    }
    if (!invoke) throw new Error("invoke never succeeded (runtime not READY)");

    // Poll until idle with a final answer.
    for (let i = 0; i < 60; i++) {
      await sleep(1500);
      const r = await fetch(`${API_URL}/agents/${agent.id}/sessions/${invoke.sessionId}`, {
        headers: keyHeaders,
      });
      const poll = (await r.json()) as PollResponse;
      const end = poll.events.find((e) => e.type === "session_end");
      const err = poll.events.find((e) => e.type === "error");
      if (err) throw new Error(`agent errored: ${err.error}`);
      if (end) {
        if (!end.content?.trim()) throw new Error("session_end had no answer");
        console.log(`✅ ${model} → "${end.content.trim().slice(0, 60)}"`);
        return;
      }
      if (poll.status === "idle" && i > 2) throw new Error("went idle with no session_end");
    }
    throw new Error("timed out waiting for completion");
  } finally {
    // Tear down the runtime + record so repeated runs don't accumulate agents.
    await fetch(`${API_URL}/agents/${agent.id}`, { method: "DELETE", headers: mgmt });
  }
}

async function main(): Promise<void> {
  console.log(`Testing ${MODEL_KEYS.length} models against ${API_URL}\n`);
  // Sequential, not parallel: AgentCore gives each session its own microVM, but
  // the LOCAL docker-compose runtime is a single shared process (one session at a
  // time). Running one model at a time mirrors the prod one-session-per-microVM
  // guarantee and keeps the local harness faithful.
  let failed = 0;
  for (const model of MODEL_KEYS) {
    try {
      await testModel(model);
    } catch (e) {
      failed++;
      console.error(`❌ ${model} → ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failed) {
    console.error(`\n${failed}/${MODEL_KEYS.length} models FAILED`);
    process.exit(1);
  }
  console.log(`\n🎉 all ${MODEL_KEYS.length} models passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
