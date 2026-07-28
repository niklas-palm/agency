/**
 * Prod ScheduleProvisioner: one EventBridge Scheduler schedule per scheduled
 * agent, named `af-<agentId>`. The schedule targets the trigger Lambda with a
 * `{ "agentId": "<id>" }` input; the Lambda reads the agent's stored schedule
 * prompt and invokes it (so prompt/expression edits only need the schedule's
 * expression reconciled here - the prompt lives in config, the single source of
 * truth). Reconcile is idempotent: it creates-or-updates, and deletes when the
 * agent has no schedule.
 */
import {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  FlexibleTimeWindowMode,
} from "@aws-sdk/client-scheduler";
import type { ScheduleTrigger } from "@agency/shared";
import type { ScheduleProvisioner } from "./schedule.js";
import { REGION, SCHEDULE_GROUP, TRIGGER_FUNCTION_ARN, SCHEDULER_ROLE_ARN } from "../config.js";

/** Schedule name for an agent - deterministic so reconcile is a plain upsert. */
function scheduleName(agentId: string): string {
  return `af-${agentId}`;
}

/** Retries for one failed tick, and how long a tick may keep being retried. */
const MAX_TICK_RETRIES = 2;
const TICK_MAX_AGE_S = 300;

export class EventBridgeScheduleProvisioner implements ScheduleProvisioner {
  private readonly client = new SchedulerClient({ region: REGION });

  async reconcile(agentId: string, schedule: ScheduleTrigger | null): Promise<void> {
    if (!schedule) {
      await this.remove(agentId);
      return;
    }

    const params = {
      Name: scheduleName(agentId),
      GroupName: SCHEDULE_GROUP,
      ScheduleExpression: schedule.expression,
      ScheduleExpressionTimezone: schedule.timezone ?? "UTC",
      FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
      Target: {
        Arn: TRIGGER_FUNCTION_ARN,
        RoleArn: SCHEDULER_ROLE_ARN,
        // The Lambda only needs the agentId; it reads the prompt from config so a
        // prompt edit doesn't require touching the schedule target.
        Input: JSON.stringify({ agentId }),
        // Bound the retries. EventBridge Scheduler's default for a Lambda target is
        // up to 185 attempts over 24h - and each attempt mints a FRESH sessionId, so
        // a schedule that keeps failing past the invoke would start that many
        // billable agent runs off one tick. A tick is a periodic job: a couple of
        // retries covers a transient blip, and the next tick is the real retry.
        RetryPolicy: { MaximumRetryAttempts: MAX_TICK_RETRIES, MaximumEventAgeInSeconds: TICK_MAX_AGE_S },
      },
    };

    // Upsert: try update, fall back to create if it doesn't exist yet.
    try {
      await this.client.send(new UpdateScheduleCommand(params));
    } catch (err) {
      if ((err as { name?: string }).name === "ResourceNotFoundException") {
        await this.client.send(new CreateScheduleCommand(params));
      } else {
        throw err;
      }
    }
  }

  async remove(agentId: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteScheduleCommand({ Name: scheduleName(agentId), GroupName: SCHEDULE_GROUP }),
      );
    } catch (err) {
      // Already gone → nothing to do.
      if ((err as { name?: string }).name !== "ResourceNotFoundException") throw err;
    }
  }
}
