/**
 * Control-plane logging. Two rules, so the logs are useful in prod without being
 * noise, and verbose locally without a redeploy:
 *
 * - A request that FAILED is always logged, one line: method, path, status, ms.
 *   Nothing else logged a 4xx, so "why is my call rejected?" had no answer in
 *   CloudWatch at all - the response was the only evidence, and the caller already
 *   had that.
 * - Everything more detailed is DEBUG-only. Set `DEBUG=1` and successful requests,
 *   invokes, polls and telemetry writes are logged too. docker-compose sets it for
 *   local dev; no CDK stack sets it, so a deployed Lambda logs failures only.
 *
 * Deliberately `console.*` and one line of `key=value`, not a logging library:
 * CloudWatch already stamps the time and the request id, and Logs Insights can
 * `parse` a flat line. The agent-runtime has its own copy of this file - the two
 * apps deploy separately and share nothing at runtime but the wire types, and this
 * is a dozen lines.
 */

/** Verbose logging, for local dev. Never set in prod (see logRequest/debug). */
export const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

/** `a=1 b=2` - flat enough for Logs Insights' `parse`, cheap enough to always build. */
function fields(f: Record<string, unknown>): string {
  return Object.entries(f)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

/** Log detail worth having while debugging; a no-op unless DEBUG is set. */
export function debug(msg: string, f: Record<string, unknown> = {}): void {
  if (DEBUG) console.log(`debug ${msg} ${fields(f)}`);
}

/**
 * One line per request: always for a 4xx/5xx, only under DEBUG for a success.
 * Never logs the query string or any header - a path carries agent/session ids
 * (fine), while credentials only ever travel in headers.
 */
export function logRequest(method: string, path: string, status: number, ms: number): void {
  if (status < 400 && !DEBUG) return;
  const line = `request ${method} ${path} ${fields({ status, ms })}`;
  if (status >= 500) console.error(line);
  else console.log(line);
}
