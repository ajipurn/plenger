import { parse } from "smol-toml";
import { isRecord } from "../shared/guards.ts";
import { MODELS_DEV_PRICING } from "./constants.ts";
import { type ModelPricing, type TokenRates, validateModelPricing } from "./model-pricing.ts";
export type PricingProvider = "anthropic" | "openai";

/** Exact first-party IDs only. No alias guessing or caller-supplied hosts and paths. */
export function isPricingModel(
  model: unknown,
  provider: PricingProvider = "anthropic",
): model is string {
  return (
    typeof model === "string" &&
    (provider === "anthropic" ? /^claude-[a-z0-9-]{1,120}$/ : /^[a-z0-9][a-z0-9.-]{0,127}$/).test(
      model,
    )
  );
}

/** Public pricing data only. Never send provider credentials or project source. */
export async function fetchModelPricing(
  model: string,
  signal?: AbortSignal,
  dispatch: typeof fetch = fetch,
  provider: PricingProvider = "anthropic",
): Promise<ModelPricing> {
  if (!isPricingModel(model, provider))
    throw new Error("Choose a supported model for automatic pricing.");
  try {
    const response = await dispatch(
      `${MODELS_DEV_PRICING.baseUrl}${provider}/models/${model}.toml`,
      {
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(MODELS_DEV_PRICING.timeoutMs)])
          : AbortSignal.timeout(MODELS_DEV_PRICING.timeoutMs),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Pricing unavailable.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty pricing record.");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MODELS_DEV_PRICING.bytes) throw new Error("Pricing record too large.");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    return parseModelPricing(model, parse(Buffer.concat(chunks).toString("utf8")), provider);
  } catch {
    throw new Error(
      "Unable to load complete pricing from Models.dev. Refresh pricing to try again.",
    );
  }
}

/** Import only the text token rates the engine can represent without losing a price tier. */
export function parseModelPricing(
  model: string,
  raw: unknown,
  provider: PricingProvider = "anthropic",
): ModelPricing {
  const fail = () => new Error("Incomplete or unsupported Models.dev pricing.");
  if (!isPricingModel(model, provider) || !isRecord(raw) || raw.schema !== 2 || !isRecord(raw.cost))
    throw fail();
  const text = raw.cost.text;
  if (!isRecord(text) || !isRecord(text.input) || !isRecord(text.output)) throw fail();
  if (raw.cost.multipliers !== undefined) {
    if (!Array.isArray(raw.cost.multipliers)) throw fail();
    for (const multiplier of raw.cost.multipliers) {
      // Standard global list prices exclude region and optional service-tier premiums.
      // Other conditions may affect normal scan requests, so do not silently drop them.
      if (
        !isRecord(multiplier) ||
        !isRecord(multiplier.when) ||
        Object.keys(multiplier.when).some((key) => !["region", "service_tier"].includes(key))
      )
        throw fail();
    }
  }
  const input = text.input;
  const output = text.output;
  const rates = (input: Record<string, unknown>, output: Record<string, unknown>): TokenRates => {
    const cache = input.cache;
    if (provider === "openai") {
      if (cache !== undefined && !isRecord(cache)) throw fail();
      const read = isRecord(cache) ? cache.read : undefined;
      const write = isRecord(cache) ? cache.write : undefined;
      // Chat Completions uses the default lifetime. Older models have no write charge.
      if (write !== undefined && typeof write !== "number") throw fail();
      return {
        input: input.price,
        output: output.price,
        cacheRead: read ?? input.price,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        ...(write === undefined ? {} : { cacheWrite: write }),
      } as TokenRates;
    }
    if (!isRecord(cache) || !isRecord(cache.write)) throw fail();
    // Validation below rejects missing, negative and non-finite rates; missing is never free.
    return {
      input: input.price,
      output: output.price,
      cacheRead: cache.read,
      cacheWrite5m: cache.write["5m"],
      cacheWrite1h: cache.write["1h"],
    } as TokenRates;
  };
  const thresholds = new Set<number>();
  const override = (value: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (value.overrides === undefined) return;
    if (!Array.isArray(value.overrides) || value.overrides.length !== 1) throw fail();
    const tier = value.overrides[0];
    if (!isRecord(tier) || !isRecord(tier.when) || Object.keys(tier.when).length !== 1)
      throw fail();
    const context = tier.when.context;
    if (
      !isRecord(context) ||
      Object.keys(context).length !== 1 ||
      !Number.isSafeInteger(context.gt) ||
      (context.gt as number) < 1
    )
      throw fail();
    thresholds.add(context.gt as number);
    // A price override keeps unspecified base cache prices, as Models.dev specifies.
    const baseCache = isRecord(value.cache) ? value.cache : {};
    const tierCache = isRecord(tier.cache) ? tier.cache : {};
    return {
      ...value,
      ...tier,
      cache: {
        ...baseCache,
        ...tierCache,
        write:
          isRecord(baseCache.write) || isRecord(tierCache.write)
            ? {
                ...(isRecord(baseCache.write) ? baseCache.write : {}),
                ...(isRecord(tierCache.write) ? tierCache.write : {}),
              }
            : (tierCache.write ?? baseCache.write),
      },
    };
  };
  const longInput = override(input);
  const longOutput = override(output);
  if (thresholds.size > 1) throw fail();
  const threshold = [...thresholds][0];
  const [pricing] = validateModelPricing([
    {
      model,
      rates: rates(input, output),
      ...(threshold
        ? { longContext: { threshold, rates: rates(longInput ?? input, longOutput ?? output) } }
        : {}),
      source: { name: MODELS_DEV_PRICING.source, fetchedAt: new Date().toISOString() },
    },
  ]);
  if (!pricing) throw fail();
  return pricing;
}
