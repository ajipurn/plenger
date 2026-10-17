import { spawn } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";

export const gitLog = tool({
  description: "Show the history of a ref",
  inputSchema: z.object({ ref: z.string() }),
  execute: async ({ ref }) => spawn("git", ["log", "--oneline", ref]),
});
