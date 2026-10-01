import { Agent, MCPServerStdio, run, tool, webSearchTool } from "@openai/agents";
import { z } from "zod";

const refund = tool({
  name: "refund_order",
  description: "Refund an order",
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => `refunded ${orderId}`,
});

const billing = new Agent({ name: "Billing", instructions: "You handle refunds.", tools: [refund] });
const translator = new Agent({ name: "Translator", instructions: "Translate to Spanish." });
const files = new MCPServerStdio({ fullCommand: "npx -y @modelcontextprotocol/server-filesystem /srv" });

const triage = new Agent({
  name: "Triage",
  instructions: "Route the customer.",
  model: "gpt-4.1",
  tools: [webSearchTool(), translator.asTool({ toolName: "translate", toolDescription: "Translate text" })],
  handoffs: [billing],
  mcpServers: [files],
});

export async function answer(message: string) {
  const result = await run(triage, message);
  return result.finalOutput;
}
