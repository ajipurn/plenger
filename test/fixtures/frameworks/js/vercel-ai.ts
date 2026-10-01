import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

const weather = tool({
  description: "Get the weather for a city",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => {
    const response = await fetch(`https://api.example.com/weather?city=${city}`);
    return response.text();
  },
});

export async function answer(question: string) {
  const { text, toolCalls } = await generateText({
    model: openai("gpt-4.1"),
    system: "You are a weather assistant.",
    prompt: question,
    tools: { weather },
    stopWhen: stepCountIs(5),
  });
  return { text, toolCalls };
}
