import { execFileSync } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";

const PROGRAMS = ["uptime", "whoami"];

export const runDiagnostic = tool({
  description: "Run a diagnostic program",
  inputSchema: z.object({ program: z.string() }),
  execute: async ({ program }) => {
    if (PROGRAMS.includes(program)) {
      return execFileSync(program, { encoding: "utf8" });
    }
    return "unknown program";
  },
});
