import type { ModelReservation, TokenUsage } from "./budget.ts";

export interface ModelRequest {
  messages: unknown[];
  tools: unknown[] | null;
}
export interface ModelReply {
  content: string | null;
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
}
export interface RunProvider {
  name: string;
  model: string;
  reservation(request: ModelRequest, purpose: ModelReservation["purpose"]): ModelReservation;
  generate(
    request: ModelRequest,
    allowance: { signal: AbortSignal; maxOutputTokens: number },
  ): Promise<{ value: ModelReply; usage?: TokenUsage }>;
}
export interface ProviderAccess {
  provider: "openai" | "ollama" | "gemini";
  model: string;
  apiKey?: string;
}

/** No SDK retries, redirects, credential discovery, or worker-selected destinations. */
export function createRunProvider(
  access: ProviderAccess,
  dispatch: typeof fetch = fetch,
): RunProvider {
  if (
    !["openai", "ollama", "gemini"].includes(access.provider) ||
    !/^[\w./:-]{1,128}$/.test(access.model) ||
    access.model.includes("://")
  )
    throw new Error("Choose a supported provider and enter a model ID.");
  if (
    access.provider !== "ollama" &&
    (!access.apiKey || /[\r\n]/.test(access.apiKey) || access.apiKey.length > 4096)
  )
    throw new Error("Enter your selected provider's API key for this run.");
  const url =
    access.provider === "openai"
      ? "https://api.openai.com/v1/chat/completions"
      : access.provider === "gemini"
        ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        : "http://127.0.0.1:11434/v1/chat/completions";
  // Gemini's OpenAI-compatible transport requires its returned thought signatures
  // on later function-call turns. Retain these only within this provider instance.
  const metadata = new Map<string, unknown>();
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
    ...(request.tools?.length ? { tools: request.tools } : {}),
    stream: false,
    ...(access.provider === "openai"
      ? { max_completion_tokens: maxOutputTokens, store: false }
      : { max_tokens: maxOutputTokens }),
  });
  return {
    name: access.provider,
    model: access.model,
    reservation(request, purpose) {
      const bytes = Buffer.byteLength(JSON.stringify(requestBody(request, 1024)));
      if (bytes > 48 * 1024)
        throw new Error("Model request exceeds the runtime profile's size limit.");
      // Conservative admission estimate, reconciled with provider usage. An overrun
      // stops the run; this is not a guaranteed billing cap for every model.
      return {
        purpose,
        inputTokensUpperBound: bytes * 4 + 4096,
        maxOutputTokens: 1024,
        additionalTokensUpperBound: 0,
      };
    },
    async generate(request, { signal, maxOutputTokens }) {
      let response: Response;
      try {
        response = await dispatch(url, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "Content-Type": "application/json",
            ...(access.provider !== "ollama" ? { Authorization: `Bearer ${access.apiKey}` } : {}),
          },
          body: JSON.stringify(requestBody(request, maxOutputTokens)),
        });
      } catch {
        throw new Error("Model connection failed or was interrupted.");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `Model provider returned HTTP ${response.status}. Check access and model availability.`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Model provider returned an empty response.");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 64 * 1024) throw new Error("Model response exceeds the size limit.");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new Error("Model provider returned invalid JSON.");
      }
      const parsed = parseModelReply(raw);
      if (access.provider === "gemini") {
        const value = record(raw);
        const calls = record(record((value.choices as unknown[])[0]).message).tool_calls;
        if (Array.isArray(calls))
          for (const value of calls) {
            const call = record(value);
            if (call.extra_content !== undefined) metadata.set(String(call.id), call.extra_content);
          }
      }
      return parsed;
    },
  };
}

export function parseModelReply(raw: unknown): { value: ModelReply; usage?: TokenUsage } {
  const value = record(raw);
  const choice = record(Array.isArray(value.choices) ? value.choices[0] : null);
  if (choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls")
    throw new Error("Model response did not complete; the trial cannot be evaluated.");
  const message = record(choice.message);
  if (message.content !== null && typeof message.content !== "string")
    throw new Error("Invalid model content.");
  const calls = message.tool_calls ?? [];
  if (!Array.isArray(calls) || calls.length > 8) throw new Error("Invalid model tool calls.");
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

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid runtime message.");
  return value as Record<string, unknown>;
}
