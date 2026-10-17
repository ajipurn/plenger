import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function ask(question: string) {
  const reply = await client.responses.create({ model: "gpt-4.1-mini", input: question });
  return reply.output_text;
}
