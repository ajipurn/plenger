import type { ModelPricingRequest, ModelPricingResult } from "../../../src/dashboard/contract.ts";
import { MODELS_DEV_PRICING } from "../../../src/redteam/constants.ts";

type LoadPricing = (
  input: ModelPricingRequest,
  signal?: AbortSignal,
) => Promise<ModelPricingResult>;

/** Cache belongs to the API client, so it survives closing and reopening provider settings. */
export function cacheModelPricing(load: LoadPricing): LoadPricing {
  const prices = new Map<
    string,
    { expiresAt: number; value?: ModelPricingResult; error?: unknown }
  >();
  return async (input, signal) => {
    signal?.throwIfAborted();
    const key = `${input.provider ?? "anthropic"}:${input.model}`;
    const cached = prices.get(key);
    if (!input.refresh && cached && cached.expiresAt > Date.now()) {
      if (cached.value) return structuredClone(cached.value);
      throw cached.error;
    }
    try {
      const value = await load(input, signal);
      signal?.throwIfAborted();
      const fetchedAt = value.pricing.source ? Date.parse(value.pricing.source.fetchedAt) : 0;
      const expiresAt =
        value.stale || !fetchedAt
          ? Date.now() + MODELS_DEV_PRICING.retryMs
          : Math.min(
              fetchedAt + MODELS_DEV_PRICING.cacheMs,
              Date.now() + MODELS_DEV_PRICING.cacheMs,
            );
      prices.set(key, { expiresAt, value: structuredClone(value) });
      return value;
    } catch (error) {
      // Closing the editor must not cache an abort. A failed explicit refresh keeps
      // any still-valid price; unavailable models wait briefly before an automatic retry.
      if (!signal?.aborted && !(cached?.value && cached.expiresAt > Date.now()))
        prices.set(key, { expiresAt: Date.now() + MODELS_DEV_PRICING.retryMs, error });
      throw error;
    }
  };
}
