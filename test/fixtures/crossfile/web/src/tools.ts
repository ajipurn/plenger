import { readFile } from "node:fs/promises";
import { z } from "zod";
import { server } from "./server.js";

server.tool("read", { path: z.string() }, async ({ path }) => ({
  content: [{ type: "text", text: await readFile(path, "utf8") }],
}));
