import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import * as fs from "node:fs/promises";
import { z } from "zod";

const writeNote = tool(
  async ({ path, text }) => {
    await fs.writeFile(path, text);
    return "saved";
  },
  { name: "write_note", description: "Write a note to disk", schema: z.object({ path: z.string(), text: z.string() }) },
);

const agent = createReactAgent({ llm: new ChatOpenAI({ model: "gpt-4o" }), tools: [writeNote] });

export async function ask(question: string) {
  return agent.invoke({ messages: [{ role: "user", content: question }] });
}
