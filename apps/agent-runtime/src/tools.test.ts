import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxed, buildBaseTools } from "./tools.js";

describe("sandboxed path guard", () => {
  const root = "/work/s1";

  it("allows the sandbox root and paths within it", () => {
    expect(sandboxed(root, ".")).toBe("/work/s1");
    expect(sandboxed(root, "a.txt")).toBe("/work/s1/a.txt");
    expect(sandboxed(root, "sub/b.txt")).toBe("/work/s1/sub/b.txt");
    expect(sandboxed(root, "sub/../a.txt")).toBe("/work/s1/a.txt");
  });

  it("rejects parent-traversal escapes", () => {
    expect(sandboxed(root, "../../etc/passwd")).toBeNull();
    expect(sandboxed(root, "../other/x")).toBeNull();
  });

  it("rejects absolute paths outside the sandbox", () => {
    expect(sandboxed(root, "/etc/passwd")).toBeNull();
  });

  it("rejects the sibling-prefix escape (regression: /work/s1 vs /work/s1-evil)", () => {
    // `../s1-evil/x` resolves to `/work/s1-evil/x`, which naively startsWith
    // `/work/s1` - the bug this guard must reject.
    expect(sandboxed(root, "../s1-evil/secret")).toBeNull();
  });
});

describe("base tools (real filesystem, sandboxed to a temp dir)", () => {
  let workDir: string;

  // Tools read WORK_ROOT at call time; point it at a fresh temp dir per test.
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "af-tools-"));
    process.env.WORK_ROOT = workDir;
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  /** Invoke a tool's callback directly by name, optionally with an agent env. */
  function toolByName(name: string, agentEnv: Record<string, string> = {}) {
    const tools = buildBaseTools(agentEnv);
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool not found: ${name}`);
    // The zod tool exposes its callback via invoke().
    return (input: unknown) => (t as unknown as { invoke: (i: unknown) => Promise<unknown> }).invoke(input);
  }

  it("exposes exactly the expected base tools", () => {
    const names = buildBaseTools().map((t) => t.name).sort();
    expect(names).toEqual(["edit_file", "read_file", "run_bash", "write_file"]);
  });

  it("write_file then read_file round-trips", async () => {
    const write = toolByName("write_file");
    const read = toolByName("read_file");
    const w = (await write({ path: "notes.txt", content: "hello" })) as { ok: boolean; bytes: number };
    expect(w.ok).toBe(true);
    expect(w.bytes).toBe(5);
    const r = (await read({ path: "notes.txt" })) as { content: string };
    expect(r.content).toBe("hello");
  });

  it("read_file returns {error,hint} (never throws) for a missing file", async () => {
    const read = toolByName("read_file");
    const r = (await read({ path: "missing.txt" })) as { error: string; hint: string };
    expect(r.error).toBe("not_found");
    expect(r.hint).toBeTruthy();
  });

  it("edit_file replaces the first match; reports no_match otherwise", async () => {
    const write = toolByName("write_file");
    const edit = toolByName("edit_file");
    const read = toolByName("read_file");
    await write({ path: "f.txt", content: "aXa" });
    const ok = (await edit({ path: "f.txt", find: "X", replace: "Y" })) as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(((await read({ path: "f.txt" })) as { content: string }).content).toBe("aYa");
    const miss = (await edit({ path: "f.txt", find: "ZZZ", replace: "!" })) as { error: string };
    expect(miss.error).toBe("no_match");
  });

  it("blocks a path-traversal escape in write_file", async () => {
    const write = toolByName("write_file");
    const r = (await write({ path: "../escape.txt", content: "x" })) as { error: string };
    expect(r.error).toBe("bad_path");
  });

  it("run_bash returns stdout for a successful command", async () => {
    const bash = toolByName("run_bash");
    const r = (await bash({ command: "echo hi" })) as { stdout: string };
    expect(r.stdout.trim()).toBe("hi");
  });

  it("run_bash returns {error,hint} (never throws) for a failing command", async () => {
    const bash = toolByName("run_bash");
    const r = (await bash({ command: "exit 3" })) as { error: string; hint: string };
    expect(r.error).toBe("command_failed");
    expect(r.hint).toBeTruthy();
  });

  it("run_bash CANNOT read the runtime's process.env (platform secrets fenced off)", async () => {
    // Simulate a platform secret in the runtime process env - the agent must not see it.
    process.env.RUNTIME_INGEST_KEY = "super-secret-ingest-key";
    try {
      const bash = toolByName("run_bash"); // no agentEnv
      const r = (await bash({ command: "echo key=[$RUNTIME_INGEST_KEY]" })) as { stdout: string };
      expect(r.stdout).toContain("key=[]"); // empty - not inherited
      expect(r.stdout).not.toContain("super-secret-ingest-key");
    } finally {
      delete process.env.RUNTIME_INGEST_KEY;
    }
  });

  it("run_bash CAN read the agent's own config.env (the feature still works)", async () => {
    const bash = toolByName("run_bash", { MY_API_KEY: "abc123" });
    const r = (await bash({ command: "echo val=[$MY_API_KEY]" })) as { stdout: string };
    expect(r.stdout).toContain("val=[abc123]");
  });

  describe("tools never throw, even when the workspace is unusable", () => {
    /**
     * The load-bearing convention (CLAUDE.md rule 5): a tool returns `{error, hint}` so
     * the model can adapt. The mkdir/write calls used to sit OUTSIDE each tool's try, so
     * an agent that broke its own workspace got a raw EEXIST/EISDIR thrown at the
     * executor with no hint - and the first case below wedges EVERY later call for the
     * microVM's whole lifetime, which is exactly when the hint matters most.
     */
    it("returns an error when the work dir itself is a FILE, not a directory", async () => {
      // Self-inflicted and reachable: `run_bash: rm -rf <workdir> && touch <workdir>`.
      await rm(workDir, { recursive: true, force: true });
      await writeFile(workDir, "not a directory", "utf8");
      for (const name of ["read_file", "write_file", "edit_file"]) {
        const res = (await toolByName(name)({ path: "a.txt", content: "x", find: "x", replace: "y" })) as {
          error?: string;
          hint?: string;
        };
        expect(res.error, `${name} must not throw`).toBe("io_failed");
        expect(res.hint).toContain("working directory");
      }
      // Restore so afterEach's rm(recursive) can clean up.
      await rm(workDir, { force: true });
      await mkdir(workDir, { recursive: true });
    });

    it("returns an error when a path component is a file, not a directory", async () => {
      // write_file{path:"notes"} then write_file{path:"notes/deep.txt"}.
      await toolByName("write_file")({ path: "notes", content: "hi" });
      const res = (await toolByName("write_file")({ path: "notes/deep.txt", content: "x" })) as {
        error?: string;
      };
      expect(res.error).toBe("io_failed");
    });

    it("returns an error when the target is a directory", async () => {
      await mkdir(join(workDir, "d"), { recursive: true });
      const res = (await toolByName("write_file")({ path: "d", content: "x" })) as { error?: string };
      expect(res.error).toBe("io_failed");
    });
  });
});
