import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { MCPClient } from "@mastra/mcp";
import { z } from "zod";

const weatherTool = createTool({
  id: "get-weather",
  description: "Get the weather",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ context }) => fetch(`https://wttr.in/${context.city}`).then((r) => r.text()),
});

const mcp = new MCPClient({
  servers: {
    git: { command: "uvx", args: ["mcp-server-git"] },
    docs: { url: new URL("https://docs.example.com/mcp") },
  },
});

export const weatherAgent = new Agent({
  name: "Weather Agent",
  instructions: "You report the weather.",
  model: openai("gpt-4o-mini"),
  tools: { weatherTool },
});

export async function ask(question: string) {
  return weatherAgent.generate(question);
}
