import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { calculate, deleteNote, shell, writeNote } from "../../../tools";

export async function POST(req: Request) {
  const { prompt } = await req.json();
  const { text } = await generateText({
    model: openai("gpt-4.1"),
    system: "You are an operations assistant.",
    prompt,
    tools: { shell, writeNote, deleteNote },
    stopWhen: stepCountIs(5),
  });
  return Response.json({ text });
}

export async function PUT(req: Request) {
  const body = await req.json();
  const { text } = await generateText({
    model: openai("gpt-4.1"),
    system: `You help ${body.team} with maths.`,
    prompt: body.question,
    tools: { calculate },
  });
  return Response.json({ text });
}
