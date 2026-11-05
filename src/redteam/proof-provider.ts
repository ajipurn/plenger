/**
 * The model connection of one proof session: a provider bounded the way an exploring
 * review is, behind a `ModelBudget` that enforces the session's calls, tokens and time.
 */
import { ModelBudget } from "./budget.ts";
import { PROOF_SESSION_LIMITS } from "./constants.ts";
import {
  createRunProvider,
  type ModelReply,
  type ModelRequest,
  type ProviderAccess,
} from "./provider.ts";

export interface ProofConnection {
  send: (request: ModelRequest) => Promise<ModelReply>;
  tokens: { used: () => number; limit: number };
  budget: ModelBudget;
}

/** The most a session may charge, for a cost shown before it starts. */
export function proofTokenBound(limit: number = PROOF_SESSION_LIMITS.tokens): number {
  return Math.min(limit, PROOF_SESSION_LIMITS.tokens);
}

export function proofConnection(
  access: ProviderAccess,
  options: { tokens?: number; signal?: AbortSignal; dispatch?: typeof fetch } = {},
): ProofConnection {
  const limits = PROOF_SESSION_LIMITS;
  const provider = createRunProvider(
    {
      ...access,
      requestBounds: {
        bytes: limits.requestBytes,
        // Byte-level tokenizers use at least one byte per token.
        inputTokensPerByte: 1,
        // A turn that asks for more tools than it may run is answered, not rejected.
        toolCalls: 64,
      },
      outputTokenBudget: limits.outputTokens,
      maxOutputTokens: access.maxOutputTokens === null ? null : limits.outputTokens,
    },
    options.dispatch,
  );
  const budget = new ModelBudget(
    {
      maxModelCalls: limits.modelCalls,
      maxTokens: proofTokenBound(options.tokens),
      timeoutMs: limits.timeMs,
    },
    options.signal ? { signal: options.signal } : {},
  );
  return {
    budget,
    tokens: {
      used: () => budget.snapshot().accountedTokens,
      limit: proofTokenBound(options.tokens),
    },
    send: (request) =>
      budget.execute(provider.reservation(request, "setup"), (allowance) =>
        provider.generate(request, allowance),
      ),
  };
}
