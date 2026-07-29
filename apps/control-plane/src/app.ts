/**
 * Composition root. Builds the Hono app, choosing the scheduler + invoker
 * implementations from MODE (local vs prod). This is the single place the
 * local/prod seam is resolved; everything downstream depends only on the
 * interfaces. (There's no runtime provisioner: the shared runtime pool is owned
 * by CDK, and agents are pure config - creating one is just a DynamoDB write.)
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { IS_LOCAL, USER_POOL_ID } from "./config.js";
import { logRequest } from "./log.js";
import { ORG_HEADER } from "./auth.js";
import type { ScheduleProvisioner } from "./provisioner/schedule.js";
import { LocalScheduleProvisioner } from "./provisioner/schedule-local.js";
import { EventBridgeScheduleProvisioner } from "./provisioner/schedule-eventbridge.js";
import type { AgentInvoker } from "./invoker/invoker.js";
import { HttpAgentInvoker } from "./invoker/local.js";
import { AgentCoreInvoker } from "./invoker/agentcore.js";
import type { IdentityProvider } from "./identity/identity.js";
import { LocalIdentityProvider } from "./identity/local.js";
import { CognitoIdentityProvider } from "./identity/cognito.js";
import { buildRoutes } from "./routes.js";

export interface Deps {
  scheduler: ScheduleProvisioner;
  invoker: AgentInvoker;
  identity: IdentityProvider;
}

export function buildDeps(): Deps {
  // Identity is gated on a configured pool, not on MODE: prod sets USER_POOL_ID
  // (invites provision a Cognito login), while its absence - local dev, or a
  // deploy that hasn't wired it - falls back to the no-op so invites still work
  // (they just don't send a sign-in email).
  const identity: IdentityProvider = USER_POOL_ID
    ? new CognitoIdentityProvider(USER_POOL_ID)
    : new LocalIdentityProvider();
  return IS_LOCAL
    ? {
        scheduler: new LocalScheduleProvisioner(),
        invoker: new HttpAgentInvoker(),
        identity,
      }
    : {
        scheduler: new EventBridgeScheduleProvisioner(),
        invoker: new AgentCoreInvoker(),
        identity,
      };
}

/** AWS error names that mean "transient - the client should retry". */
const RETRYABLE_ERRORS = new Set([
  "ThrottlingException",
  "ConflictException",
  "ResourceNotReady",
  "ServiceQuotaExceededException",
  "TooManyRequestsException",
  "InternalServerException",
  "TimeoutError",
]);

/** True if an AWS SDK error is transient - by name, retryable flag, or 429/5xx. */
export function isTransient(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
  if (e.name && RETRYABLE_ERRORS.has(e.name)) return true;
  if (e.$retryable) return true;
  const status = e.$metadata?.httpStatusCode;
  return status === 429 || status === 500 || status === 503;
}

export function buildApp(deps: Deps = buildDeps()): Hono {
  const app = new Hono();

  // CORS in the app (not API Gateway): the `ANY /{proxy+}` integration routes
  // even OPTIONS preflights to this Lambda, so the app must answer them - else
  // requireAuth would 401 the preflight. Bearer-token auth (no cookies), so a
  // wildcard origin is fine.
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      // ORG_HEADER (X-Agency-Org) rides every authed request to select the active
      // org, so it must be allowed through preflight or the browser blocks the call.
      allowHeaders: ["Authorization", "Content-Type", ORG_HEADER],
    }),
  );

  // One line per request - failures always, successes only under DEBUG (log.ts).
  // Registered before the routes so it times the whole handler, and it covers a
  // handler that THREW too: Hono's onError produces the response inside the compose
  // chain, so `next()` resolves and `c.res` already carries the 500/503.
  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    logRequest(c.req.method, c.req.path, c.res.status, Date.now() - started);
  });

  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/", buildRoutes(deps));

  // Map transient AWS errors to 503 so callers can distinguish "retry me" from a
  // permanent failure; everything else is a generic 500 (no stack leaked).
  app.onError((err, c) => {
    // Method, path and status come from the request line the middleware above logs
    // for every failure, so these two only add what it can't know: WHICH error.
    if (isTransient(err)) {
      // Logged, not swallowed: a throttle/conflict storm used to be visible only as
      // 503s on the client side, with nothing naming which dependency was throttling.
      console.error("transient error", (err as Error).name);
      return c.json({ error: "temporarily unavailable, retry shortly" }, 503);
    }
    console.error("unhandled error", err);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
