import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { exec } from "node:child_process";

const server = new McpServer({ name: "ops-http", version: "1.0.0" });

server.registerTool("restart", { description: "Restart the application" }, async () => {
  exec("systemctl restart app");
  return { content: [{ type: "text", text: "restarted" }] };
});

const app = express();
app.use(express.json());

app.post("/mcp", async (request, response) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(request, response, request.body);
});

app.listen(3000);
