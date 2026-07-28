/**
 * Prod entrypoint: adapt the same sample-API Hono app to AWS Lambda behind API
 * Gateway. Zero application-code changes vs. the local Node server - only the
 * adapter (mirrors the control-plane's local⇄prod seam).
 */
import { handle } from "hono/aws-lambda";
import { buildSampleApp } from "./app.js";

export const handler = handle(buildSampleApp());
