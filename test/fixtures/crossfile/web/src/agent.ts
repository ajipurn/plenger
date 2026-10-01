import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { SYSTEM } from "@/prompts";
import { lookup } from "./lookup";

export const agent = createReactAgent({ llm: new ChatOpenAI({ model: "gpt-4o" }), tools: [lookup], prompt: SYSTEM });
