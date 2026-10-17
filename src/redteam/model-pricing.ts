import { isRecord } from "../shared/guards.ts";
import { MODEL_ID, MODEL_PRICING_LIMITS } from "./constants.ts";

export const PRICE_FIELDS = [
  "input",
  "output",
  "cacheWrite5m",
  "cacheWrite1h",
  "cacheRead",
] as const;
export type TokenRates = Record<(typeof PRICE_FIELDS)[number], number>;
export interface ModelPricing {
  model: string;
  rates: TokenRates;
  longContext?: { threshold: number; rates: TokenRates };
}
/** Disjoint Claude token categories. Input excludes both cache reads and writes. */
export interface ClaudeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Null means the endpoint did not report the cache write lifetime. */
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
}
export interface CostSummary {
  currency: "USD";
  totalUsd: number;
  complete: boolean;
}
export interface ReviewBilling {
  pricing: ModelPricing | null;
  usage: (ClaudeTokenUsage & { request: number })[];
  cost: CostSummary | null;
}

export function validateModelPricing(value: unknown): ModelPricing[] {
  const fail = () => new Error("Enter valid USD prices for each model and token category.");
  if (!Array.isArray(value) || value.length > MODEL_PRICING_LIMITS.models) throw fail();
  const models = new Set<string>();
  const rates = (value: unknown): TokenRates => {
    if (!isRecord(value) || Object.keys(value).length !== PRICE_FIELDS.length) throw fail();
    for (const field of PRICE_FIELDS)
      if (
        typeof value[field] !== "number" ||
        !Number.isFinite(value[field]) ||
        value[field] < 0 ||
        value[field] > MODEL_PRICING_LIMITS.perMillion
      )
        throw fail();
    return Object.fromEntries(PRICE_FIELDS.map((field) => [field, value[field]])) as TokenRates;
  };
  return value.map((item): ModelPricing => {
    if (
      !isRecord(item) ||
      Object.keys(item).some((key) => !["model", "rates", "longContext"].includes(key)) ||
      typeof item.model !== "string" ||
      !MODEL_ID.test(item.model) ||
      item.model.includes("://") ||
      models.has(item.model)
    )
      throw fail();
    models.add(item.model);
    let longContext: ModelPricing["longContext"];
    if (item.longContext !== undefined) {
      const tier = item.longContext;
      if (
        !isRecord(tier) ||
        Object.keys(tier).length !== 2 ||
        !Number.isSafeInteger(tier.threshold) ||
        (tier.threshold as number) < 1
      )
        throw fail();
      longContext = { threshold: tier.threshold as number, rates: rates(tier.rates) };
    }
    return { model: item.model, rates: rates(item.rates), ...(longContext ? { longContext } : {}) };
  });
}

/** Parse usage independently of budget accounting so cached tokens are never counted twice. */
export function parseClaudeTokenUsage(value: unknown): ClaudeTokenUsage {
  const fail = () => new Error("Invalid Claude token usage.");
  if (!isRecord(value)) throw fail();
  const count = (value: unknown): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw fail();
    return value as number;
  };
  const usage: ClaudeTokenUsage = {
    inputTokens: count(value.input_tokens),
    outputTokens: count(value.output_tokens),
    cacheReadTokens: count(value.cache_read_input_tokens ?? 0),
    cacheCreationTokens: count(value.cache_creation_input_tokens ?? 0),
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
  };
  if (
    !Number.isSafeInteger(
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
    )
  )
    throw fail();
  if (value.cache_creation != null) {
    if (!isRecord(value.cache_creation)) throw fail();
    usage.cacheWrite5mTokens = count(value.cache_creation.ephemeral_5m_input_tokens);
    usage.cacheWrite1hTokens = count(value.cache_creation.ephemeral_1h_input_tokens);
    if (usage.cacheWrite5mTokens + usage.cacheWrite1hTokens !== usage.cacheCreationTokens)
      throw fail();
  } else if (usage.cacheCreationTokens === 0) {
    usage.cacheWrite5mTokens = 0;
    usage.cacheWrite1hTokens = 0;
  }
  return usage;
}

/** Tier selection is per request, using ALL input tokens, including cached input. */
export function tokenCost(pricing: ModelPricing, usage: ClaudeTokenUsage) {
  if (usage.cacheWrite5mTokens === null || usage.cacheWrite1hTokens === null) return null;
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const longContext = !!pricing.longContext && promptTokens > pricing.longContext.threshold;
  const rates = longContext && pricing.longContext ? pricing.longContext.rates : pricing.rates;
  const tokens = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheWrite5m: usage.cacheWrite5mTokens,
    cacheWrite1h: usage.cacheWrite1hTokens,
    cacheRead: usage.cacheReadTokens,
  };
  const amounts = Object.fromEntries(
    PRICE_FIELDS.map((field) => [
      field,
      (tokens[field] * rates[field]) / MODEL_PRICING_LIMITS.perMillion,
    ]),
  ) as TokenRates;
  const totalUsd = PRICE_FIELDS.reduce((sum, field) => sum + amounts[field], 0);
  return Number.isFinite(totalUsd) ? { amounts, totalUsd, longContext } : null;
}

/**
 * The most one request can cost: every prompt token at the dearest prompt rate of the
 * tiers it can fall in, and its whole output allowance at the output rate.
 */
export function worstCaseCost(
  pricing: ModelPricing,
  promptTokens: number,
  outputTokens: number,
): number {
  const tiers = [
    pricing.rates,
    ...(pricing.longContext && promptTokens > pricing.longContext.threshold
      ? [pricing.longContext.rates]
      : []),
  ];
  const prompt = Math.max(
    ...tiers.flatMap((rates) => [
      rates.input,
      rates.cacheWrite5m,
      rates.cacheWrite1h,
      rates.cacheRead,
    ]),
  );
  const output = Math.max(...tiers.map((rates) => rates.output));
  return (promptTokens * prompt + outputTokens * output) / MODEL_PRICING_LIMITS.perMillion;
}

export function reviewBilling(
  pricing: ModelPricing | null,
  usage: ClaudeTokenUsage[],
  calls: number,
): ReviewBilling {
  const priced = pricing ? usage.map((item) => tokenCost(pricing, item)) : [];
  const available = priced.filter((item) => item !== null);
  return {
    pricing: pricing ? structuredClone(pricing) : null,
    usage: usage.map((item, index) => ({ ...item, request: index + 1 })),
    cost:
      pricing && (available.length || calls === 0)
        ? {
            currency: "USD",
            totalUsd: available.reduce((sum, item) => sum + item.totalUsd, 0),
            complete: usage.length === calls && available.length === calls,
          }
        : null,
  };
}

export function sumCosts(costs: (CostSummary | null | undefined)[]): CostSummary | null {
  const available = costs.filter((cost) => cost != null);
  if (!available.length) return null;
  return {
    currency: "USD",
    totalUsd: available.reduce((sum, cost) => sum + cost.totalUsd, 0),
    complete: available.length === costs.length && available.every((cost) => cost.complete),
  };
}
