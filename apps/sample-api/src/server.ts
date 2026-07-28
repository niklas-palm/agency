/**
 * Local entrypoint: run the sample API as a plain Node HTTP server (same app the
 * Lambda adapter serves in prod - see lambda.ts).
 */
import { serve } from "@hono/node-server";
import { buildSampleApp } from "./app.js";

const port = Number(process.env.PORT ?? 8686);
serve({ fetch: buildSampleApp().fetch, port }, (info) => {
  console.log(`sample-api listening on :${info.port}`);
});
