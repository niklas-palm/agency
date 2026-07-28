/**
 * Local ScheduleProvisioner: a no-op. docker-compose has no EventBridge, so a
 * scheduled agent's recurrence isn't fired automatically locally - you exercise
 * it by invoking the agent directly (the schedule's stored prompt is what the
 * prod trigger Lambda would send). Keeps the local stack a faithful shape
 * without standing up a scheduler.
 */
import type { ScheduleTrigger } from "@agency/shared";
import type { ScheduleProvisioner } from "./schedule.js";

export class LocalScheduleProvisioner implements ScheduleProvisioner {
  async reconcile(_agentId: string, _schedule: ScheduleTrigger | null): Promise<void> {
    // no-op locally
  }
  async remove(_agentId: string): Promise<void> {
    // no-op locally
  }
}
