import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SourceRevision } from "./model.ts";

const execute = promisify(execFile);
/**
 * Read the commit and branch only. Disable filesystem monitors, hooks, and optional index
 * writes. Working-tree status is never read: comparing files runs the clean and process
 * filter drivers that the project's own `.git/config` and attributes name, so a project
 * could run commands on the host. `dirty` is therefore always unknown.
 */
export async function sourceRevision(root: string): Promise<SourceRevision> {
  const read = async (args: string[]) =>
    (
      await execute(
        "git",
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
          timeout: 5000,
          maxBuffer: 128 * 1024,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
            ),
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      )
    ).stdout.trim();
  try {
    const commit = await read(["rev-parse", "--verify", "HEAD"]);
    if (!/^[a-f0-9]{40,64}$/.test(commit)) return { commit: null, branch: null, dirty: null };
    const branch = await read(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => null);
    return { commit, branch, dirty: null };
  } catch {
    return { commit: null, branch: null, dirty: null };
  }
}
