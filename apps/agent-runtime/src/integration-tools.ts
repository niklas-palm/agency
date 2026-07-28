/**
 * Integration tools: how an agent reaches its attached downstream APIs WITHOUT
 * ever seeing a credential. Two tools, wired only when the invoke payload carries
 * resolved integrations:
 *
 *  - `list_integration_operations` - discovery. Answers "what CAN I call?" from the
 *    in-memory manifest that rode the invoke payload (server-authoritative, like
 *    skills). Just because the agent can POST to the proxy doesn't mean it knows
 *    which operations exist - this tool is that knowledge.
 *  - `call_integration` - invocation. POSTs to the control-plane proxy
 *    (`/internal/integrations/call`) reusing the per-session ingest token; the proxy
 *    authorizes the call against the token's grant, injects the credential, and
 *    forwards ONLY to the integration's stored baseUrl. The credential never reaches
 *    the runtime, so there's nothing here for a compromised agent to steal.
 *
 * Both follow the platform convention: never throw - return `{ error, hint }` so the
 * model reads the hint and adapts.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import type { ResolvedIntegration, IntegrationCallRequest } from "@agency/shared";
import { postIngestRaw } from "./ingest.js";
import { workDir, sandboxed } from "./tools.js";

/** Outer deadline for a proxy call; the proxy itself caps the downstream request. */
const CALL_TIMEOUT_MS = 20_000;

export interface IntegrationToolContext {
  agentId: string;
  sessionId: string;
}

/**
 * Build the integration tools bound to the resolved manifest + this turn's
 * identity. `integrations` is the server-resolved list from the invoke payload
 * (no baseUrl, no secret - just id/name/description/operations). Returns an empty
 * list when there are none, so the caller can spread unconditionally.
 */
export function buildIntegrationTools(
  integrations: ResolvedIntegration[],
  ctx: IntegrationToolContext,
) {
  if (!integrations.length) return [];

  const byId = new Map(integrations.map((i) => [i.id, i]));

  const listTool = tool({
    name: "list_integration_operations",
    description:
      "List the downstream API integrations this agent can call and their available " +
      "operations. Call this to discover valid integrationId + operationId values " +
      "before using call_integration.",
    inputSchema: z.object({}),
    callback: async () => ({
      integrations: integrations.map((i) => ({
        integrationId: i.id,
        name: i.name,
        description: i.description,
        operations: i.operations.map((o) => ({
          operationId: o.operationId,
          summary: o.summary,
          method: o.method,
          path: o.path,
        })),
      })),
    }),
  });

  const callTool = tool({
    name: "call_integration",
    description:
      "Call one operation of an attached integration. The platform injects the " +
      "credential and forwards to the configured API - you never handle secrets. " +
      "Use list_integration_operations to find valid ids. By default the response is " +
      "returned to you directly (fine for reads, writes, and small results). When you " +
      "intend to process a response (parse, compute over, or page through a large " +
      "dataset) rather than just read it, pass `outputPath` (e.g. data/result.json): the " +
      "body is written to that file in your workspace instead of being returned, and you " +
      "get back { status, path, bytes }. For a paginated API, use a distinct outputPath " +
      "per page.",
    inputSchema: z.object({
      integrationId: z.string().describe("Which integration, from list_integration_operations."),
      operationId: z.string().describe("Which operation of that integration."),
      pathParams: z
        .record(z.string(), z.string())
        .optional()
        .describe("Values for {placeholder} segments in the operation path."),
      query: z.record(z.string(), z.string()).optional().describe("Query-string parameters (incl. paging like page/limit/cursor)."),
      body: z.unknown().optional().describe("JSON request body for write operations."),
      outputPath: z
        .string()
        .optional()
        .describe(
          "Relative path in your workspace to write the raw response body to (e.g. " +
            "data/pets.json) INSTEAD of returning it. Use for large results or data " +
            "you'll process with run_bash. Returns { status, path, bytes }.",
        ),
    }),
    callback: async ({ integrationId, operationId, pathParams, query, body, outputPath }) => {
      // Fail locally on an unknown integration - the manifest is authoritative, so
      // there's no point round-tripping the proxy (which would 403/404 anyway).
      if (!byId.has(integrationId)) {
        return {
          error: "unknown integration",
          hint: "call list_integration_operations to see the integrations you can use",
        };
      }
      // Validate the output path BEFORE the network call - fail fast, and never fetch
      // just to discard the result on a bad path. Confined to the workspace exactly
      // like write_file (no absolute paths, no `..` escape). Also reject a path that
      // resolves to the workspace root itself (empty / "."): it's a directory, so the
      // write would fail late with a vague error - catch it up front. `relPath` is the
      // normalized path we echo in the receipt (so a trailing slash / "." segment can't
      // hand the model a path that doesn't match the file we wrote).
      const root = workDir();
      let full: string | null = null;
      let relPath = "";
      if (outputPath !== undefined) {
        full = sandboxed(root, outputPath);
        if (!full || full === resolve(root)) {
          return {
            error: "bad_path",
            hint: "outputPath must be a relative file path inside your workspace (no leading / or .., and not empty).",
          };
        }
        relPath = relative(root, full);
      }
      const req: IntegrationCallRequest = {
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        integrationId,
        operationId,
        pathParams,
        query,
        body,
        // Persisting to disk → the body won't hit the context, so ask for the large cap.
        ...(outputPath !== undefined ? { largeResponse: true } : {}),
      };
      const res = await postIngestRaw("/internal/integrations/call", req, CALL_TIMEOUT_MS);
      if (!res) {
        return {
          error: "integration call failed",
          hint: "the integrations proxy could not be reached; try again",
        };
      }
      // The proxy returns { error, hint } on a 4xx (auth/shape/downstream) - pass it
      // straight through so the model gets the adapt-able hint. On success it returns
      // { status, body } (the downstream response). Anything else (e.g. a 500 with a
      // non-JSON body → json is null) becomes a synthesized { error, hint } so the
      // model never gets a bare null (tools always return { error, hint } or a result).
      if (!res.json || typeof res.json !== "object") {
        return {
          error: "integration call failed",
          hint: `the proxy returned status ${res.status} with no usable body; try again or check the integration`,
        };
      }
      const result = res.json as Record<string, unknown>;
      // No outputPath, or the proxy returned an { error, hint }: return as-is (the error
      // path never writes a file, so a failed call leaves no misleading artifact).
      if (full === null || "error" in result) return result;

      // Persist the downstream body to the confined workspace path and return a receipt
      // (status + where it landed + size) instead of the body itself.
      const downstreamBody = typeof result.body === "string" ? result.body : "";
      try {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, downstreamBody, "utf8");
      } catch {
        return {
          error: "write_failed",
          hint: `could not write the response to ${relPath}; check the path and try again`,
        };
      }
      const status = typeof result.status === "number" ? result.status : 0;
      const receipt: Record<string, unknown> = {
        status,
        path: relPath,
        bytes: Buffer.byteLength(downstreamBody),
      };
      // The body was persisted, so the model can't see it - surface the two things it
      // can't otherwise know: a non-success status (don't process an error body as data)
      // and truncation (the data is partial - page the API instead of computing on it).
      if (status >= 400) {
        receipt.hint = `downstream returned status ${status}; the file holds an error response, not data - verify before using.`;
      } else if (result.truncated === true) {
        receipt.truncated = true;
        receipt.hint = "response exceeded the size cap and was TRUNCATED - the file is partial; page the API (query params) to get the rest.";
      }
      return receipt;
    },
  });

  return [listTool, callTool];
}
