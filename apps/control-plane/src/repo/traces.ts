/**
 * Archived run trajectories in S3 - the durable half of run history.
 *
 * The trajectory TABLE is the hot store and carries a 30-day TTL, so a run's events
 * vanish from it. One object per run holds them permanently, letting the console open
 * any past run long after the rows expire.
 *
 * Keyed `traces/<agentId>/<runId>.json` - by RUN, not by session. A client may reuse a
 * sessionId across microVM lifetimes (each lifetime = a new run over that same
 * trajectory partition), so keying by sessionId let a later run's archive OVERWRITE an
 * earlier one: once the earlier run's rows had TTL'd, its trace was gone and its row in
 * the run list silently opened the newer run's steps instead. One object per run can't
 * collide. The agentId prefix keeps one agent's traces together (and is what a lifecycle
 * rule or a per-agent purge would target).
 *
 * Re-written by IngestFn at each of a session's idle points (see archiveTrace); read by
 * the control-plane. Both are no-ops when TRACES_BUCKET is unset (local dev), so the
 * local stack keeps serving runs from the table alone.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { SessionSummaryInput, StoredTrace, TrajectoryEvent } from "@agency/shared";
import { REGION, TRACES_BUCKET } from "../config.js";

const s3 = new S3Client({ region: REGION });

/** The object key for one run's trace. */
function traceKey(agentId: string, runId: string): string {
  return `traces/${agentId}/${runId}.json`;
}

/**
 * Archive a run's events so far. Overwrites its OWN object: the runtime posts a summary
 * at every idle point, so a growing session re-archives, and since events are
 * append-only each write is a superset of the last. Distinct runs never share a key.
 *
 * Best-effort by contract - the caller must not fail the ingest for it. Telemetry that
 * couldn't be archived is worth a log, not a 500 at the runtime.
 */
export async function archiveTrace(
  summary: SessionSummaryInput,
  events: TrajectoryEvent[],
): Promise<void> {
  if (!TRACES_BUCKET || events.length === 0) return;
  // Self-describing: traces are kept forever, so an object outlives the trajectory rows
  // and can outlive the agent record. The envelope names what produced it.
  const trace: StoredTrace = {
    agentId: summary.agentId,
    runId: summary.runId,
    sessionId: summary.sessionId,
    version: summary.version,
    ...(summary.model ? { model: summary.model } : {}),
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    outcome: summary.outcome,
    archivedAt: new Date().toISOString(),
    events,
  };
  await s3.send(
    new PutObjectCommand({
      Bucket: TRACES_BUCKET,
      Key: traceKey(summary.agentId, summary.runId),
      Body: JSON.stringify(trace),
      ContentType: "application/json",
    }),
  );
}

/**
 * Read a run's archived trace, or null when there isn't one (never archived, or no
 * bucket configured). This is the LAST resort - the caller reads the live trajectory
 * table first - so "no archive" must render as an empty run, never a 500.
 *
 * A missing object is a null. So is a corrupt one (not an array, unparseable): there's
 * nothing a caller could do with it, and a broken archive must not take down the run
 * list. A transient S3 failure, though, is re-thrown: swallowing it would tell the user
 * their trace is permanently gone when a retry would have served it.
 */
export async function readArchivedTrace(
  agentId: string,
  runId: string,
): Promise<TrajectoryEvent[] | null> {
  if (!TRACES_BUCKET) return null;
  let body: string | undefined;
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: TRACES_BUCKET, Key: traceKey(agentId, runId) }),
    );
    body = await res.Body?.transformToString();
  } catch (e) {
    if (isMissing(e)) return null;
    throw e; // throttled/unavailable - app.onError maps it to a retryable 503
  }
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    // Objects written before the envelope existed are a bare event array; read both.
    if (Array.isArray(parsed)) return parsed as TrajectoryEvent[];
    const events = (parsed as StoredTrace | null)?.events;
    return Array.isArray(events) ? events : null;
  } catch {
    return null; // a truncated or non-JSON object: unusable, so "no archive"
  }
}

/** Whether an S3 error means "that object isn't there" rather than "try again". */
function isMissing(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  return name === "NoSuchKey" || name === "NotFound";
}
