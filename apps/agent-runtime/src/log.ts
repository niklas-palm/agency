/**
 * Agent-runtime logging. These lines land in the microVM's CloudWatch group
 * (`/aws/bedrock-agentcore/runtimes/…`), which is what you read when an agent
 * misbehaves.
 *
 * Failures are logged unconditionally (see ingest.ts, server.ts); everything that
 * merely describes what the agent is doing is DEBUG-only - `DEBUG=1` turns on the
 * per-invocation / per-turn / per-tool-call trace, which docker-compose sets for
 * local dev and no CDK stack sets in prod. The trajectory is the durable record of a
 * run, so prod has no need for a second copy of it in CloudWatch.
 *
 * Debug lines carry ids, names and sizes - never prompt text, tool arguments or
 * `config.env` values. A microVM's logs are readable by anyone with account access,
 * while the trajectory is at least scoped to people who can see the agent.
 *
 * The control-plane has its own copy of this file (apps/control-plane/src/log.ts):
 * the two apps deploy separately, share nothing at runtime but the wire types, and
 * this is a dozen lines.
 */

/** Verbose logging, for local dev. Never set in prod. */
export const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

/** Log detail worth having while debugging; a no-op unless DEBUG is set. */
export function debug(msg: string, f: Record<string, unknown> = {}): void {
  if (!DEBUG) return;
  const flat = Object.entries(f)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`debug ${msg} ${flat}`);
}
