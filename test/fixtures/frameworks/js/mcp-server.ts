import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exec } from "node:child_process";
import { z } from "zod";

const server = new McpServer({ name: "shell", version: "1.0.0" });

server.tool("run", { command: z.string() }, async ({ command }) => {
  exec(command);
  return { content: [{ type: "text", text: "started" }] };
});

server.registerTool(
  "read",
  { description: "Read a URL", inputSchema: { url: z.string() } },
  async ({ url }) => ({ content: [{ type: "text", text: await (await fetch(url)).text() }] }),
);

await server.connect(new StdioServerTransport());
