/**
 * Trajectory read access for polling. The agent-runtime writes one item per
 * event keyed by (sessionId, cursor=UUIDv7). UUIDv7 sorts chronologically, so a
 * session's events sort in write order and a client can fetch only the delta
 * since its last-seen cursor with `cursor > :after`.
 *
 * A poll needs the event delta AND whether the session is still working, and the
 * two must agree: a client must never be told `idle` before it has received the
 * terminal (`session_end`/`error`) event, or it would stop polling and miss the
 * final answer. We read the delta (only events after the cursor - cheap, so
 * polling a long session doesn't re-read it), then a `Limit:1` newest-event read
 * for status, and only report `idle` once the client has that terminal event in
 * hand (its cursor is at or below what this poll delivers) - see tailStatus.
 */
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { v7 as uuidv7 } from "uuid";
import type { TrajectoryEvent, TrajectoryEventInput } from "@agency/shared";
import { ddb } from "../ddb.js";
import { TRAJECTORY_TABLE } from "../config.js";

const TERMINAL = new Set<TrajectoryEvent["type"]>(["session_end", "error"]);
const TTL_DAYS = 30;

/**
 * Write one trajectory event posted by the runtime's ingest API. The runtime
 * generates the UUIDv7 `cursor` (preserving write-order for delta polling); we
 * stamp the write time + TTL and persist. Undefined optional fields are dropped
 * by the doc client's `removeUndefinedValues`.
 */
export async function recordEvent(ev: TrajectoryEventInput): Promise<void> {
  const now = new Date();
  await ddb.send(
    new PutCommand({
      TableName: TRAJECTORY_TABLE,
      Item: {
        sessionId: ev.sessionId,
        cursor: ev.cursor,
        agentId: ev.agentId,
        runId: ev.runId,
        type: ev.type,
        ts: now.toISOString(),
        ttl: Math.floor(now.getTime() / 1000) + TTL_DAYS * 24 * 60 * 60,
        content: ev.content,
        toolName: ev.toolName,
        toolUseId: ev.toolUseId,
        input: ev.input,
        result: ev.result,
        error: ev.error,
      },
    }),
  );
}

/**
 * Record the user's message as a `prompt` event, from the control-plane, at
 * invoke time. This lives here (not in the runtime) on purpose: every invoke flows
 * through this Lambda, so the prompt is recorded for every agent regardless of which
 * runtime serves it and without waiting for the runtime to post anything - a session
 * whose microVM never starts still shows what was asked. Best-effort: a failed write
 * must never fail the invoke (the turn is already triggered).
 */
export async function recordPrompt(sessionId: string, agentId: string, prompt: string): Promise<void> {
  const now = new Date();
  await ddb.send(
    new PutCommand({
      TableName: TRAJECTORY_TABLE,
      Item: {
        sessionId,
        cursor: uuidv7(), // UUIDv7 sorts chronologically → orders within the session
        agentId,
        type: "prompt",
        ts: now.toISOString(),
        ttl: Math.floor(now.getTime() / 1000) + TTL_DAYS * 24 * 60 * 60,
        content: prompt,
      },
    }),
  );
}

export interface SessionRead {
  /** Events after the `after` cursor (or all, if none given), in order. */
  delta: TrajectoryEvent[];
  /** Whether the session is still working. */
  status: "working" | "idle";
}

/**
 * A session's events (all of them, or only those after `after`), in write order.
 *
 * Side-effect free, unlike `readSession` - which also derives status and may write a
 * synthetic terminal event. The archive path needs the events and nothing else, so it
 * uses this: archiving must never mutate the trajectory it's copying.
 *
 * `forRun` narrows to ONE runtime lifetime. A client may reuse a sessionId across
 * runs, and every run writes into this same partition, so a whole-partition read
 * returns several runs' events merged - which is wrong both for the run viewer and for
 * the archive (it would bake a neighbour's events into this run's object). Events with
 * NO runId are kept either way: the opening `prompt` is written by the control-plane
 * before the runtime has minted one, and rows predating run history have none.
 *
 * Paginates so the agentId filter can't leave a 1 MB page looking empty while more
 * matches exist beyond it.
 */
export async function readEvents(
  agentId: string,
  sessionId: string,
  after?: string,
  forRun?: string,
): Promise<TrajectoryEvent[]> {
  const events: TrajectoryEvent[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TRAJECTORY_TABLE,
        KeyConditionExpression: after ? "sessionId = :s AND #c > :after" : "sessionId = :s",
        // `attribute_not_exists(runId)` keeps the un-stamped events (see above) rather
        // than silently dropping the user's prompt from the trace.
        FilterExpression: forRun
          ? "agentId = :a AND (runId = :r OR attribute_not_exists(runId))"
          : "agentId = :a",
        ExpressionAttributeNames: after ? { "#c": "cursor" } : undefined,
        ExpressionAttributeValues: {
          ":s": sessionId,
          ":a": agentId,
          ...(after ? { ":after": after } : {}),
          ...(forRun ? { ":r": forRun } : {}),
        },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const it of res.Items ?? []) events.push(toEvent(it as Record<string, unknown>));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return events;
}

/**
 * Read a session's delta + status, scoped to `agentId`. Events store their agentId and
 * a session is only polled through its owning agent, so `readEvents`' FilterExpression
 * prevents one agent's key from reading another's events via a shared/guessable
 * session id.
 *
 * Cost: the delta query reads only events after the cursor (not the whole session), so
 * repeated polling of a long session stays cheap. Status comes from a `Limit:1` tail read.
 */
export async function readSession(
  agentId: string,
  sessionId: string,
  after?: string,
): Promise<SessionRead> {
  const delta = await readEvents(agentId, sessionId, after);

  // Status: if the delta already carries a terminal event, we're idle. Otherwise
  // consult the newest event of the whole session (a cheap Limit:1 tail read).
  if (TERMINAL.has(delta[delta.length - 1]?.type as TrajectoryEvent["type"])) {
    return { delta, status: "idle" };
  }
  const tail = await newestEvent(agentId, sessionId);
  const status = tailStatus(tail, delta, after);
  if (status === "working" && isAbandoned(tail)) {
    // The microVM died without writing a terminal event, so nothing will ever move
    // this session off "working" and the client would poll forever. Close it out
    // durably (see abandonSession) and hand the client the event in this reply.
    const ev = await abandonSession(agentId, sessionId);
    delta.push(ev);
    return { delta, status: "idle" };
  }
  return { delta, status };
}

/**
 * How long a session may go completely silent before we treat it as abandoned.
 *
 * The runtime streams an event per model text block and per tool call, so silence
 * this long means the microVM is gone (crashed, reclaimed, or OOM-killed) rather
 * than busy - the one exception being a single tool call that runs longer than
 * this, which is why the window is generous rather than tight. AgentCore keeps a
 * live session up to 8h, so a fixed timeout can't be derived from its lifecycle.
 */
const ABANDONED_AFTER_MS = 30 * 60 * 1000;

/**
 * True when the session's newest event is non-terminal AND old enough to call the
 * session dead. Requiring non-terminal explicitly matters: a session that ENDED
 * normally but whose `session_end` this client hasn't received yet also reads as
 * "working", and it must not be given a second, contradictory terminal event.
 *
 * A session with NO events at all is never abandoned - it may be a microVM still
 * booting. That means polling a sessionId that doesn't exist (a typo, or one from a
 * different agent) also reads "working" indefinitely. Distinguishing the two would
 * need a session registry written at invoke; there isn't one, and inventing a
 * "probably not real" timeout risks cutting off a genuinely slow cold start.
 */
function isAbandoned(tail: Record<string, unknown> | undefined): boolean {
  if (!tail) return false; // nothing written yet - the turn may still be starting up
  if (TERMINAL.has(tail.type as TrajectoryEvent["type"])) return false;
  const ts = Date.parse(String(tail.ts));
  return Number.isFinite(ts) && Date.now() - ts > ABANDONED_AFTER_MS;
}

/**
 * Record the synthetic terminal `error` that closes an abandoned session, and
 * return it. Written from the poll path (not the runtime) precisely because the
 * runtime is the thing that died.
 *
 * The cursor is an ordinary `uuidv7()`, so it sorts after every event written so
 * far AND before anything written later - a client that reuses this sessionId on a
 * fresh microVM still sees the new events in its delta. (A fixed sort-last cursor
 * would be idempotent but would hide every future event behind it.) Writing twice
 * is therefore possible but self-limiting: the first marker makes the tail fresh
 * AND terminal, so only polls already in flight can duplicate it.
 *
 * NOTE: this closes the client-visible hang, not the metrics gap - no session
 * summary row is written, so an abandoned session still doesn't count toward the
 * error rate. ControlPlaneFn deliberately holds READ-only on the sessions table
 * (writes belong to IngestFn - see the runtime-credential-isolation notes), and
 * widening that grant to fix a counter isn't a trade worth making.
 */
async function abandonSession(agentId: string, sessionId: string): Promise<TrajectoryEvent> {
  const now = new Date();
  const item = {
    sessionId,
    cursor: uuidv7(),
    agentId,
    type: "error" as const,
    ts: now.toISOString(),
    ttl: Math.floor(now.getTime() / 1000) + TTL_DAYS * 24 * 60 * 60,
    error: "The session stopped responding and was closed. The agent's environment ended before it finished.",
  };
  await ddb.send(new PutCommand({ TableName: TRAJECTORY_TABLE, Item: item }));
  return toEvent(item as unknown as Record<string, unknown>);
}

/**
 * The session's newest event (a cheap `Limit:1` tail read). May be undefined when
 * nothing is written yet, or when the newest event belongs to a DIFFERENT agent
 * that shares this session id (the FilterExpression drops it).
 */
async function newestEvent(agentId: string, sessionId: string): Promise<Record<string, unknown> | undefined> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TRAJECTORY_TABLE,
      KeyConditionExpression: "sessionId = :s",
      FilterExpression: "agentId = :a",
      ExpressionAttributeValues: { ":s": sessionId, ":a": agentId },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  return (res.Items ?? [])[0] as Record<string, unknown> | undefined;
}

/**
 * Status from the session's newest event, reported "idle" only once the client
 * has (or will, from this poll) received that terminal event - so it never stops
 * polling early. The client's high-water mark after this poll is the greater of
 * its prior `after` cursor and the delta's last cursor; if the terminal event's
 * cursor is at or below that, it's in hand → idle. (This also handles the
 * post-completion poll where the delta is empty but `after` already covers the
 * terminal event - without the `after` term that case would poll forever.) A
 * missing/filtered-out newest event falls through to "working".
 */
function tailStatus(
  newest: Record<string, unknown> | undefined,
  delta: TrajectoryEvent[],
  after: string | undefined,
): "working" | "idle" {
  if (!newest || !TERMINAL.has(newest.type as TrajectoryEvent["type"])) return "working";
  const received = delta[delta.length - 1]?.cursor ?? after ?? "";
  return String(newest.cursor) <= received ? "idle" : "working";
}

function toEvent(it: Record<string, unknown>): TrajectoryEvent {
  return {
    cursor: String(it.cursor),
    type: it.type as TrajectoryEvent["type"],
    ts: String(it.ts),
    content: it.content as string | undefined,
    toolName: it.toolName as string | undefined,
    toolUseId: it.toolUseId as string | undefined,
    input: it.input,
    result: it.result as string | undefined,
    error: it.error as string | undefined,
  };
}
