import { spawn } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";

const REFS = ["main", "release"];

export const gitLog = tool({
  description: "Show the history of a branch",
  inputSchema: z.object({ ref: z.string() }),
  execute: async ({ ref }) => {
    if (!REFS.includes(ref)) throw new Error("unknown branch");
    return spawn("git", ["log", "--oneline", ref]);
  },
});
