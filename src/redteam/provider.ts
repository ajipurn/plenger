import { isRecord } from "../shared/guards.ts";
import { createAnthropicProvider } from "./anthropic-provider.ts";
import {
  BudgetStoppedError,
  ModelBudget,
  type ModelReservation,
  type TokenUsage,
} from "./budget.ts";
import { createChatgptProvider } from "./chatgpt-provider.ts";
import {
  MAX_OUTPUT_TOKENS,
  MODEL_REQUEST_CAP,
  MODEL_RESPONSE_CAP,
  MODEL_STREAM_CAP,
  MODEL_TOOL_CALL_LIMIT,
  type ProviderId,
} from "./constants.ts";
import { type BillableTokenUsage, parseOpenAITokenUsage } from "./model-pricing.ts";
import { PROVIDER_URLS, providerBaseUrl, validateProviderSettings } from "./provider-config.ts";

export interface ModelRequest {
  messages: unknown[];
  tools: unknown[] | null;
  /** Host-owned structured output schema. Currently used by native Claude reviews. */
  outputSchema?: Record<string, unknown>;
  /**
   * The id of a conversation whose next turn resends this one: Claude caches the prefix
   * up to the last block, and the OpenAI API routes the conversation's turns to one
   * prompt cache. Other transports cache prefixes on their own and ignore it.
   */
  cache?: string;
}
export interface ModelReply {
  content: string | null;
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  /** A provider refusal ends the step without executing tools or retrying. */
  refusal?: string;
}
/** How much of a reply has arrived while it streams. Counts and tool names, never reply text. */
export interface ReplyProgress {
  /** Characters of text, reasoning and tool arguments received so far. */
  characters: number;
  /** The model is reasoning and has not written yet. */
  thinking: boolean;
  /** The tool call the reply is composing. */
  tool: string | null;
  /** Input tokens, when the provider reports them before the reply ends. */
  inputTokens: number | null;
}
export interface RunProvider {
  name: string;
  model: string;
  reservation(request: ModelRequest, purpose: ModelReservation["purpose"]): ModelReservation;
  generate(
    request: ModelRequest,
    allowance: {
      signal: AbortSignal;
      maxOutputTokens: number;
      /** Called as a streaming reply arrives; transports that do not stream never call it. */
      onProgress?: (progress: ReplyProgress) => void;
    },
  ): Promise<{ value: ModelReply; usage?: TokenUsage; tokenDetails?: BillableTokenUsage }>;
}
export interface ProviderAccess {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  /** Host-owned operation allowance, independent of saved generation defaults. */
  outputTokenBudget?: number;
  /** Host-owned request bounds for an operation; omitted, the managed-trial bounds apply. */
  requestBounds?: RequestBounds;
  /** Host-only credential resolver. Never accepted from JSON or exported. */
  accessToken?: (signal: AbortSignal) => Promise<string>;
}

/**
 * The largest request an operation sends, and the input tokens assumed per request byte
 * when reserving budget. Managed trials assume four, a deliberately loose bound.
 */
export interface RequestBounds {
  bytes: number;
  inputTokensPerByte: number;
  /** Tool calls one reply may hold; omitted, `MODEL_TOOL_CALL_LIMIT`. */
  toolCalls?: number;
}
const TRIAL_BOUNDS: RequestBounds = { bytes: MODEL_REQUEST_CAP, inputTokensPerByte: 4 };

/** The bounds an access requests, or the managed-trial bounds. */
export function requestBounds(access: Pick<ProviderAccess, "requestBounds">): RequestBounds {
  return access.requestBounds ?? TRIAL_BOUNDS;
}

/** The tool calls one reply may hold under an access's bounds. */
export function replyToolCalls(access: Pick<ProviderAccess, "requestBounds">): number {
  return requestBounds(access).toolCalls ?? MODEL_TOOL_CALL_LIMIT;
}

/** Only the status is surfaced; provider error bodies may contain request data. */
export class ModelProviderHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Model provider returned HTTP ${status}. Check access and model availability.`);
    this.status = status;
  }
}

/**
 * A provider failed a request inside an accepted response, such as a stream's error event.
 * Only a short error code is surfaced; provider messages may echo request data.
 */
export class ModelProviderFailureError extends Error {
  readonly code: string | null;
  constructor(provider: string, code: unknown) {
    const known = typeof code === "string" && /^[\w.-]{1,64}$/.test(code) ? code : null;
    super(
      known && /usage_limit|quota|rate_limit/.test(known)
        ? `${provider} usage limit reached (${known}). Try again after it resets.`
        : `${provider} response failed${known ? ` (${known})` : ""}. Check access and usage limits in ${provider} settings.`,
    );
    this.code = known;
  }
}

/**
 * A request's connection failed, or its reply stream broke off before the reply completed.
 * Only the provider's label is surfaced; the transport's own error may hold request data.
 */
export class ModelProviderConnectionError extends Error {
  constructor(label: string, stage: "request" | "stream") {
    super(
      stage === "request"
        ? `${label} connection failed or was interrupted.`
        : `${label} stream ended before completion.`,
    );
  }
}

/**
 * Tool definitions as chat-completions function tools. Workers forward what the
 * framework hands its model class: the Vercel worker sends `{type: "function",
 * function: {...}}`, llmfy 0.11 sends the flat `{name, description, parameters,
 * strict}` shape. Both become the wrapped form the transports send.
 */
export function normalizeTools(tools: unknown[] | null): unknown[] {
  return (tools ?? []).map((value) => {
    const tool = record(value);
    const fn =
      tool.type === "function" && tool.function !== undefined ? record(tool.function) : tool;
    if (typeof fn.name !== "string" || !/^[\w-]{1,128}$/.test(fn.name))
      throw new Error("Invalid model tool definition.");
    return {
      type: "function",
      function: {
        name: fn.name,
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        parameters: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
        ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
      },
    };
  });
}

/** No SDK retries, redirects, credential discovery, or worker-selected destinations. */
export function createRunProvider(
  access: ProviderAccess,
  dispatch: typeof fetch = fetch,
): RunProvider {
  validateProviderSettings(access);
  if (access.provider === "chatgpt") return createChatgptProvider(access, dispatch);
  if (access.provider !== "ollama" && !access.apiKey)
    throw new Error("Enter your selected provider's API key for this run.");
  if (access.provider === "anthropic") return createAnthropicProvider(access, dispatch);
  const url = `${providerBaseUrl(access.baseUrl ?? PROVIDER_URLS[access.provider])}/chat/completions`;
  // Automatic output settings (null) use the operation's whole allowance as the ceiling.
  // The ceiling is always sent, so every reservation stays enforced by the provider.
  const outputLimit = Math.min(
    access.maxOutputTokens ?? (access.maxOutputTokens === null ? MAX_OUTPUT_TOKENS : 1024),
    access.outputTokenBudget ?? MAX_OUTPUT_TOKENS,
  );
  // Gemini's OpenAI-compatible transport requires its returned thought signatures
  // on later function-call turns. Retain these only within this provider instance.
  const metadata = new Map<string, unknown>();
  // Only OpenAI streams: compatible servers differ in whether they report usage in a stream.
  const streams = access.provider === "openai";
  const requestBody = (request: ModelRequest, maxOutputTokens: number) => ({
    model: access.model,
    messages: request.messages.map((value) => {
      const message = record(value);
      if (access.provider !== "gemini" || !Array.isArray(message.tool_calls)) return message;
      return {
        ...message,
        tool_calls: message.tool_calls.map((value) => {
          const call = record(value);
          return {
            ...call,
            ...(metadata.has(String(call.id))
              ? { extra_content: metadata.get(String(call.id)) }
              : {}),
          };
        }),
      };
    }),
    ...(request.tools?.length ? { tools: normalizeTools(request.tools) } : {}),
    stream: streams,
    ...(streams ? { stream_options: { include_usage: true } } : {}),
    ...(access.temperature == null ? {} : { temperature: access.temperature }),
    ...(access.provider === "openai"
      ? { max_completion_tokens: maxOutputTokens, store: false }
      : { max_tokens: maxOutputTokens }),
    ...(access.provider === "openai" && request.cache ? { prompt_cache_key: request.cache } : {}),
  });
  return {
    name: access.provider,
    model: access.model,
    reservation(request, purpose) {
      const bytes = Buffer.byteLength(JSON.stringify(requestBody(request, outputLimit)));
      const bounds = requestBounds(access);
      if (bytes > bounds.bytes)
        throw new Error("Model request exceeds the runtime profile's size limit.");
      // Conservative admission estimate, reconciled with provider usage. An overrun
      // stops the run; this is not a guaranteed billing cap for every model.
      return {
        purpose,
        inputTokensUpperBound: bytes * bounds.inputTokensPerByte + 4096,
        maxOutputTokens: outputLimit,
        additionalTokensUpperBound: 0,
      };
    },
    async generate(request, { signal, maxOutputTokens, onProgress }) {
      let response: Response;
      try {
        response = await dispatch(url, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "Content-Type": "application/json",
            ...(access.apiKey ? { Authorization: `Bearer ${access.apiKey}` } : {}),
          },
          body: JSON.stringify(requestBody(request, maxOutputTokens)),
        });
      } catch {
        throw new ModelProviderConnectionError("Model", "request");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelProviderHttpError(response.status);
      }
      const raw = eventStream(response)
        ? await streamedChatCompletion(response, replyProgress(onProgress), replyToolCalls(access))
        : await readModelJson(response);
      const details =
        access.provider === "openai" &&
        isRecord(raw) &&
        raw.usage !== undefined &&
        (raw.service_tier === undefined || raw.service_tier === "default")
          ? parseOpenAITokenUsage(raw.usage)
          : undefined;
      let parsed: ReturnType<typeof parseModelReply>;
      try {
        parsed = parseModelReply(raw, replyToolCalls(access));
      } catch (error) {
        if (details && error instanceof Error) throw new ModelResponseError(error, details);
        throw error;
      }
      if (access.provider === "gemini") {
        const value = record(raw);
        const calls = record(record((value.choices as unknown[])[0]).message).tool_calls;
        if (Array.isArray(calls))
          for (const value of calls) {
            const call = record(value);
            if (call.extra_content !== undefined) metadata.set(String(call.id), call.extra_content);
          }
      }
      return { ...parsed, ...(details ? { tokenDetails: details } : {}) };
    },
  };
}

const CONNECTION_TEST_TIMEOUT_MS = 20_000;

/** What a successful connection test reports. */
export interface ProviderConnection {
  model: string;
  durationMs: number;
}

/**
 * One bounded request proving the endpoint, model and key work together. Failures
 * are reported by category only; provider error bodies may echo the request.
 */
export async function testProviderConnection(
  access: ProviderAccess,
  dispatch: typeof fetch = fetch,
): Promise<ProviderConnection> {
  const budget = new ModelBudget({
    maxModelCalls: 1,
    maxTokens: 100_000,
    timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
  });
  const started = performance.now();
  try {
    const provider = createRunProvider(access, dispatch);
    const request: ModelRequest = {
      messages: [{ role: "user", content: "Reply with OK." }],
      tools: null,
    };
    const reply = await budget.execute(provider.reservation(request, "setup"), (allowance) =>
      provider.generate(request, allowance),
    );
    if (reply.refusal) throw new Error("The provider declined the connection test.");
    return { model: provider.model, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    throw new Error(
      access.provider === "chatgpt"
        ? "ChatGPT connection test failed. Sign in with ChatGPT in Settings > Providers, then check the model and ChatGPT usage limits."
        : connectionTestFailure(error),
      { cause: error },
    );
  } finally {
    budget.finish();
  }
}

function connectionTestFailure(error: unknown): string {
  if (error instanceof ModelProviderHttpError)
    return `Connection test failed: provider returned HTTP ${error.status}. Check model availability and access.`;
  if (error instanceof BudgetStoppedError && error.reason === "deadline")
    return `Connection test timed out after ${CONNECTION_TEST_TIMEOUT_MS / 1000} seconds. Check that the model is available and responding.`;
  return "Connection test failed. Check the endpoint, model and API key.";
}

/** A reply stopped at its output token allowance; whatever it held is incomplete. */
export class OutputLimitError extends Error {
  readonly outputLimit = true;
}

/** Unusable OpenAI replies still retain the provider's billable token breakdown. */
export class ModelResponseError extends Error {
  readonly tokenDetails: BillableTokenUsage;
  readonly outputLimit: boolean;
  constructor(error: Error, tokenDetails: BillableTokenUsage) {
    super(error.message, { cause: error });
    this.tokenDetails = tokenDetails;
    this.outputLimit = reachedOutputLimit(error);
  }
}

/** Whether a provider error is a reply cut at its output allowance, on any transport. */
export function reachedOutputLimit(error: unknown): boolean {
  return (
    error instanceof Error && (error as Error & { outputLimit?: boolean }).outputLimit === true
  );
}

export function parseModelReply(
  raw: unknown,
  toolCallLimit = MODEL_TOOL_CALL_LIMIT,
): { value: ModelReply; usage?: TokenUsage } {
  const value = record(raw);
  const choice = record(Array.isArray(value.choices) ? value.choices[0] : null);
  if (choice.finish_reason === "length")
    throw new OutputLimitError("Model response did not complete; the trial cannot be evaluated.");
  if (choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls")
    throw new Error("Model response did not complete; the trial cannot be evaluated.");
  const message = record(choice.message);
  if (message.content !== null && typeof message.content !== "string")
    throw new Error("Invalid model content.");
  const calls = message.tool_calls ?? [];
  if (!Array.isArray(calls)) throw new Error("Invalid model tool calls.");
  if (calls.length > toolCallLimit)
    throw new Error(
      `Invalid model tool calls: ${calls.length} in one reply, more than the ${toolCallLimit} accepted.`,
    );
  const toolCalls = calls.map((item: unknown) => {
    const call = record(item);
    const fn = record(call.function);
    if (
      typeof call.id !== "string" ||
      call.id.length > 256 ||
      call.type !== "function" ||
      typeof fn.name !== "string" ||
      !/^[\w-]{1,128}$/.test(fn.name) ||
      typeof fn.arguments !== "string"
    )
      throw new Error("Invalid model tool call.");
    let args: unknown;
    try {
      args = JSON.parse(fn.arguments);
    } catch {
      throw new Error("Invalid model tool arguments.");
    }
    return { id: call.id, name: fn.name, arguments: record(args) };
  });
  const result: { value: ModelReply; usage?: TokenUsage } = {
    value: { content: message.content as string | null, toolCalls },
  };
  if (typeof message.refusal === "string" && message.refusal)
    result.value.refusal = message.refusal;
  if (value.usage !== undefined) {
    const usage = record(value.usage);
    if (
      ![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(
        (n) => Number.isSafeInteger(n) && (n as number) >= 0,
      ) ||
      usage.total_tokens !== (usage.prompt_tokens as number) + (usage.completion_tokens as number)
    )
      throw new Error("Invalid model usage.");
    // completion_tokens includes reasoning/formatting tokens; don't double count.
    result.usage = {
      inputTokens: usage.prompt_tokens as number,
      outputTokens: usage.completion_tokens as number,
      additionalTokens: 0,
    };
  }
  return result;
}

/** A worker or provider frame must be a JSON object. */
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid runtime message.");
  return value;
}

/** Reports what a streaming reply has received; counts only, so no reply text leaves it. */
export function replyProgress(onProgress?: (progress: ReplyProgress) => void) {
  const state: ReplyProgress = { characters: 0, thinking: false, tool: null, inputTokens: null };
  const update = (change: Partial<ReplyProgress>) => {
    Object.assign(state, change);
    onProgress?.({ ...state });
  };
  return {
    update,
    /** Count received text. */
    add(text: unknown) {
      if (typeof text === "string" && text) update({ characters: state.characters + text.length });
    },
    /** Name the tool call being composed, when it is a valid tool name. */
    tool(name: unknown) {
      update({
        thinking: false,
        tool: typeof name === "string" && TOOL_NAME.test(name) ? name : null,
      });
    },
  };
}
const TOOL_NAME = /^[\w-]{1,128}$/;

/** Whether a provider answered with server-sent events rather than one JSON body. */
export function eventStream(response: Response): boolean {
  return response.headers.get("content-type")?.includes("text/event-stream") ?? false;
}

/**
 * The JSON data of each server-sent event of a bounded stream, in order. Comments and
 * `[DONE]` are skipped. `label` names the provider in errors.
 */
export async function* serverEvents(
  response: Response,
  label: string,
  byteCap = MODEL_STREAM_CAP,
): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} returned an empty stream.`);
  const decoder = new TextDecoder();
  let pending = "",
    bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read().catch(() => {
        throw new ModelProviderConnectionError(label, "stream");
      });
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > byteCap) throw new Error(`${label} stream exceeds the size limit.`);
      pending += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(pending);
        if (!boundary) break;
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        let event: Record<string, unknown>;
        try {
          event = record(JSON.parse(data));
        } catch {
          throw new Error(`Invalid ${label} stream.`);
        }
        yield event;
      }
    }
  } finally {
    // Cancelling a broken stream rejects with its transport error, which would replace ours.
    await reader.cancel().catch(() => {});
  }
}

/** A streamed chat completion, assembled into the shape of an unstreamed one. */
async function streamedChatCompletion(
  response: Response,
  progress: ReturnType<typeof replyProgress>,
  toolCallLimit: number,
): Promise<Record<string, unknown>> {
  let content: string | null = null,
    refusal: string | null = null,
    finishReason: unknown = null,
    usage: unknown,
    serviceTier: unknown;
  const calls: { id?: unknown; type: "function"; function: { name: string; arguments: string } }[] =
    [];
  for await (const chunk of serverEvents(response, "Model provider")) {
    if (chunk.usage != null) usage = chunk.usage;
    if (chunk.service_tier !== undefined) serviceTier = chunk.service_tier;
    if (!Array.isArray(chunk.choices)) throw new Error("Invalid model stream.");
    for (const value of chunk.choices) {
      const choice = record(value);
      const delta = choice.delta === undefined ? {} : record(choice.delta);
      if (typeof delta.content === "string") {
        content = (content ?? "") + delta.content;
        progress.add(delta.content);
      }
      if (typeof delta.refusal === "string") {
        refusal = (refusal ?? "") + delta.refusal;
        progress.add(delta.refusal);
      }
      for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const call = record(part);
        // One past the limit still parses, so the reply fails with the usual message.
        if (
          !Number.isSafeInteger(call.index) ||
          (call.index as number) < 0 ||
          (call.index as number) > toolCallLimit
        )
          throw new Error("Invalid model tool calls.");
        const fn = call.function === undefined ? {} : record(call.function);
        const index = call.index as number;
        calls[index] ??= { type: "function", function: { name: "", arguments: "" } };
        const current = calls[index];
        if (call.id !== undefined) current.id = call.id;
        if (typeof fn.name === "string") {
          current.function.name += fn.name;
          progress.tool(current.function.name);
        }
        if (typeof fn.arguments === "string") {
          current.function.arguments += fn.arguments;
          progress.add(fn.arguments);
        }
      }
      if (choice.finish_reason != null) finishReason = choice.finish_reason;
    }
  }
  // Spreading turns skipped indexes into undefined entries.
  if ([...calls].some((call) => call === undefined)) throw new Error("Invalid model tool calls.");
  const raw = {
    choices: [
      {
        finish_reason: finishReason,
        message: {
          content,
          ...(refusal ? { refusal } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
        },
      },
    ],
    ...(usage === undefined ? {} : { usage }),
    ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
  };
  if (Buffer.byteLength(JSON.stringify(raw)) > MODEL_RESPONSE_CAP)
    throw new Error("Model response exceeds the size limit.");
  return raw;
}

/** Bounded JSON for native and compatible model transports. */
export async function readModelJson(
  response: Response,
  byteCap = MODEL_RESPONSE_CAP,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Model provider returned an empty response.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > byteCap) throw new Error("Model response exceeds the size limit.");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Model provider returned invalid JSON.");
  }
}
