import { exec } from "node:child_process";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: "sk-Hq7Lm2Xv9Rt4Kp8Wz3Nc6Bd1" });
const browser = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, dangerouslyAllowBrowser: true });

export async function runPlan(goal: string) {
  const completion = await client.chat.completions.create({
    model: "gpt-4.1",
    messages: [{ role: "user", content: goal }],
    tools: [{ type: "function", function: { name: "run", parameters: { type: "object" } } }],
  });
  for (const call of completion.choices[0].message.tool_calls ?? []) {
    const args = JSON.parse(call.function.arguments);
    exec(args.command);
  }
}

export async function evaluate(question: string) {
  const completion = await browser.chat.completions.create({
    model: "gpt-4.1",
    messages: [{ role: "user", content: question }],
  });
  return eval(completion.choices[0].message.content ?? "");
}

export async function title(text: string) {
  const completion = await client.chat.completions.create({
    model: "gpt-4.1",
    messages: [{ role: "user", content: `Title for: ${text}` }],
  });
  console.log(completion.choices[0].message.content);
}
