import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin, terminal: false });
const lines = input[Symbol.asyncIterator]();
export function close() {
  input.close();
  process.stdin.destroy();
}
const write = process.stdout.write.bind(process.stdout);
export const send = (value) => write(`${JSON.stringify(value)}\n`);
export async function receive() {
  const { value, done } = await lines.next();
  if (done || value.length > 6 * 1024 * 1024) throw new Error("protocol");
  return JSON.parse(value);
}
export const state = {
  tools: new Map(),
  databases: [],
  phase: "setup",
  next: 1,
  last: 0,
  toolNames: new Map(),
  activeCalls: new Set(),
};
export const event = (value) => send({ type: "event", ...value });
export async function modelReply(options) {
  if (state.override) return state.override(options);
  const messages = [];
  for (const message of options.prompt) {
    if (message.role === "system") {
      messages.push({ role: "system", content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) throw new Error("unsupported prompt");
    const text = message.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    const calls = message.content.filter((p) => p.type === "tool-call");
    const results = message.content.filter((p) => p.type === "tool-result");
    if (
      message.content.some(
        (p) => !["text", "tool-call", "tool-result", "reasoning"].includes(p.type),
      )
    )
      throw new Error("multimodal unsupported");
    if (results.length) {
      for (const p of results)
        messages.push({
          role: "tool",
          tool_call_id: p.toolCallId,
          content: JSON.stringify(p.output),
        });
    } else
      messages.push({
        role: message.role,
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((p) => ({
                id: p.toolCallId,
                type: "function",
                function: { name: p.toolName, arguments: JSON.stringify(p.input) },
              })),
            }
          : {}),
      });
  }
  const tools =
    options.tools?.map((t) => {
      if (t.type !== "function") throw new Error("provider tools unsupported");
      return {
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      };
    }) ?? null;
  const id = state.next++;
  state.last = id;
  send({ type: "model_request", id, messages, tools });
  const response = await receive();
  if (response.type !== "model_response" || response.id !== id) throw new Error("protocol");
  return response.value;
}
const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
export function model(modelId) {
  return {
    specificationVersion: "v4",
    provider: "plenger-managed",
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const reply = await modelReply(options);
      return {
        content: content(reply),
        finishReason: { unified: reply.toolCalls.length ? "tool-calls" : "stop", raw: "managed" },
        usage,
        warnings: [],
      };
    },
    async doStream(options) {
      const reply = await modelReply(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (reply.content) {
              controller.enqueue({ type: "text-start", id: "text" });
              controller.enqueue({ type: "text-delta", id: "text", delta: reply.content });
              controller.enqueue({ type: "text-end", id: "text" });
            }
            for (const call of reply.toolCalls)
              controller.enqueue({
                type: "tool-call",
                toolCallId: call.id,
                toolName: call.name,
                input: JSON.stringify(call.arguments),
              });
            controller.enqueue({
              type: "finish",
              finishReason: {
                unified: reply.toolCalls.length ? "tool-calls" : "stop",
                raw: "managed",
              },
              usage,
            });
            controller.close();
          },
        }),
      };
    },
  };
}
function content(reply) {
  return [
    ...(reply.content ? [{ type: "text", text: reply.content }] : []),
    ...reply.toolCalls.map((call) => ({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.name,
      input: JSON.stringify(call.arguments),
    })),
  ];
}
