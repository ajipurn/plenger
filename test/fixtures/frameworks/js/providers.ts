import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GoogleGenAI } from "@google/genai";
import ollama from "ollama";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const bedrock = new BedrockRuntimeClient({ region: "us-east-1" });

export async function gemini(question: string) {
  return ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: question,
    config: { systemInstruction: "You are a travel agent." },
  });
}

export async function claude(question: string) {
  return bedrock.send(
    new ConverseCommand({
      modelId: "anthropic.claude-sonnet-4-5-v1:0",
      system: [{ text: "You are a support agent." }],
      messages: [{ role: "user", content: [{ text: question }] }],
    }),
  );
}

export async function local(question: string) {
  return ollama.chat({ model: "llama3.2", messages: [{ role: "user", content: question }] });
}
