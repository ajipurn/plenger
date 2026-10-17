import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { exec } from "node:child_process";

const server = new McpServer({ name: "ops-http", version: "1.0.0" });

server.registerTool("restart", { description: "Restart the application" }, async () => {
  exec("systemctl restart app");
  return { content: [{ type: "text", text: "restarted" }] };
});

await server.connect(new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }));
