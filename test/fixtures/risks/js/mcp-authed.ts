import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { exec } from "node:child_process";
import { z } from "zod";

export const auth = requireBearerAuth;
const server = new McpServer({ name: "ops-authed", version: "1.0.0" });

server.registerTool(
  "reload",
  { description: "Reload a service", inputSchema: { service: z.string() } },
  async ({ service }) => {
    exec(`systemctl reload ${service}`);
    return { content: [{ type: "text", text: "reloaded" }] };
  },
);

await server.connect(new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }));
