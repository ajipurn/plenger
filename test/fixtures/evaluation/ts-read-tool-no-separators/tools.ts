import { readFile } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";

export const readNote = tool({
  description: "Read a note",
  inputSchema: z.object({ name: z.string() }),
  execute: async ({ name }) => {
    if (name.includes("/") || name.includes("..")) throw new Error("invalid note name");
    return readFile(`notes/${name}.md`, "utf8");
  },
});
