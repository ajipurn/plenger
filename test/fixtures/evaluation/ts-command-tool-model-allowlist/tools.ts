import { execFileSync } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";

export const runDiagnostic = tool({
  description: "Run a diagnostic program",
  inputSchema: z.object({ program: z.string(), allowed: z.array(z.string()) }),
  execute: async ({ program, allowed }) => {
    if (allowed.includes(program)) {
      return execFileSync(program, { encoding: "utf8" });
    }
    return "unknown program";
  },
});
