import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

const now = tool({
  description: "Tell the current time",
  inputSchema: z.object({}),
  execute: async () => new Date().toISOString(),
});

export async function POST(req: Request) {
  const { prompt } = await req.json();
  const { text } = await generateText({
    model: openai("gpt-4.1"),
    system: "You are a scheduling assistant.",
    prompt,
    tools: { now },
    stopWhen: stepCountIs(5),
  });
  return Response.json({ text });
}
