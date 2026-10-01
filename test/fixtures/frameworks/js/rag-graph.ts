import { InferenceClient } from "@huggingface/inference";
import { SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver, MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { ChatAnthropic } from "@langchain/anthropic";
import { OpenAIEmbeddings } from "@langchain/openai";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hono } from "hono";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { z } from "zod";

const store = await MemoryVectorStore.fromTexts(["plenger"], [{}], new OpenAIEmbeddings());
const retriever = store.asRetriever(4);

const lookup = tool(async ({ query }) => (await retriever.invoke(query)).map((doc) => doc.pageContent).join("\n"), {
  name: "lookup",
  description: "Look up documents",
  schema: z.object({ query: z.string() }),
});

const model = new ChatAnthropic({ model: "claude-sonnet-4-5", apiKey: "sk-ant-test" }).bindTools([lookup]);

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (state) => ({
    messages: [await model.invoke([new SystemMessage("You are a research assistant."), ...state.messages])],
  }))
  .addNode("tools", new ToolNode([lookup]))
  .compile({ checkpointer: new MemorySaver() });

const transport = new StdioClientTransport({ command: "uvx", args: ["mcp-server-fetch"] });
const client = new MultiServerMCPClient({ mcpServers: { math: { url: "http://localhost:3000/mcp" } } });

export const hf = new InferenceClient(process.env.HF_TOKEN);

const app = new Hono();
app.post("/ask", async (c) => c.json(await graph.invoke({ messages: [{ role: "user", content: (await c.req.json()).question }] })));

export default app;
