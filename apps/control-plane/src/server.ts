/**
 * Local entrypoint: run the Hono app as a plain Node HTTP server. This is the
 * exact same app that runs on Lambda in prod (see lambda.ts) - only the adapter
 * differs, giving a faithful local replica.
 */
import { serve } from "@hono/node-server";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: buildApp().fetch, port }, (info) => {
  console.log(`control-plane listening on :${info.port}`);
});
