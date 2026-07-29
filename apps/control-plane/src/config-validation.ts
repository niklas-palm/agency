/**
 * Validation + normalization of agent config from an untrusted request body.
 * Extracted from routes so it can be unit-tested directly - this is the trust
 * boundary between the public API and stored config.
 */
import type { AgentConfig, Trigger } from "@agency/shared";
import { MODEL_KEYS } from "@agency/shared";

/**
 * The minimum recurrence interval, in minutes. A floor on how often a schedule
 * can fire the agent - each tick is an unattended, billable Bedrock run, so we
 * refuse sub-5-minute cadences (a cost/abuse guard until a usage plan + per-agent
 * concurrency cap land - see CLAUDE.md's rate-limiting deferred item).
 */
export const MIN_SCHEDULE_MINUTES = 5;
/** Upper bound on the stored, replayed-every-tick schedule prompt. */
const MAX_SCHEDULE_PROMPT = 10_000;
/** Bounds on the agent name + system prompt (stored + replayed in every payload). */
const MAX_NAME = 200;
const MAX_SYSTEM_PROMPT = 20_000;

/**
 * Expand a cron minute field into the exact set of minutes (0-59) it fires on,
 * or null if the field is malformed. Handles the wildcard, wildcard-with-step,
 * a single value, a range `a-b`, a range-with-step, the AWS increment form
 * `a/s` (from a to 59 by s), and comma lists of those. This is what lets us
 * enforce the real cadence floor instead of pattern-matching a couple of shapes.
 */
function cronMinuteSet(field: string): Set<number> | null {
  const out = new Set<number>();
  const add = (from: number, to: number, step: number) => {
    if (step <= 0 || from < 0 || to > 59 || from > to) return false;
    for (let m = from; m <= to; m += step) out.add(m);
    return true;
  };
  for (const part of field.split(",")) {
    const m = part.match(/^(?:(\*)|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/);
    if (!m) return null;
    const [, star, a, b, s] = m;
    const step = s !== undefined ? Number(s) : 1;
    if (star !== undefined) {
      if (!add(0, 59, step)) return null; // `*` or `*/s`
    } else {
      const from = Number(a);
      // `a/s` = from a to 59 step s (AWS increment); `a-b` = range; `a` = single.
      const to = b !== undefined ? Number(b) : s !== undefined ? 59 : from;
      if (!add(from, to, step)) return null;
    }
  }
  return out.size ? out : null;
}

/** The smallest gap (in minutes, wrapping across the hour) within a fire-set. */
function minGapMinutes(minutes: Set<number>): number {
  const sorted = [...minutes].sort((x, y) => x - y);
  if (sorted.length === 1) return 60; // once per hour
  let min = 60 - sorted[sorted.length - 1]! + sorted[0]!; // wrap gap
  for (let i = 1; i < sorted.length; i++) min = Math.min(min, sorted[i]! - sorted[i - 1]!);
  return min;
}

/**
 * Validate an EventBridge Scheduler expression well enough to reject typos and
 * abusive cadences *before* they reach AWS (where they'd fail non-transiently at
 * reconcile time). Accepts `rate(N unit)` with AWS's singular/plural rule and a
 * ≥ MIN_SCHEDULE_MINUTES floor, and a 6-field `cron(...)` whose minute field -
 * fully expanded (lists, ranges, steps) - never fires more often than the floor.
 * AWS still does the authoritative validation of the remaining fields.
 */
export function validScheduleExpression(expr: string): boolean {
  const rate = expr.match(/^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/);
  if (rate) {
    const n = Number(rate[1]);
    const unit = rate[2]!;
    if (n <= 0) return false;
    // AWS requires singular for 1, plural for >1 (rejects `rate(5 minute)`).
    if ((n === 1) !== !unit.endsWith("s")) return false;
    const minutes = unit.startsWith("minute") ? n : unit.startsWith("hour") ? n * 60 : n * 1440;
    return minutes >= MIN_SCHEDULE_MINUTES;
  }
  const cron = expr.match(/^cron\((.+)\)$/);
  if (cron) {
    const fields = cron[1]!.trim().split(/\s+/);
    if (fields.length !== 6) return false; // EventBridge cron is 6 fields
    const set = cronMinuteSet(fields[0]!);
    if (!set) return false; // malformed minute field
    // If the hour field pins a single hour, the fires are one-per-day-per-minute
    // and only the within-hour spacing matters; either way the minute-set gap is
    // the tightest cadence, so enforce the floor on it.
    return minGapMinutes(set) >= MIN_SCHEDULE_MINUTES;
  }
  return false;
}

/** A plausible IANA timezone (`Area/Location`) or `UTC`. Length-capped. */
function validTimezone(tz: string): boolean {
  return tz.length <= 64 && (tz === "UTC" || /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(tz));
}

/**
 * Validate a triggers array from an untrusted body. Returns the normalized list
 * (always including exactly one `api` trigger) or null if malformed. At most one
 * `schedule` trigger is allowed; its expression must be a valid, non-abusive
 * Scheduler form, its prompt non-empty and bounded, its timezone plausible.
 */
export function parseTriggers(value: unknown): Trigger[] | null {
  if (!Array.isArray(value)) return null;
  const out: Trigger[] = [{ type: "api" }];
  let scheduleSeen = false;
  let slackSeen = false;
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const t = raw as Record<string, unknown>;
    if (t.type === "api") continue; // baseline is always added; ignore duplicates
    if (t.type === "schedule") {
      if (scheduleSeen) return null; // at most one schedule
      scheduleSeen = true;
      if (typeof t.expression !== "string" || !validScheduleExpression(t.expression.trim())) return null;
      if (typeof t.prompt !== "string" || !t.prompt.trim() || t.prompt.length > MAX_SCHEDULE_PROMPT) return null;
      if ("timezone" in t && (typeof t.timezone !== "string" || !validTimezone(t.timezone))) return null;
      const schedule: Trigger = {
        type: "schedule",
        expression: t.expression.trim(),
        prompt: t.prompt,
        ...(typeof t.timezone === "string" && t.timezone ? { timezone: t.timezone } : {}),
      };
      out.push(schedule);
      continue;
    }
    if (t.type === "slack") {
      if (slackSeen) return null; // at most one Slack app per agent
      slackSeen = true;
      const channels = parseSlackChannels(t.channels);
      if (!channels) return null;
      const slack: Trigger = {
        type: "slack",
        channels,
        ...(isSlackId(t.appId, "A") ? { appId: t.appId as string } : {}),
        ...(isSlackId(t.teamId, "T") ? { teamId: t.teamId as string } : {}),
        ...(typeof t.teamName === "string" && t.teamName.trim()
          ? { teamName: t.teamName.trim().slice(0, MAX_SLACK_NAME) }
          : {}),
        ...(isSlackId(t.botUserId, "U", "B") ? { botUserId: t.botUserId as string } : {}),
        ...(Array.isArray(t.grantedScopes)
          ? {
              grantedScopes: t.grantedScopes
                .filter((x): x is string => typeof x === "string")
                .slice(0, MAX_SLACK_SCOPES),
            }
          : {}),
        ...(t.urlVerified === true ? { urlVerified: true } : {}),
        ...(t.allChannels === true ? { allChannels: true } : {}),
      };
      out.push(slack);
      continue;
    }
    return null; // unknown trigger type
  }
  return out;
}

/** Caps on Slack trigger fields. A channel list is an allowlist, not a bulk import. */
const MAX_SLACK_CHANNELS = 25;
const MAX_SLACK_NAME = 80;
const MAX_SLACK_SCOPES = 50;

/**
 * Slack ids are an uppercase letter prefix + base32-ish body, e.g. `A0123ABCD`, `T0…`, `C0…`.
 * We validate the SHAPE only - the real check is that Slack accepts it - but a shape check
 * keeps junk out of the config and, for channels, out of the routing decision.
 */
function isSlackId(value: unknown, ...prefixes: string[]): boolean {
  return (
    typeof value === "string" &&
    value.length >= 2 &&
    value.length <= 32 &&
    prefixes.some((p) => value.startsWith(p)) &&
    /^[A-Z][A-Z0-9]+$/.test(value)
  );
}

/**
 * Channels the agent may answer in. An EMPTY list is valid and means "answer nowhere" - the
 * fail-closed default for a freshly created trigger, before the user has picked a channel.
 * `C` = public channel, `G` = private channel/group, `D` = DM (accepted so a future DM mode
 * needs no wire change, though v1 subscribes only to app_mention).
 */
function parseSlackChannels(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SLACK_CHANNELS) return null;
  const seen = new Set<string>();
  for (const c of value) {
    if (!isSlackId(c, "C", "G", "D")) return null;
    seen.add(c as string);
  }
  return [...seen];
}

/** Caps on skills/integrations attached + env vars per agent (payload-size + abuse guards). */
const MAX_SKILLS = 25;
const MAX_INTEGRATIONS = 25;
const MAX_ENV_VARS = 50;
const MAX_ENV_KEY = 128;
const MAX_ENV_VALUE = 4096;
/** Env var keys: POSIX-ish (letters, digits, underscore; not leading-digit). */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate an id-reference array: non-empty strings, de-duped, bounded. Null if malformed. */
function parseIdList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > max) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || !v) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Validate a `skillIds` array: strings, de-duped, bounded. Null if malformed. */
export function parseSkillIds(value: unknown): string[] | null {
  return parseIdList(value, MAX_SKILLS);
}

/** Validate an `integrationIds` array: strings, de-duped, bounded. Null if malformed. */
export function parseIntegrationIds(value: unknown): string[] | null {
  return parseIdList(value, MAX_INTEGRATIONS);
}

/**
 * Validate a per-agent `env` map: string→string, keys POSIX-ish + unique, values
 * bounded, count bounded. Null if malformed. (Values may be secrets; we don't
 * inspect them beyond a size cap.)
 */
export function parseEnv(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ENV_VARS) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (k.length > MAX_ENV_KEY || !ENV_KEY_RE.test(k)) return null;
    if (typeof v !== "string" || v.length > MAX_ENV_VALUE) return null;
    out[k] = v;
  }
  return out;
}

/**
 * The same validation, but reporting WHICH fields are wrong so the 400 can tell the
 * caller what to fix (mirrors `parseSkillDoc`'s `errors`, which the skills routes
 * already surface as `details`). Every message names the field and the rule.
 */
export function parseConfigDetailed(
  body: unknown,
  partial: boolean,
): { ok: true; config: Partial<AgentConfig> } | { ok: false; errors: string[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const b = body as Record<string, unknown>;
  const out: Partial<AgentConfig> = {};
  const errors: string[] = [];

  if ("name" in b) {
    if (typeof b.name !== "string" || !b.name.trim()) errors.push("`name` must be a non-empty string");
    else if (b.name.length > MAX_NAME) errors.push(`\`name\` must be at most ${MAX_NAME} characters`);
    else out.name = b.name.trim();
  }
  if ("systemPrompt" in b) {
    if (typeof b.systemPrompt !== "string") errors.push("`systemPrompt` must be a string");
    else if (b.systemPrompt.length > MAX_SYSTEM_PROMPT) {
      errors.push(`\`systemPrompt\` must be at most ${MAX_SYSTEM_PROMPT} characters`);
    } else out.systemPrompt = b.systemPrompt;
  }
  if ("model" in b) {
    if (!MODEL_KEYS.includes(b.model as never)) {
      errors.push(`\`model\` must be one of: ${MODEL_KEYS.join(", ")}`);
    } else out.model = b.model as AgentConfig["model"];
  }
  for (const flag of ["baseTools", "webSearch", "networkAccess"] as const) {
    if (flag in b) {
      if (typeof b[flag] !== "boolean") errors.push(`\`${flag}\` must be a boolean`);
      else out[flag] = b[flag] as boolean;
    }
  }
  if ("networkMode" in b) {
    if (b.networkMode !== "public" && b.networkMode !== "isolated") {
      errors.push('`networkMode` must be "public" or "isolated"');
    } else out.networkMode = b.networkMode;
  }
  if ("triggers" in b) {
    const triggers = parseTriggers(b.triggers);
    if (!triggers) {
      errors.push(
        "`triggers` must be an array of { type: \"api\" } and/or one " +
          '{ type: "schedule", expression, prompt, timezone? } - the expression must be a valid ' +
          `cron(...)/rate(...) no more often than every ${MIN_SCHEDULE_MINUTES} minutes`,
      );
    } else out.triggers = triggers;
  }
  if ("skillIds" in b) {
    const ids = parseSkillIds(b.skillIds);
    if (!ids) errors.push("`skillIds` must be an array of skill id strings");
    else out.skillIds = ids;
  }
  if ("integrationIds" in b) {
    const ids = parseIntegrationIds(b.integrationIds);
    if (!ids) errors.push("`integrationIds` must be an array of integration id strings");
    else out.integrationIds = ids;
  }
  if ("env" in b) {
    const env = parseEnv(b.env);
    if (!env) errors.push("`env` must be an object of string keys to string values");
    else out.env = env;
  }

  if (!partial) {
    for (const k of ["name", "systemPrompt", "model"] as const) {
      // Only report as missing if it wasn't already reported as invalid above.
      if (!(k in out) && !(k in b)) errors.push(`\`${k}\` is required`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, config: out };
}

/** Apply defaults to a validated partial config on create. */
export function withDefaults(c: Partial<AgentConfig>): AgentConfig {
  return {
    name: c.name!,
    systemPrompt: c.systemPrompt!,
    model: c.model!,
    baseTools: c.baseTools ?? true,
    webSearch: c.webSearch ?? false,
    networkAccess: c.networkAccess ?? true,
    triggers: c.triggers ?? [{ type: "api" }],
    // networkMode defaults to public; normalizeConfig (repo/agents) drops the
    // "public" default and enforces the isolated coupling (webSearch off, etc.).
    ...(c.networkMode === "isolated" ? { networkMode: "isolated" as const } : {}),
    // Optional; only present when the creator attached skills / integrations / set env vars.
    ...(c.skillIds && c.skillIds.length ? { skillIds: c.skillIds } : {}),
    ...(c.integrationIds && c.integrationIds.length ? { integrationIds: c.integrationIds } : {}),
    ...(c.env && Object.keys(c.env).length ? { env: c.env } : {}),
  };
}
