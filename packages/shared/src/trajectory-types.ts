/**
 * The trajectory event-type catalog, in a LEAF module (imports nothing) so
 * `openapi.ts` can read it without importing `index.ts` - which re-exports
 * openapi.ts, and the cycle would leave the enum undefined at module-init time.
 * Same reason `models.ts` and `scopes.ts` are leaves. `index.ts` re-exports these,
 * so consumers still just import from `@agency/shared`.
 */

/** Every trajectory event type (runtime array - the source of truth for the union). */
export const TRAJECTORY_EVENT_TYPES = [
  "session_start",
  "prompt",
  "text",
  "tool_input",
  "tool_result",
  "injected",
  "session_end",
  "error",
] as const;

export type TrajectoryEventType = (typeof TRAJECTORY_EVENT_TYPES)[number];
