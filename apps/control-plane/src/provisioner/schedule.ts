/**
 * ScheduleProvisioner seam: the per-agent recurring trigger. Prod manages one
 * EventBridge Scheduler schedule per scheduled agent (targeting the trigger
 * Lambda, which invokes the agent); local is a no-op (docker-compose doesn't run
 * real schedules - the schedule is exercised by invoking directly). The rest of
 * the control-plane depends only on this interface.
 *
 * Each managed trigger that arrives later (Slack, GitHub, …) gets its own
 * provisioner alongside this one, wired the same way.
 */
import type { ScheduleTrigger } from "@agency/shared";

export interface ScheduleProvisioner {
  /**
   * Reconcile the agent's schedule to `schedule`. Upserts when a schedule is
   * present, deletes when it's null. Idempotent - safe to call on every
   * create/update with the current desired state.
   */
  reconcile(agentId: string, schedule: ScheduleTrigger | null): Promise<void>;
  /** Remove the agent's schedule (used on agent delete / orphan cleanup). */
  remove(agentId: string): Promise<void>;
}
