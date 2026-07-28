/**
 * Base coding toolset. A lean, sandboxed set (read/write/edit/bash - listing,
 * globbing, and searching are done via run_bash) that is enough for agents to do
 * real work and for the trajectory to show meaningful tool usage. All tools
 * operate under a single working directory and follow the
 * platform convention: never throw - return `{ error, hint }` so the model reads
 * the hint and adapts.
 *
 * Web tools (search + fetch) live in web-tools.ts; richer capabilities (MCP
 * servers, external APIs) are layered on in later iterations. This file stays
 * intentionally small - base coding tools only.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
import { tool } from "@strands-agents/sdk";
import { z } from "zod";

const execAsync = promisify(exec);

/**
 * The agent's single working directory. AgentCore gives each session its own
 * isolated microVM filesystem, so one working dir per process is all we need -
 * no per-session subdir. Exported so the integration tools can persist a response
 * to the SAME workspace the base tools (read_file/run_bash) operate in.
 */
export function workDir(): string {
  return process.env.WORK_ROOT ?? "/tmp/agency-work";
}

/**
 * Resolve a path inside the working directory, refusing escapes. Returns the
 * absolute path if it is the working dir itself or strictly within it, else null.
 *
 * The check compares against `dir + sep` (not a bare prefix) so a sibling
 * directory whose name merely starts with the working dir's - e.g. dir `/work/w`
 * and path `../w-evil` → `/work/w-evil` - is correctly rejected. This is tool
 * path-traversal safety (stop `../../etc/passwd`), independent of AgentCore's
 * session isolation. Exported for testing.
 */
export function sandboxed(dir: string, p: string): string | null {
  const root = resolve(dir);
  const full = resolve(root, p);
  return full === root || full.startsWith(root + sep) ? full : null;
}

const ESCAPE_HINT = "Path escapes the working directory. Use a relative path inside it.";

/**
 * Build the base toolset bound to the working directory. `agentEnv` is the agent's
 * own `config.env` (key→value) that `run_bash` should see - and ONLY that, plus a
 * minimal safe base. We do NOT spread the runtime's `process.env`: it holds
 * platform internals (gateway/ingest URLs, AGENTCORE_* plumbing) the agent has no
 * business reading. So bash gets an explicit, allow-listed environment - the user's
 * own vars are available, our internals are not. NOTE: this fence covers bash's OWN
 * env only; `cat /proc/1/environ` still exposes PID 1's env, which is why we keep no
 * SECRET in the runtime's process env at all (the ingest token is a module variable
 * from the payload, not env; AWS creds come via MMDS) - see docs/runtime.md.
 */
export function buildBaseTools(agentEnv: Record<string, string> = {}) {
  const dir = workDir();
  // A minimal safe base for a working shell + the agent's own vars. Notably NO
  // process.env spread - that's the whole point.
  const bashEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    ...agentEnv,
  };

  const ensureDir = async () => {
    await mkdir(dir, { recursive: true });
  };

  /**
   * Run a filesystem tool body, turning any I/O throw into `{ error, hint }`.
   *
   * Tools never throw (CLAUDE.md rule 5, and the base prompt promises the model an
   * `{error, hint}` it can adapt to). The `ensureDir`/`mkdir`/`writeFile` calls used to
   * sit OUTSIDE each tool's try, so an agent that made its own workspace path
   * unusable - `run_bash: rm -rf <workdir> && touch <workdir>`, or writing a file and
   * then treating it as a directory - got a raw EEXIST/EISDIR/EACCES thrown at the
   * executor, with no hint. The first case wedges every later call for the microVM's
   * whole lifetime, which is exactly when the model most needs to be told what broke.
   */
  const io = async <T>(what: string, body: () => Promise<T>): Promise<T | { error: string; hint: string }> => {
    try {
      await ensureDir();
      return await body();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return {
        error: "io_failed",
        hint: `Could not ${what}: ${detail}. The working directory may be in a bad state - check it with run_bash (e.g. \`ls -la\`).`,
      };
    }
  };

  const readFileTool = tool({
    name: "read_file",
    description: "Read a UTF-8 text file from the working directory.",
    inputSchema: z.object({ path: z.string().describe("Relative path in the working directory.") }),
    callback: async ({ path }) =>
      io(`read ${path}`, async () => {
        const full = sandboxed(dir, path);
        if (!full) return { error: "bad_path", hint: ESCAPE_HINT };
        try {
          return { content: await readFile(full, "utf8") };
        } catch {
          return { error: "not_found", hint: `No file at ${path}. Create it with write_file first.` };
        }
      }),
  });

  const writeFileTool = tool({
    name: "write_file",
    description: "Write (create or overwrite) a UTF-8 text file in the working directory.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    callback: async ({ path, content }) =>
      io(`write ${path}`, async () => {
        const full = sandboxed(dir, path);
        if (!full) return { error: "bad_path", hint: ESCAPE_HINT };
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, "utf8");
        return { ok: true, bytes: Buffer.byteLength(content) };
      }),
  });

  const editFileTool = tool({
    name: "edit_file",
    description: "Replace the first occurrence of a string in a file.",
    inputSchema: z.object({ path: z.string(), find: z.string(), replace: z.string() }),
    callback: async ({ path, find, replace }) =>
      io(`edit ${path}`, async () => {
        const full = sandboxed(dir, path);
        if (!full) return { error: "bad_path", hint: ESCAPE_HINT };
        let text: string;
        try {
          text = await readFile(full, "utf8");
        } catch {
          return { error: "not_found", hint: `No file at ${path}.` };
        }
        if (!text.includes(find)) {
          return { error: "no_match", hint: "The `find` string was not present. Read the file first." };
        }
        await writeFile(full, text.replace(find, replace), "utf8");
        return { ok: true };
      }),
  });

  const runBashTool = tool({
    name: "run_bash",
    description: "Run a bash command in the working directory. 60s timeout, output truncated.",
    inputSchema: z.object({ command: z.string() }),
    callback: async ({ command }) => {
      await ensureDir();
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: dir,
          timeout: 60_000,
          // SIGKILL (not the default SIGTERM) on timeout, so a command that
          // traps/ignores SIGTERM is still terminated.
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
          // Explicit allow-listed env (NOT process.env) so the agent's bash can
          // read its own config.env but not the runtime's platform secrets.
          env: bashEnv,
        });
        return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000) };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        return {
          error: "command_failed",
          hint: "The command exited non-zero or timed out. Check stderr and adjust.",
          stdout: (e.stdout ?? "").slice(0, 4000),
          stderr: (e.stderr ?? e.message ?? "").slice(0, 4000),
        };
      }
    },
  });

  return [readFileTool, writeFileTool, editFileTool, runBashTool];
}
