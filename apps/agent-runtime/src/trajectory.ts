/**
 * Trajectory persistence. Every agent action (text, tool input, tool result,
 * lifecycle) is POSTed to the control-plane's ingest API as one event. The
 * runtime generates the UUIDv7 cursor here so events sort chronologically (cheap
 * delta polling); the control-plane persists them keyed by (sessionId, cursor).
 * The runtime does NOT write DynamoDB directly - its AWS role has no table write
 * (Bedrock-only), so the agent can't reach the trajectory table even via stolen
 * MMDS creds. See docs/runtime.md.
 */
import { v7 as uuidv7 } from "uuid";
import type { TrajectoryEventType } from "@agency/shared";
import { postIngest } from "./ingest.js";

/** Fields of a trajectory event other than the ones the writer sets itself. */
export interface EventFields {
  /**
   * The run (microVM lifetime) this event belongs to. Stamped so a session whose id
   * a client reuses across runs can still be split back into per-run traces - every
   * run writes into the same trajectory partition.
   */
  runId?: string;
  content?: string;
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
  result?: string;
  error?: string;
}

/**
 * Append one trajectory event, best-effort. The trajectory is observability, not
 * the agent's work, so a failure must never abort a turn or fabricate an error -
 * postIngest swallows (and logs) rejections. This is the only way the runtime
 * writes events, so there is no throwing variant to misuse.
 */
export async function record(
  sessionId: string,
  agentId: string,
  type: TrajectoryEventType,
  fields: EventFields = {},
): Promise<void> {
  await postIngest("/internal/trajectory", {
    sessionId,
    agentId,
    cursor: uuidv7(), // UUIDv7 sorts chronologically → cheap delta polling
    type,
    ...fields,
  });
}
