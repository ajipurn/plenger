import { CHATGPT, MAX_OUTPUT_TOKENS, MODEL_RESPONSE_CAP } from "./constants.ts";
import { parseOpenAIResponsesTokenUsage } from "./model-pricing.ts";
import {
  ModelProviderHttpError,
  type ModelRequest,
  ModelResponseError,
  normalizeTools,
  OutputLimitError,
  type ProviderAccess,
  parseModelReply,
  type RunProvider,
  record,
  replyProgress,
  replyToolCalls,
  requestBounds,
  serverEvents,
} from "./provider.ts";

/** SIWC uses the public Responses API. No Codex credentials or agent process are involved. */
export function createChatgptProvider(access: ProviderAccess, dispatch: typeof fetch): RunProvider {
  const accessToken = access.accessToken;
  if (!accessToken) throw new Error("Sign in with ChatGPT in Settings > Providers first.");
  // Requests send no output limit. Automatic settings (null) reserve the operation's whole
  // allowance, and the observed usage is checked against it after each response.
  const outputLimit = Math.min(
    access.maxOutputTokens ?? (access.maxOutputTokens === null ? MAX_OUTPUT_TOKENS : 1024),
    access.outputTokenBudget ?? MAX_OUTPUT_TOKENS,
  );
  const history = new Map<string, unknown[]>();
  function body(request: ModelRequest) {
    const input: unknown[] = [];
    for (const value of request.messages) {
      const message = record(value);
      if (message.role === "tool") {
        if (typeof message.tool_call_id !== "string" || typeof message.content !== "string")
          throw new Error("Unsupported ChatGPT tool result.");
        input.push({
          type: "function_call_output",
          call_id: message.tool_call_id,
          output: message.content,
        });
      } else if (["system", "developer", "user", "assistant"].includes(String(message.role))) {
        const calls = message.tool_calls;
        if (calls != null && (!Array.isArray(calls) || message.role !== "assistant"))
          throw new Error("Unsupported ChatGPT message.");
        const previous =
          Array.isArray(calls) && calls.length
            ? history.get(String(record(calls[0]).id))
            : undefined;
        if (previous) input.push(...previous);
        else {
          if (typeof message.content === "string")
            input.push({
              role: message.role === "system" ? "developer" : message.role,
              content: message.content,
            });
          else if (message.content != null)
            throw new Error("ChatGPT currently supports text messages only.");
          if (Array.isArray(calls))
            for (const value of calls) {
              const call = record(value),
                fn = record(call.function);
              if (
                call.type !== "function" ||
                typeof call.id !== "string" ||
                typeof fn.name !== "string" ||
                typeof fn.arguments !== "string"
              )
                throw new Error("Unsupported ChatGPT tool call.");
              input.push({
                type: "function_call",
                call_id: call.id,
                name: fn.name,
                namespace: "plenger",
                arguments: fn.arguments,
              });
            }
        }
      } else throw new Error("Unsupported ChatGPT message role.");
    }
    const functions = normalizeTools(request.tools).map((value) => {
      const fn = record(record(value).function);
      return {
        type: "function",
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : "",
        parameters: record(fn.parameters),
        strict: false,
      };
    });
    const encoded = JSON.stringify({
      model: access.model,
      input,
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      ...(functions.length
        ? {
            tools: [
              {
                type: "namespace",
                name: "plenger",
                description: "Application tools.",
                tools: functions,
              },
            ],
          }
        : {}),
    });
    if (Buffer.byteLength(encoded) > requestBounds(access).bytes)
      throw new Error("Model request exceeds the runtime profile's size limit.");
    return encoded;
  }
  return {
    name: "chatgpt",
    model: access.model,
    reservation(request, purpose) {
      return {
        purpose,
        tokenLimitMode: "observed",
        inputTokensUpperBound:
          Buffer.byteLength(body(request)) * requestBounds(access).inputTokensPerByte + 4096,
        maxOutputTokens: outputLimit,
        additionalTokensUpperBound: 0,
      };
    },
    async generate(request, { signal, onProgress }) {
      const encoded = body(request);
      const token = await accessToken(signal);
      let response: Response;
      try {
        response = await dispatch(`${CHATGPT.resource}/responses`, {
          method: "POST",
          redirect: "error",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: encoded,
        });
      } catch {
        throw new Error("ChatGPT connection failed or was interrupted.");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelProviderHttpError(response.status);
      }
      const raw = await completedResponse(response, replyProgress(onProgress));
      const tokenDetails =
        raw.usage === undefined ? undefined : parseOpenAIResponsesTokenUsage(raw.usage);
      try {
        if (!Array.isArray(raw.output) || raw.status !== "completed")
          throw new Error("ChatGPT response did not complete.");
        const texts: string[] = [],
          calls: Record<string, unknown>[] = [];
        for (const item of raw.output) {
          const output = record(item);
          if (output.type === "function_call") {
            if (output.namespace !== undefined && output.namespace !== "plenger")
              throw new Error("Unknown ChatGPT tool namespace.");
            calls.push({
              id: output.call_id,
              type: "function",
              function: { name: output.name, arguments: output.arguments },
            });
          } else if (output.type === "message") {
            if (!Array.isArray(output.content)) throw new Error("Invalid ChatGPT content.");
            for (const part of output.content) {
              const content = record(part);
              const text =
                content.type === "output_text"
                  ? content.text
                  : content.type === "refusal"
                    ? content.refusal
                    : undefined;
              if (typeof text !== "string") throw new Error("Unsupported ChatGPT content.");
              texts.push(text);
            }
          } else if (output.type !== "reasoning") throw new Error("Unsupported ChatGPT output.");
        }
        if (!texts.length && !calls.length)
          throw new Error("ChatGPT returned no assistant response.");
        const usage = record(raw.usage);
        const result = parseModelReply(
          {
            choices: [
              {
                finish_reason: calls.length ? "tool_calls" : "stop",
                message: { content: texts.length ? texts.join("") : null, tool_calls: calls },
              },
            ],
            usage: {
              prompt_tokens: usage.input_tokens,
              completion_tokens: usage.output_tokens,
              total_tokens: usage.total_tokens,
            },
          },
          replyToolCalls(access),
        );
        // Carry encrypted reasoning and exact tool-call items across the worker's next turn.
        // Cache only successful replies, and never persist provider context in reports.
        for (const call of result.value.toolCalls) history.set(call.id, raw.output);
        return { ...result, ...(tokenDetails ? { tokenDetails } : {}) };
      } catch (error) {
        if (tokenDetails && error instanceof Error)
          throw new ModelResponseError(error, tokenDetails);
        throw error;
      }
    },
  };
}

/** Output deltas of a Responses stream, counted for progress and otherwise unused. */
const DELTAS = new Set([
  "response.output_text.delta",
  "response.refusal.delta",
  "response.function_call_arguments.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
]);

async function completedResponse(
  response: Response,
  progress: ReturnType<typeof replyProgress>,
): Promise<Record<string, unknown>> {
  const completedItems = new Map<number, unknown>();
  let itemBytes = 0;
  for await (const event of serverEvents(response, "ChatGPT")) {
    if (DELTAS.has(String(event.type))) progress.add(event.delta);
    if (event.type === "response.output_item.added") {
      const item = record(event.item);
      if (item.type === "reasoning") progress.update({ thinking: true });
      else if (item.type === "function_call") progress.tool(item.name);
      else progress.update({ thinking: false, tool: null });
    }
    // A response cut at its output allowance is a recognizable output limit.
    if (
      event.type === "response.incomplete" &&
      record(record(event.response).incomplete_details).reason === "max_output_tokens"
    ) {
      const error = new OutputLimitError(
        "ChatGPT response did not complete: output limit reached.",
      );
      const usage = record(event.response).usage;
      const details = usage === undefined ? undefined : parseOpenAIResponsesTokenUsage(usage);
      throw details ? new ModelResponseError(error, details) : error;
    }
    if (["error", "response.failed", "response.incomplete"].includes(String(event.type)))
      throw new Error(
        "ChatGPT response failed. Check access and usage limits in ChatGPT settings.",
      );
    if (event.type === "response.output_item.done") {
      if (!Number.isSafeInteger(event.output_index) || (event.output_index as number) < 0)
        throw new Error("Invalid ChatGPT output index.");
      const index = event.output_index as number;
      if (completedItems.has(index)) throw new Error("Duplicate ChatGPT output item.");
      itemBytes += Buffer.byteLength(JSON.stringify(event.item) ?? "");
      if (itemBytes > MODEL_RESPONSE_CAP)
        throw new Error("ChatGPT response exceeds the size limit.");
      completedItems.set(index, event.item);
    }
    if (event.type === "response.completed") {
      const result = record(event.response);
      // Some direct streams deliver output only through output_item.done.
      if (Array.isArray(result.output) && result.output.length === 0 && completedItems.size)
        result.output = [...completedItems.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, item]) => item);
      if (Buffer.byteLength(JSON.stringify(result)) > MODEL_RESPONSE_CAP)
        throw new Error("ChatGPT response exceeds the size limit.");
      return result;
    }
  }
  throw new Error("ChatGPT stream ended before completion.");
}
