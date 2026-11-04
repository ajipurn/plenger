import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { findExecutable } from "../shared/executable.ts";
import type { SourceRevision } from "./model.ts";

const execute = promisify(execFile);

/**
 * Run one fixed, read-only Git command in `root`. Filesystem monitors, hooks and optional
 * index writes are off, and inherited `GIT_*` variables are dropped. Callers never read
 * working-tree status: comparing files runs the clean and process filter drivers that the
 * project's own `.git/config` and attributes name, so a project could run commands on the
 * host. Object reads (`rev-parse`, `ls-tree`, `cat-file blob`) run no filters. Git runs
 * by its absolute path on PATH from the home folder, so a `git.exe` in the project, which
 * Windows would find first by name, never runs.
 */
export async function readGit(
  root: string,
  args: string[],
  limits: { maxBuffer?: number; timeout?: number } = {},
): Promise<Buffer> {
  const git = findExecutable("git");
  if (git === null) throw new Error("Git was not found on PATH.");
  const { stdout } = await execute(
    git,
    [
      "--no-pager",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      root,
      ...args,
    ],
    {
      cwd: homedir(),
      encoding: "buffer",
      timeout: limits.timeout ?? 5000,
      maxBuffer: limits.maxBuffer ?? 128 * 1024,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        ),
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  return stdout;
}

/** Read the commit and branch only. `dirty` is always unknown, see `readGit`. */
export async function sourceRevision(root: string): Promise<SourceRevision> {
  const read = async (args: string[]) => (await readGit(root, args)).toString("utf8").trim();
  try {
    const commit = await read(["rev-parse", "--verify", "HEAD"]);
    if (!/^[a-f0-9]{40,64}$/.test(commit)) return { commit: null, branch: null, dirty: null };
    const branch = await read(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => null);
    return { commit, branch, dirty: null };
  } catch {
    return { commit: null, branch: null, dirty: null };
  }
}
