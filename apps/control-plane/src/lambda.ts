/**
 * Prod entrypoint: adapt the same Hono app to AWS Lambda behind API Gateway.
 * Zero application code changes vs. the local Node server - only the adapter.
 */
import { handle } from "hono/aws-lambda";
import { buildApp } from "./app.js";

export const handler = handle(buildApp());
