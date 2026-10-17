import { isRecord } from "../shared/guards.ts";
import { redact } from "../shared/secrets.ts";
import { ANTHROPIC, MAX_OUTPUT_TOKENS, MODEL_TOOL_CALL_LIMIT } from "./constants.ts";
import { type ClaudeTokenUsage, parseClaudeTokenUsage } from "./model-pricing.ts";
import {
  ModelProviderHttpError,
  type ModelReply,
  type ModelRequest,
  normalizeTools,
  type ProviderAccess,
  type RunProvider,
  readModelJson,
  record,
  requestBounds,
} from "./provider.ts";
import { PROVIDER_URLS, providerBaseUrl } from "./provider-config.ts";
import { anthropicModelOutputLimit } from "./provider-models.ts";

/** Valid reported usage remains billable even when the generated response is unusable. */
export class AnthropicResponseError extends Error {
  readonly tokenDetails: ClaudeTokenUsage;
  constructor(message: string, tokenDetails: ClaudeTokenUsage) {
    super(message);
    this.tokenDetails = tokenDetails;
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
      ...(request.outputSchema
        ? {
            output_config: {
              format: { type: "json_schema", schema: structuredSchema(request.outputSchema) },
            },
          }
        : {}),
      ...(access.temperature == null ? {} : { temperature: access.temperature }),
      stream: false,
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
    async generate(request, { signal, maxOutputTokens }) {
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
      const raw = record(await readModelJson(response));
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
        if (
          (raw.stop_reason !== "end_turn" && raw.stop_reason !== "tool_use") ||
          (raw.stop_reason === "tool_use") !== tools.length > 0 ||
          tools.length > MODEL_TOOL_CALL_LIMIT ||
          new Set(tools.map((tool) => tool.id)).size !== tools.length
        )
          throw new Error("Claude response did not complete; the step cannot be evaluated.");
        if (tools.length) history.set(historyKey(text, tools), raw.content);
        const value: ModelReply = {
          content,
          toolCalls: tools.map((tool) => ({ id: tool.id, name: tool.name, arguments: tool.input })),
        };
        return { value, usage, tokenDetails };
      } catch (error) {
        throw new AnthropicResponseError(
          error instanceof Error ? error.message : "Invalid Claude response.",
          tokenDetails,
        );
      }
    },
  };
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
