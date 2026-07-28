/**
 * End-to-end test of the schedule trigger (deployed stack only).
 *
 * Asserts the control-plane provisions and tears down a real EventBridge
 * Scheduler schedule as an agent's `schedule` trigger is added and removed:
 *   1. Create an agent WITH a schedule trigger → an `af-<id>` schedule exists,
 *      targeting the trigger Lambda with the right { agentId } input.
 *   2. PATCH the agent to remove the schedule → the schedule is deleted.
 *   3. PATCH it back on → re-created (idempotent upsert).
 *
 * Requires AWS creds (reads EventBridge Scheduler directly) + API_URL + TOKEN.
 * The local stack uses a no-op scheduler, so this is a deployed-only check.
 */
import { SchedulerClient, GetScheduleCommand } from "@aws-sdk/client-scheduler";
import type { CreateAgentResponse, Agent } from "@agency/shared";

const API_URL = process.env.API_URL;
const TOKEN = process.env.TOKEN;
const REGION = process.env.AWS_REGION ?? "eu-north-1";
const GROUP = "agency";

if (!API_URL || !TOKEN) {
  console.error("schedule-e2e requires API_URL + TOKEN (deployed stack only)");
  process.exit(1);
}

const mgmt = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
const scheduler = new SchedulerClient({ region: REGION });

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`❌ ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ ${msg}`);
}

/** Fetch a schedule by agent id; returns null if it doesn't exist. */
async function getSchedule(agentId: string) {
  try {
    return await scheduler.send(new GetScheduleCommand({ Name: `af-${agentId}`, GroupName: GROUP }));
  } catch (err) {
    if ((err as { name?: string }).name === "ResourceNotFoundException") return null;
    throw err;
  }
}

async function patch(agentId: string, body: unknown): Promise<Agent> {
  const res = await fetch(`${API_URL}/agents/${agentId}`, {
    method: "PATCH",
    headers: mgmt,
    body: JSON.stringify(body),
  });
  assert(res.status === 200, `patch returns 200 (got ${res.status})`);
  return ((await res.json()) as { agent: Agent }).agent;
}

async function main(): Promise<void> {
  // 1. Create with a schedule trigger.
  const createRes = await fetch(`${API_URL}/agents`, {
    method: "POST",
    headers: mgmt,
    body: JSON.stringify({
      name: "sched-e2e",
      systemPrompt: "You run on a schedule.",
      model: "haiku-4.5",
      triggers: [
        { type: "api" },
        { type: "schedule", expression: "rate(1 hour)", prompt: "Scheduled tick." },
      ],
    }),
  });
  assert(createRes.status === 201, `create returns 201 (got ${createRes.status})`);
  const { agent } = (await createRes.json()) as CreateAgentResponse;
  const id = agent.id;

  const created = await getSchedule(id);
  assert(created !== null, "EventBridge schedule created for the agent");
  assert(created!.ScheduleExpression === "rate(1 hour)", `schedule has the right expression (got ${created!.ScheduleExpression})`);
  assert(
    (created!.Target?.Input ?? "").includes(id),
    "schedule target input carries the agentId",
  );

  // 2. Remove the schedule via PATCH (triggers = api only).
  await patch(id, { triggers: [{ type: "api" }] });
  await new Promise((r) => setTimeout(r, 2000)); // small settle
  assert((await getSchedule(id)) === null, "schedule deleted when the trigger is removed");

  // 3. Add it back (idempotent re-create).
  await patch(id, {
    triggers: [{ type: "api" }, { type: "schedule", expression: "cron(0 9 * * ? *)", prompt: "Daily." }],
  });
  const recreated = await getSchedule(id);
  assert(recreated !== null, "schedule re-created on re-add");
  assert(recreated!.ScheduleExpression === "cron(0 9 * * ? *)", "re-created schedule has the new expression");

  // 4. The cadence floor rejects sub-5-minute schedules (however expressed) with
  //    a 400 - the abusive expression must never reach EventBridge.
  for (const expression of ["rate(1 minute)", "cron(0-59 * * * ? *)", "cron(0/1 * * * ? *)"]) {
    const res = await fetch(`${API_URL}/agents/${id}`, {
      method: "PATCH",
      headers: mgmt,
      body: JSON.stringify({ triggers: [{ type: "api" }, { type: "schedule", expression, prompt: "x" }] }),
    });
    assert(res.status === 400, `rejects sub-floor schedule ${expression} with 400 (got ${res.status})`);
  }

  console.log("\n🎉 SCHEDULE E2E PASSED");
  console.log(`(note: agent ${id} + its schedule were left in place; delete out-of-band)`);
}

main().catch((err) => {
  console.error("schedule-e2e crashed:", err);
  process.exit(1);
});
