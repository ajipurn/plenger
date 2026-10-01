import { openai } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";

export async function answer(question: string): Promise<string> {
  const { text } = await generateText({
    model: openai("gpt-4.1"),
    prompt: question,
    tools: {
      weather: tool({
        description: "Get the weather for a city",
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => fetch(`https://example.com/weather?city=${city}`).then((r) => r.text()),
      }),
    },
  });
  return text;
}
