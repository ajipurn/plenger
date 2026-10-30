import { isRecord } from "../shared/guards.ts";
import { redact } from "../shared/secrets.ts";
import { ANTHROPIC, MAX_OUTPUT_TOKENS, MODEL_RESPONSE_CAP } from "./constants.ts";
import { type ClaudeTokenUsage, parseClaudeTokenUsage } from "./model-pricing.ts";
import {
  eventStream,
  ModelProviderHttpError,
  type ModelReply,
  type ModelRequest,
  normalizeTools,
  type ProviderAccess,
  type RunProvider,
  readModelJson,
  record,
  replyProgress,
  replyToolCalls,
  requestBounds,
  serverEvents,
} from "./provider.ts";
import { PROVIDER_URLS, providerBaseUrl } from "./provider-config.ts";
import { anthropicModelOutputLimit } from "./provider-models.ts";

/** Valid reported usage remains billable even when the generated response is unusable. */
export class AnthropicResponseError extends Error {
  readonly tokenDetails: ClaudeTokenUsage;
  /** The reply stopped at `max_tokens` (see `reachedOutputLimit`). */
  readonly outputLimit: boolean;
  constructor(message: string, tokenDetails: ClaudeTokenUsage, outputLimit = false) {
    super(message);
    this.tokenDetails = tokenDetails;
    this.outputLimit = outputLimit;
  }
}

/** Native Messages API. Credentials and signed thinking stay on the host. */
export function createAnthropicProvider(
  access: ProviderAccess,
  dispatch: typeof fetch,
): RunProvider {
  const outputLimit = Math.min(
    access.maxOutputTokens ?? (access.maxOutputTokens === null ? MAX_OUTPUT_TOKENS : 1024),
    access.outputTokenBudget ?? MAX_OUTPUT_TOKENS,
  );
  let modelOutputLimit: number | null | undefined;
  const url = `${providerBaseUrl(access.baseUrl ?? PROVIDER_URLS.anthropic)}/messages`;
  const history = new Map<string, unknown[]>();
  function body(request: ModelRequest, maxOutputTokens: number): string {
    const system: unknown[] = [];
    const messages: { role: "user" | "assistant"; content: unknown[] }[] = [];
    for (const value of request.messages) {
      const message = record(value);
      if (message.role === "system" || message.role === "developer") {
        if (messages.length)
          throw new Error("Claude system instructions must precede the conversation.");
        system.push(...textBlocks(message.content));
      } else if (message.role === "tool") {
        if (typeof message.tool_call_id !== "string" || !message.tool_call_id)
          throw new Error("Invalid Claude tool result.");
        const result = {
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: textBlocks(message.content),
        };
        const previous = messages.at(-1);
        if (previous?.role === "user") previous.content.push(result);
        else messages.push({ role: "user", content: [result] });
      } else if (message.role === "user" || message.role === "assistant") {
        const content = message.content == null ? [] : textBlocks(message.content);
        const calls = message.tool_calls ?? [];
        if (!Array.isArray(calls) || (calls.length && message.role !== "assistant"))
          throw new Error("Invalid Claude tool calls.");
        const tools = calls.map((value) => {
          const call = record(value);
          const fn = record(call.function);
          if (call.type !== "function" || typeof fn.arguments !== "string")
            throw new Error("Invalid Claude tool call.");
          let input: unknown;
          try {
            input = JSON.parse(fn.arguments);
          } catch {
            throw new Error("Invalid Claude tool arguments.");
          }
          return toolBlock({ type: "tool_use", id: call.id, name: fn.name, input });
        });
        const saved = tools.length ? history.get(historyKey(content, tools)) : undefined;
        messages.push({ role: message.role, content: saved ?? [...content, ...tools] });
      } else throw new Error("Unsupported Claude message role.");
    }
    const tools = normalizeTools(request.tools).map((value) => {
      const fn = record(record(value).function);
      if (!toolName(fn.name)) throw new Error("Invalid Claude tool name.");
      return {
        name: fn.name,
        ...(fn.description === undefined ? {} : { description: fn.description }),
        // A strict schema must stay in the structured-output subset; the host still
        // enforces the bounds it moves into descriptions.
        input_schema: fn.strict === true ? structuredSchema(record(fn.parameters)) : fn.parameters,
        ...(fn.strict === undefined ? {} : { strict: fn.strict }),
      };
    });
    const encoded = JSON.stringify({
      model: access.model,
      max_tokens: maxOutputTokens,
      messages,
      ...(system.length ? { system } : {}),
      ...(tools.length ? { tools } : {}),
      ...(request.cache ? { cache_control: { type: "ephemeral" } } : {}),
      ...(request.outputSchema
        ? {
            output_config: {
              format: { type: "json_schema", schema: structuredSchema(request.outputSchema) },
            },
          }
        : {}),
      ...(access.temperature == null ? {} : { temperature: access.temperature }),
      stream: true,
    });
    if (Buffer.byteLength(encoded) > requestBounds(access).bytes)
      throw new Error("Model request exceeds the runtime profile's size limit.");
    return encoded;
  }
  return {
    name: "anthropic",
    model: access.model,
    reservation(request, purpose) {
      return {
        purpose,
        inputTokensUpperBound:
          Buffer.byteLength(body(request, outputLimit)) * requestBounds(access).inputTokensPerByte +
          4096,
        maxOutputTokens: outputLimit,
        additionalTokensUpperBound: 0,
      };
    },
    async generate(request, { signal, maxOutputTokens, onProgress }) {
      if (access.maxOutputTokens === null && modelOutputLimit === undefined)
        modelOutputLimit = await anthropicModelOutputLimit(access, signal, dispatch);
      const encoded = body(request, Math.min(maxOutputTokens, modelOutputLimit ?? outputLimit));
      let response: Response;
      try {
        response = await dispatch(url, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "Content-Type": "application/json",
            "x-api-key": access.apiKey as string,
            "anthropic-version": ANTHROPIC.version,
          },
          body: encoded,
        });
      } catch {
        throw new Error("Claude connection failed or was interrupted.");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelProviderHttpError(response.status);
      }
      // A server that ignores `stream` answers with one JSON message, which reads the same.
      const raw = record(
        eventStream(response)
          ? await streamedMessage(response, replyProgress(onProgress))
          : await readModelJson(response),
      );
      if (raw.type !== "message" || raw.role !== "assistant" || !Array.isArray(raw.content))
        throw new Error("Invalid Claude response.");
      const tokenDetails = parseClaudeTokenUsage(raw.usage);
      const usage = {
        inputTokens:
          tokenDetails.inputTokens +
          tokenDetails.cacheReadTokens +
          tokenDetails.cacheCreationTokens,
        outputTokens: tokenDetails.outputTokens,
        additionalTokens: 0,
      };
      try {
        const text: { type: "text"; text: string }[] = [];
        const tools: ReturnType<typeof toolBlock>[] = [];
        for (const value of raw.content) {
          const block = record(value);
          if (block.type === "text" && typeof block.text === "string")
            text.push({ type: "text", text: block.text });
          else if (block.type === "tool_use") tools.push(toolBlock(block));
          else if (
            !(
              (block.type === "thinking" &&
                typeof block.thinking === "string" &&
                typeof block.signature === "string") ||
              (block.type === "redacted_thinking" && typeof block.data === "string")
            )
          )
            throw new Error("Unsupported Claude response content.");
        }
        const content = text.map((block) => block.text).join("") || null;
        if (raw.stop_reason === "refusal")
          return {
            value: {
              content: null,
              toolCalls: [],
              refusal: redact(
                content || "Claude declined this request.",
                access.apiKey ? [access.apiKey] : [],
              ).slice(0, ANTHROPIC.refusalTextLimit),
            },
            usage,
            tokenDetails,
          };
        // Each reason names only host-checked facts, never response text.
        if (raw.stop_reason !== "end_turn" && raw.stop_reason !== "tool_use")
          throw new AnthropicResponseError(
            `Claude response did not complete: stop reason ${stopReason(raw.stop_reason)}.`,
            tokenDetails,
            raw.stop_reason === "max_tokens",
          );
        if ((raw.stop_reason === "tool_use") !== tools.length > 0)
          throw new Error(
            "Claude response did not complete: its stop reason does not match its tool calls.",
          );
        const limit = replyToolCalls(access);
        if (tools.length > limit)
          throw new Error(
            `Claude response did not complete: ${tools.length} tool calls in one reply, more than the ${limit} accepted.`,
          );
        if (new Set(tools.map((tool) => tool.id)).size !== tools.length)
          throw new Error("Claude response did not complete: a tool call id repeats.");
        if (tools.length) history.set(historyKey(text, tools), raw.content);
        const value: ModelReply = {
          content,
          toolCalls: tools.map((tool) => ({ id: tool.id, name: tool.name, arguments: tool.input })),
        };
        return { value, usage, tokenDetails };
      } catch (error) {
        if (error instanceof AnthropicResponseError) throw error;
        throw new AnthropicResponseError(
          error instanceof Error ? error.message : "Invalid Claude response.",
          tokenDetails,
        );
      }
    },
  };
}

/**
 * A streamed Messages API reply, assembled into the shape of an unstreamed one so it is
 * checked the same way. Unknown events are skipped, as the API asks of clients.
 */
async function streamedMessage(
  response: Response,
  progress: ReturnType<typeof replyProgress>,
): Promise<Record<string, unknown>> {
  let message: Record<string, unknown> | null = null;
  let stopped = false;
  const blocks: Record<string, unknown>[] = [];
  const inputs = new Map<number, string>();
  const block = (index: unknown) => {
    const value = Number.isSafeInteger(index) ? blocks[index as number] : undefined;
    if (!value) throw new Error("Invalid Claude stream.");
    return value;
  };
  for await (const event of serverEvents(response, "Claude")) {
    if (event.type === "error")
      throw new Error(`Claude response failed: ${stopReason(record(event.error).type)}.`);
    if (event.type === "message_start") {
      message = { ...record(event.message) };
      const usage = record(message.usage ?? {});
      const input = [
        usage.input_tokens,
        usage.cache_read_input_tokens,
        usage.cache_creation_input_tokens,
      ]
        .filter((value): value is number => Number.isSafeInteger(value))
        .reduce((sum, value) => sum + value, 0);
      progress.update({ inputTokens: input });
    } else if (event.type === "content_block_start") {
      const index = event.index;
      if (!Number.isSafeInteger(index) || index !== blocks.length)
        throw new Error("Invalid Claude stream.");
      const value = { ...record(event.content_block) };
      blocks.push(value);
      if (value.type === "tool_use") {
        inputs.set(index as number, "");
        progress.tool(value.name);
      } else progress.update({ thinking: value.type === "thinking", tool: null });
    } else if (event.type === "content_block_delta") {
      const target = block(event.index);
      const delta = record(event.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        target.text = `${typeof target.text === "string" ? target.text : ""}${delta.text}`;
        progress.add(delta.text);
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        inputs.set(
          event.index as number,
          `${inputs.get(event.index as number) ?? ""}${delta.partial_json}`,
        );
        progress.add(delta.partial_json);
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        target.thinking = `${typeof target.thinking === "string" ? target.thinking : ""}${delta.thinking}`;
        progress.add(delta.thinking);
      } else if (delta.type === "signature_delta" && typeof delta.signature === "string")
        target.signature = `${typeof target.signature === "string" ? target.signature : ""}${delta.signature}`;
    } else if (event.type === "content_block_stop") {
      const target = block(event.index);
      const input = inputs.get(event.index as number);
      if (target.type === "tool_use" && input !== undefined) {
        try {
          target.input = input ? JSON.parse(input) : {};
        } catch {
          throw new Error("Invalid Claude tool arguments.");
        }
      }
    } else if (event.type === "message_delta") {
      if (!message) throw new Error("Invalid Claude stream.");
      const delta = record(event.delta);
      if (delta.stop_reason !== undefined) message.stop_reason = delta.stop_reason;
      // Usage in a delta is cumulative, so it replaces what message_start reported.
      if (event.usage !== undefined)
        message.usage = { ...record(message.usage ?? {}), ...record(event.usage) };
    } else if (event.type === "message_stop") stopped = true;
  }
  if (!message || !stopped) throw new Error("Claude stream ended before completion.");
  message.content = blocks;
  if (Buffer.byteLength(JSON.stringify(message)) > MODEL_RESPONSE_CAP)
    throw new Error("Model response exceeds the size limit.");
  return message;
}

/** A stop reason as Claude's enum spells it, or "unknown". */
function stopReason(value: unknown): string {
  return typeof value === "string" && /^[a-z_]{1,32}$/.test(value) ? value : "unknown";
}

/** Claude accepts a schema subset. Bounds stay enforced by the host parser. */
function structuredSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };
  const constraints: Record<string, unknown> = {};
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "maxItems"]) {
    if (Object.hasOwn(result, key)) {
      constraints[key] = result[key];
      delete result[key];
    }
  }
  if (typeof result.minItems === "number" && result.minItems > 1) {
    constraints.minItems = result.minItems;
    delete result.minItems;
  }
  if (Object.keys(constraints).length)
    result.description = `${typeof result.description === "string" ? `${result.description} ` : ""}Host-enforced constraints: ${JSON.stringify(constraints)}.`;
  if (isRecord(result.properties))
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([key, value]) => [
        key,
        structuredSchema(record(value)),
      ]),
    );
  if (isRecord(result.items)) result.items = structuredSchema(result.items);
  for (const key of ["anyOf", "allOf"])
    if (Array.isArray(result[key]))
      result[key] = result[key].map((value: unknown) => structuredSchema(record(value)));
  return result;
}

function textBlocks(value: unknown): { type: "text"; text: string }[] {
  if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
  if (Array.isArray(value))
    return value.map((value) => {
      const block = record(value);
      if (block.type !== "text" || typeof block.text !== "string")
        throw new Error("Claude currently supports text messages only.");
      return { type: "text", text: block.text };
    });
  throw new Error("Claude currently supports text messages only.");
}

function toolName(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,64}$/.test(value);
}

function toolBlock(block: Record<string, unknown>) {
  if (
    typeof block.id !== "string" ||
    !/^[\w-]{1,256}$/.test(block.id) ||
    !toolName(block.name) ||
    !isRecord(block.input)
  )
    throw new Error("Invalid Claude tool call.");
  return { type: "tool_use" as const, id: block.id, name: block.name, input: block.input };
}

function historyKey(text: { text: string }[], tools: ReturnType<typeof toolBlock>[]): string {
  return JSON.stringify({ text: text.map((block) => block.text).join(""), tools });
}
