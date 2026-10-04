import type { ModelReply, RunProvider } from "../../src/redteam/provider.ts";

type Generate = RunProvider["generate"];
type Reply = Awaited<ReturnType<Generate>>;

export interface StubProviderOptions {
  name?: string;
  model?: string;
  /** Reservation bounds the budget sees for every call (defaults: 10 in, 20 out). */
  inputTokensUpperBound?: number;
  maxOutputTokens?: number;
  /** A fixed reply for every call, or a function scripted per request. */
  generate?: Reply | Generate;
}

const DEFAULT_REPLY: Reply = { value: { content: "done", toolCalls: [] } };

/** A synthetic `RunProvider` that never touches the network. */
export function stubProvider(options: StubProviderOptions = {}): RunProvider {
  const scripted = options.generate;
  const generate: Generate =
    typeof scripted === "function"
      ? scripted
      : async () => structuredClone(scripted ?? DEFAULT_REPLY);
  return {
    name: options.name ?? "synthetic-test",
    model: options.model ?? "test",
    reservation: (_request, purpose) => ({
      purpose,
      inputTokensUpperBound: options.inputTokensUpperBound ?? 10,
      maxOutputTokens: options.maxOutputTokens ?? 20,
      additionalTokensUpperBound: 0,
    }),
    generate,
  };
}

/** A provider whose identity is recorded in evidence but which must never be called. */
export function offlineProvider(name: string, model: string): RunProvider {
  const refuse = (): never => {
    throw new Error("No model calls in this offline test.");
  };
  return { name, model, reservation: refuse, generate: async () => refuse() };
}

/** One tool call reply, as the OpenAI-compatible transport would parse it. */
export function toolCallReply(
  name: string,
  args: Record<string, unknown> = {},
  id = "call-1",
): ModelReply {
  return { content: null, toolCalls: [{ id, name, arguments: args }] };
}
