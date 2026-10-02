import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { exec } from "node:child_process";
import { z } from "zod";

const server = new McpServer({ name: "ops-http", version: "1.0.0" });

server.registerTool(
  "restart",
  { description: "Restart a service", inputSchema: { service: z.string() } },
  async ({ service }) => {
    exec(`systemctl restart ${service}`);
    return { content: [{ type: "text", text: "restarted" }] };
  },
);

await server.connect(new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }));
