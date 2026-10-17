import { execSync } from "node:child_process";
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

const restart = tool({
  description: "Restart the application",
  inputSchema: z.object({}),
  execute: async () => execSync("systemctl restart app").toString(),
});

export async function POST(req: Request) {
  const { prompt } = await req.json();
  const { text } = await generateText({
    model: openai("gpt-4.1"),
    system: "You are an operations assistant.",
    prompt,
    tools: { restart },
    stopWhen: stepCountIs(5),
  });
  return Response.json({ text });
}
