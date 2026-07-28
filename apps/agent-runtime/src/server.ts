/**
 * AgentCore runtime entrypoint.
 *
 * AgentCore isolates each session in its own microVM, so this process serves
 * exactly one session. State is therefore trivial: one warm Agent (kept across
 * turns so follow-ups continue the conversation) and one `working` flag.
 *
 * Invocations are fire-and-forget: the handler returns immediately and the turn
 * runs in the background while `/ping` reports HealthyBusy (via `app.asyncTask`)
 * so AgentCore keeps the microVM alive. A message that arrives while a turn is
 * running is injected into it (see mailbox.ts); otherwise it starts a new turn.
 *
 * A shared runtime backs many agents (prod + local alike; prod has a per-network-
 * mode pool), so agentId arrives in the invoke payload (the trajectory-write key).
 * sessionId comes from the AgentCore session context.
 */
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import type { Agent } from "@strands-agents/sdk";
import type { AgentConfig, ResolvedSkill, ResolvedIntegration, RuntimeAck } from "@agency/shared";
import { buildAgent } from "./agent.js";
import { runAgentTurn, budgetTripMessage } from "./run.js";
import { record } from "./trajectory.js";
import { setIngestToken, setIngestContext } from "./ingest.js";
import { enqueueMessage, takePending } from "./mailbox.js";
import {
  newAccumulator,
  sealTokens,
  accumulateTurn,
  recordInvocationDuration,
  writeSummary,
  type SessionAccumulator,
} from "./session-metrics.js";
import { assertLocalCredentials } from "./config.js";

// Local dev: fail fast if the shell's temporary AWS creds weren't passed in
// (no-op in prod, where AgentCore supplies the role's credentials).
assertLocalCredentials();

let agent: Agent | null = null;
let working = false;
/** The (agent, session) this warm agent belongs to (see the reset in `process`). */
let boundSessionId: string | null = null;
let boundAgentId: string | null = null;
/** Metric accumulator for the current session lifetime (one per microVM). */
let metrics: SessionAccumulator | null = null;

interface Payload {
  agentId?: string;
  config?: AgentConfig;
  version?: number;
  skills?: ResolvedSkill[];
  integrations?: ResolvedIntegration[];
  fromSlack?: boolean;
  sessionId?: string;
  prompt?: string;
  ingestToken?: string;
}

const app = new BedrockAgentCoreApp({
  config: {
    // AgentCore posts the payload as application/octet-stream; parse it as JSON.
    contentTypeParsers: [
      {
        contentType: "application/octet-stream",
        parseAs: "string",
        parser: (_req: unknown, body: string | Buffer, done: (err: Error | null, value?: unknown) => void) => {
          try {
            done(null, body ? JSON.parse(body.toString()) : {});
          } catch (err) {
            done(err as Error);
          }
        },
      },
    ],
  },
  invocationHandler: {
    process: async (payload, context): Promise<RuntimeAck> => {
      const body = (payload ?? {}) as Payload;
      // The CLIENT's session id, from the payload - NOT `context.sessionId`. AgentCore's
      // id is derived from (agentId, clientSessionId) so one agent can't route into
      // another's microVM, but telemetry has to be reported under the id the caller
      // polls, which is also what the ingest capability token is scoped to. Falls back
      // to the context id if a legacy payload omits it.
      const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : context.sessionId;
      const agentId = body.agentId || "";
      const config = body.config;
      const version = typeof body.version === "number" ? body.version : 1;
      const skills = Array.isArray(body.skills) ? body.skills : [];
      const integrations = Array.isArray(body.integrations) ? body.integrations : [];
      const fromSlack = body.fromSlack === true;
      const prompt = typeof body.prompt === "string" ? body.prompt : "";

      if (!agentId) throw new Error("missing 'agentId' in payload");
      if (!config) throw new Error("missing 'config' in payload");
      if (!prompt) throw new Error("missing 'prompt' in payload");

      // The per-session telemetry token rides the payload; set it so this turn's
      // trajectory/summary POSTs authenticate. Scoped to this (agentId, sessionId).
      if (typeof body.ingestToken === "string") setIngestToken(body.ingestToken);
      // Stamp the ids on ingest log lines, so a telemetry failure is traceable to
      // the agent + session it belongs to rather than just a path.
      setIngestContext(agentId, sessionId);

      // Turn in flight: inject rather than run concurrently. If the mailbox is
      // full (flood), report "rejected" instead of a false "injected" ack.
      if (working) {
        const accepted = enqueueMessage(prompt);
        if (accepted && metrics) {
          metrics.injections += 1; // count only real injections
          metrics.invocations += 1; // each accepted injection is an invocation
        }
        return { status: accepted ? "injected" : "rejected", sessionId };
      }

      // Bind to the (agent, session). In prod a microVM only ever serves one session,
      // so this is a one-time set. Locally the single shared container serves many
      // sessions sequentially, so when an idle runtime sees a NEW one we drop the
      // previous warm agent - reproducing the fresh-microVM semantics rather than
      // leaking one session's agent (and its model/history) into the next. A new
      // binding also starts a fresh metric accumulator (a new runtime lifetime → a
      // new summary row).
      //
      // AGENT is part of the key, not just session. The control-plane already derives
      // a per-agent AgentCore session id so two agents can't share a microVM - this
      // holds the same guarantee here, and is a second line of defence: without it an
      // invoke naming a different agent on a live session would keep the incumbent's
      // warm Agent, and `if (!agent)` below would skip the rebuild - running the
      // caller's prompt against the other agent's prompt, history and config.env.
      if (boundSessionId !== sessionId || boundAgentId !== agentId) {
        agent = null;
        boundSessionId = sessionId;
        boundAgentId = agentId;
        metrics = newAccumulator(agentId, sessionId, version, config.model);
      } else if (metrics) {
        // Same session, but it had gone idle and is now re-triggered - the common
        // "send → wait for reply → send again" turn. That's a fresh invocation on
        // this lifetime (like an injection is), so count it. (The opening trigger
        // was already counted as invocation #1 by newAccumulator above.)
        metrics.invocations += 1;
      }

      // Otherwise start a fresh turn in the background. The `.catch` is a backstop:
      // startTurn handles its own errors, but a rejection must never leave `working`
      // stuck true (which would wedge the session into "inject-only").
      working = true;
      void runTurnTracked(sessionId, agentId, config, skills, integrations, fromSlack, prompt).catch((e) => {
        console.error("turn task failed", e);
        working = false;
      });
      return { status: "triggered", sessionId };
    },
  },
});

async function startTurn(
  sessionId: string,
  agentId: string,
  config: AgentConfig,
  skills: ResolvedSkill[],
  integrations: ResolvedIntegration[],
  fromSlack: boolean,
  prompt: string,
): Promise<void> {
  // One call to startTurn = one invocation's working span. It runs the prompt and
  // any messages injected/drained while working (they fold into this span, not a
  // new one), until the mailbox is empty and we go idle. Time the whole span so
  // "duration" means run→complete, not the whole-lifetime gap. Started here rather
  // than at the first model call so it captures the full active window.
  const spanStart = Date.now();
  try {
    if (!agent) {
      await record(sessionId, agentId, "session_start", { runId: metrics?.runId, content: config.name });
      agent = buildAgent({
        config,
        agentId,
        sessionId,
        skills,
        integrations,
        fromSlack,
        onInjected: (text) => record(sessionId, agentId, "injected", { runId: metrics?.runId, content: text }),
      });
    }

    // Drain loop: run the prompt, then run any messages that arrived too late for
    // the injection hook (after the turn's final model call) as follow-up turns on
    // the same warm agent. `working` stays true the WHOLE time - so a message
    // arriving at any point is enqueued and picked up by the next `takePending()`
    // here, never acked "injected" and then dropped. Bounded by the mailbox cap
    // (intake past MAILBOX_CAP is "rejected") and the microVM lifetime; there is
    // no self-enqueue path, so it can't spin without real client input.
    //
    // We drain BEFORE writing the terminal event so `session_end` is written
    // exactly once, only when the mailbox is truly empty. An intermediate turn's
    // answer is recorded as a non-terminal `text` event - writing `session_end`
    // per turn would tell a status-poller the session is done (the poll layer
    // treats session_end as terminal) and it would stop mid-conversation, missing
    // the drained follow-up turn's output.
    const drain = (): string | undefined => {
      const pending = takePending();
      return pending.length ? pending.join("\n\n") : undefined;
    };
    // NOTE: the user's `prompt` event is recorded by the CONTROL-PLANE at invoke
    // time (repo/trajectory.recordPrompt), not here - so it shows for every agent
    // regardless of when its runtime image was baked. Injected follow-ups are
    // still recorded as `injected` events by the onInjected hook above.
    let next: string | undefined = prompt;
    for (;;) {
      const turn = await runAgentTurn(agent, sessionId, agentId, next, metrics?.runId);
      if (metrics) accumulateTurn(metrics, turn); // fold this turn's counts
      // A per-turn budget trip ends the run as an ERROR, not a blank success: the
      // SDK returns a `limit*`/`cancelled` stop reason instead of throwing, so
      // without this the operator sees an empty answer with outcome "ok" and the
      // error rate - the signal for tuning the caps - never moves. Thrown so it
      // takes the same terminal path as any other failed turn.
      const tripped = budgetTripMessage(turn.stopReason);
      if (tripped) throw new Error(tripped);
      // Drain BEFORE the terminal write: a straggler already in the mailbox
      // continues the loop, so no intermediate `session_end` is emitted (a
      // poll-until-idle client would mistake it for completion). The turn's final
      // text is already recorded as a `text` event by runAgentTurn, so nothing is
      // lost by not writing session_end here.
      next = drain();
      if (next !== undefined) continue;
      await record(sessionId, agentId, "session_end", { runId: metrics?.runId, content: turn.finalText });
      // Record this invocation's active duration (span start → now) before the
      // summary write, so the summary carries the per-invocation timing. The loop
      // reaches here only when the mailbox is empty (the span is truly done).
      if (metrics) recordInvocationDuration(metrics, Date.now() - spanStart);
      // Refresh the durable session summary at each idle point. Keyed by the
      // lifetime's runId, so this OVERWRITES one row across the session's many
      // triggers rather than appending (see session-metrics.ts).
      if (metrics) await writeSummary(metrics, "ok");
      // Re-drain after the terminal write: a message can arrive DURING the record
      // await (working is still true, so it's acked "injected"). Re-running it
      // keeps that acked message from being dropped - NO acked message is ever
      // lost. Residual (narrow, not data loss): that straggler already ran and is
      // durably recorded under a second session_end, but a client polling in the
      // ~write-latency window can read the FIRST session_end as terminal and stop,
      // missing the follow-up turn. Fully closing it needs a turn-state machine
      // (the terminal write is async and `working` must stay true across it to keep
      // turns serialized) - deferred; see CLAUDE.md.
      next = drain();
      if (next === undefined) break;
    }
  } catch (err) {
    // Drop the warm agent first - a failed turn can leave a half-formed message
    // list (a tool_use with no tool_result) that would poison every future turn.
    agent = null;
    // Its token meter dies with it, and the replacement's starts at zero - so seal the
    // total now or the next turn's snapshot would OVERWRITE what this one spent.
    if (metrics) sealTokens(metrics);
    // Record the error while `working` is still true (like the success path writes
    // session_end inside the loop), so a new turn can't start during this write and
    // interleave its events before this terminal event. `record` never throws, so
    // `working` can't get stuck.
    await record(sessionId, agentId, "error", {
      runId: metrics?.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    // This invocation's active span still happened, so record it before the summary -
    // otherwise the duration percentiles are computed over SUCCESSFUL spans only, and a
    // run that failed slowly (the case an operator most wants charted) contributes
    // nothing to the latency chart.
    if (metrics) recordInvocationDuration(metrics, Date.now() - spanStart);
    // Record the session summary as errored (overwrites the run's row).
    if (metrics) await writeSummary(metrics, "error");
  } finally {
    working = false;
    // Clear any straggler. On the success path the loop already drained, so this
    // is a no-op. On the error path a message acked "injected" during the error
    // write is dropped here rather than run - intentional: the warm agent was
    // nulled (poisoned), so there's no context to run it against, and keeping it
    // would risk leaking it into a DIFFERENT session's turn on the shared local
    // runtime. A dropped-after-error inject is the accepted trade-off.
    takePending();
  }
}

// Wraps startTurn in AgentCore's async-task tracker so `/ping` reports HealthyBusy
// while a turn runs. Declared after `app`; only invoked at request time.
const runTurnTracked = app.asyncTask(startTurn as (...args: unknown[]) => Promise<unknown>);

app.run();
