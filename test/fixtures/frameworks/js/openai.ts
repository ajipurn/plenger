import OpenAI from "openai";
import { OpenAI as NamedOpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function answer(question: string, notes: string): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: `You are a support assistant. Notes: ${notes}` },
    { role: "user", content: question },
  ];
  const completion = await client.chat.completions.create({ model: "gpt-4.1", messages });
  return completion.choices[0]?.message.content ?? "";
}

export const respond = async (input: string) => {
  const named = new NamedOpenAI();
  return named.responses.create({ model: "gpt-4.1", input });
};
