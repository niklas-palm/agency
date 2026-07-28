/**
 * Operational metric counters on the agents table: an invocation counter and a
 * last-invoked timestamp, bumped atomically on each invoke. Deliberately tiny - it's
 * only what the invoke path can cheaply increment for the agent list.
 *
 * Everything richer (error counts, durations, tokens, cost) comes from the per-session
 * summary rows on the agent-sessions table, NOT from these counters and not from
 * trajectory events - those rows carry the version + model context these can't. See
 * repo/sessions.ts + docs/metrics.md.
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../ddb.js";
import { AGENTS_TABLE } from "../config.js";

export async function bumpInvocation(agentId: string): Promise<void> {
  // `metrics` is a DynamoDB reserved keyword, so alias it via ExpressionAttributeNames.
  await ddb.send(
    new UpdateCommand({
      TableName: AGENTS_TABLE,
      Key: { id: agentId },
      UpdateExpression:
        "SET #m.invocations = #m.invocations + :one, #m.lastInvokedAt = :now",
      ExpressionAttributeNames: { "#m": "metrics" },
      ExpressionAttributeValues: { ":one": 1, ":now": new Date().toISOString() },
    }),
  );
}
