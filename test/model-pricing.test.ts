import { describe, expect, it } from "vitest";
import { MODEL_PRICING_LIMITS } from "../src/redteam/constants.ts";
import {
  type ModelPricing,
  parseClaudeTokenUsage,
  reviewBilling,
  sumCosts,
  tokenCost,
  validateModelPricing,
  worstCaseCost,
} from "../src/redteam/model-pricing.ts";

const pricing: ModelPricing = {
  model: "synthetic-priced-model",
  rates: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
};
const usage = {
  input_tokens: 2000,
  output_tokens: 500,
  cache_creation_input_tokens: 248,
  cache_read_input_tokens: 1800,
  cache_creation: { ephemeral_5m_input_tokens: 148, ephemeral_1h_input_tokens: 100 },
};

describe("model token pricing", () => {
  it("charges disjoint input, output, cache writes and cache hits exactly once", () => {
    const details = parseClaudeTokenUsage(usage);
    expect(details).toMatchObject({
      inputTokens: 2000,
      outputTokens: 500,
      cacheCreationTokens: 248,
      cacheReadTokens: 1800,
      cacheWrite5mTokens: 148,
      cacheWrite1hTokens: 100,
    });
    const charge = tokenCost(pricing, details);
    expect(charge?.amounts).toEqual({
      input: 0.006,
      output: 0.0075,
      cacheWrite5m: 0.000555,
      cacheWrite1h: 0.0006,
      cacheRead: 0.00054,
    });
    expect(charge?.totalUsd).toBeCloseTo(0.015195, 12);
  });

  it("chooses long-context rates per request, including cached input and only above the threshold", () => {
    const tiered = {
      ...pricing,
      longContext: {
        threshold: 100_000,
        rates: { input: 6, output: 30, cacheWrite5m: 7.5, cacheWrite1h: 12, cacheRead: 0.6 },
      },
    };
    const exact = parseClaudeTokenUsage({
      input_tokens: 1,
      output_tokens: 20,
      cache_read_input_tokens: 99_999,
    });
    const over = { ...exact, inputTokens: 2 };
    expect(tokenCost(tiered, exact)?.longContext).toBe(false);
    expect(tokenCost(tiered, over)).toMatchObject({
      longContext: true,
      amounts: { output: 0.0006 },
    });
    const twice = reviewBilling(tiered, [exact, exact], 2);
    expect(twice.cost?.totalUsd).toBeCloseTo((tokenCost(tiered, exact)?.totalUsd ?? 0) * 2, 12);
    expect(twice.cost?.complete).toBe(true);
  });

  it("bounds a request's cost by its dearest prompt rate and whole output allowance", () => {
    // 1,000 prompt tokens at the 1-hour cache write rate, 100 output tokens.
    expect(worstCaseCost(pricing, 1000, 100)).toBeCloseTo((1000 * 6 + 100 * 15) / 1e6, 12);
    const tiered: ModelPricing = {
      ...pricing,
      longContext: {
        threshold: 200_000,
        rates: { input: 6, output: 22.5, cacheWrite5m: 7.5, cacheWrite1h: 12, cacheRead: 0.6 },
      },
    };
    expect(worstCaseCost(tiered, 200_000, 0)).toBeCloseTo((200_000 * 6) / 1e6, 12);
    expect(worstCaseCost(tiered, 200_001, 10)).toBeCloseTo((200_001 * 12 + 10 * 22.5) / 1e6, 12);
    // No reported usage can cost more than the bound.
    const details = parseClaudeTokenUsage(usage);
    const prompt = details.inputTokens + details.cacheReadTokens + details.cacheCreationTokens;
    expect(tokenCost(pricing, details)?.totalUsd).toBeLessThanOrEqual(
      worstCaseCost(pricing, prompt, details.outputTokens),
    );
  });

  it("does not guess cache write lifetimes or missing usage, while retaining a partial estimate", () => {
    const missingLifetime = parseClaudeTokenUsage({
      input_tokens: 10,
      output_tokens: 3,
      cache_creation_input_tokens: 20,
    });
    expect(missingLifetime.cacheWrite5mTokens).toBeNull();
    expect(tokenCost(pricing, missingLifetime)).toBeNull();
    expect(reviewBilling(pricing, [missingLifetime], 1).cost).toBeNull();
    expect(reviewBilling(pricing, [], 1).cost).toBeNull();
    const known = parseClaudeTokenUsage({ input_tokens: 1000, output_tokens: 100 });
    const partial = reviewBilling(pricing, [known, missingLifetime], 2).cost;
    expect(partial?.complete).toBe(false);
    expect(partial?.totalUsd).toBeCloseTo(0.0045, 12);
    expect(reviewBilling(null, [known], 1).cost).toBeNull();
    expect(reviewBilling(pricing, [], 0).cost).toMatchObject({ totalUsd: 0, complete: true });
    const total = sumCosts([reviewBilling(pricing, [known], 1).cost, null]);
    expect(total?.complete).toBe(false);
    expect(total?.totalUsd).toBeCloseTo(0.0045, 12);
    expect(sumCosts([null, undefined])).toBeNull();
  });

  it("accepts explicit zero rates and snapshots rates independently of later edits", () => {
    const free = {
      ...pricing,
      rates: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    };
    const snapshot = reviewBilling(free, [parseClaudeTokenUsage(usage)], 1);
    free.rates.output = 100;
    expect(snapshot.pricing?.rates.output).toBe(0);
    expect(snapshot.cost).toMatchObject({ totalUsd: 0, complete: true });
  });

  it.each([
    { input_tokens: -1, output_tokens: 0 },
    { input_tokens: 1.2, output_tokens: 0 },
    { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: "20" },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    {
      ...usage,
      cache_creation: { ephemeral_5m_input_tokens: 148, ephemeral_1h_input_tokens: 101 },
    },
    { ...usage, cache_creation: { ephemeral_5m_input_tokens: 148 } },
  ])("rejects invalid or inconsistent usage (%j)", (invalid) => {
    expect(() => parseClaudeTokenUsage(invalid)).toThrow("Invalid Claude token usage");
  });

  it("validates bounded prices and unique model IDs without accepting incomplete tables", () => {
    expect(validateModelPricing([pricing])).toEqual([pricing]);
    for (const value of [
      [{ ...pricing, rates: { ...pricing.rates, input: -1 } }],
      [{ ...pricing, rates: { input: 1, output: 1 } }],
      [{ ...pricing, rates: { ...pricing.rates, output: Number.NaN } }],
      [{ ...pricing, rates: { ...pricing.rates, input: MODEL_PRICING_LIMITS.perMillion + 1 } }],
      [{ ...pricing, longContext: { threshold: 0, rates: pricing.rates } }],
      [{ ...pricing, model: "https://invalid.example" }],
      [pricing, pricing],
      Array.from({ length: MODEL_PRICING_LIMITS.models + 1 }, (_, index) => ({
        ...pricing,
        model: `model-${index}`,
      })),
    ])
      expect(() => validateModelPricing(value)).toThrow();
  });
});
