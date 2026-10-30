import { isRecord } from "../shared/guards.ts";
import { MODEL_ID, MODEL_PRICING_LIMITS, MODELS_DEV_PRICING } from "./constants.ts";

export const PRICE_FIELDS = [
  "input",
  "output",
  "cacheWrite5m",
  "cacheWrite1h",
  "cacheRead",
] as const;
export const BILLING_PRICE_FIELDS = [...PRICE_FIELDS, "cacheWrite"] as const;
export type TokenRates = Record<(typeof PRICE_FIELDS)[number], number> & { cacheWrite?: number };
export interface ModelPricing {
  model: string;
  rates: TokenRates;
  longContext?: { threshold: number; rates: TokenRates };
  /** Absent for manual rates, including connections saved before automatic pricing. */
  source?: { name: typeof MODELS_DEV_PRICING.source; fetchedAt: string };
}
/** Disjoint billable categories. Input excludes both cache reads and writes. */
export interface BillableTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Null means the endpoint did not report the cache write lifetime. */
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  /** OpenAI's default cache-write lifetime, when the transport reports writes. */
  cacheWriteTokens?: number;
}
export type ClaudeTokenUsage = BillableTokenUsage;
export interface CostSummary {
  currency: "USD";
  totalUsd: number;
  complete: boolean;
  /** Absent on API estimates, including historical scans. Mixed totals include both bases. */
  basis?: "api-equivalent" | "mixed";
}
export interface ReviewBilling {
  basis?: "api-equivalent";
  pricing: ModelPricing | null;
  usage: (BillableTokenUsage & { request: number })[];
  cost: CostSummary | null;
}

/** Responses usage includes cached input in input_tokens and reasoning in output_tokens. */
export function parseOpenAIResponsesTokenUsage(value: unknown): BillableTokenUsage | undefined {
  if (!isRecord(value)) throw new Error("Invalid OpenAI token usage.");
  const usage = parseOpenAITokenUsage({
    prompt_tokens: value.input_tokens,
    completion_tokens: value.output_tokens,
    total_tokens: value.total_tokens,
    prompt_tokens_details: value.input_tokens_details,
    completion_tokens_details: value.output_tokens_details,
  });
  return isRecord(value.input_tokens_details) && value.input_tokens_details.cached_tokens != null
    ? usage
    : undefined;
}

export function validateModelPricing(value: unknown): ModelPricing[] {
  const fail = () => new Error("Enter valid USD prices for each model and token category.");
  if (!Array.isArray(value) || value.length > MODEL_PRICING_LIMITS.models) throw fail();
  const models = new Set<string>();
  const rates = (value: unknown): TokenRates => {
    if (
      !isRecord(value) ||
      Object.keys(value).some((key) => !(BILLING_PRICE_FIELDS as readonly string[]).includes(key))
    )
      throw fail();
    for (const field of BILLING_PRICE_FIELDS) {
      if (field === "cacheWrite" && value[field] === undefined) continue;
      if (
        typeof value[field] !== "number" ||
        !Number.isFinite(value[field]) ||
        value[field] < 0 ||
        value[field] > MODEL_PRICING_LIMITS.perMillion
      )
        throw fail();
    }
    return Object.fromEntries(
      BILLING_PRICE_FIELDS.filter((field) => value[field] !== undefined).map((field) => [
        field,
        value[field],
      ]),
    ) as TokenRates;
  };
  return value.map((item): ModelPricing => {
    if (
      !isRecord(item) ||
      Object.keys(item).some((key) => !["model", "rates", "longContext", "source"].includes(key)) ||
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
    let source: ModelPricing["source"];
    if (item.source !== undefined) {
      if (
        !isRecord(item.source) ||
        Object.keys(item.source).length !== 2 ||
        item.source.name !== MODELS_DEV_PRICING.source ||
        typeof item.source.fetchedAt !== "string" ||
        !Number.isFinite(Date.parse(item.source.fetchedAt)) ||
        new Date(item.source.fetchedAt).toISOString() !== item.source.fetchedAt
      )
        throw fail();
      source = { name: MODELS_DEV_PRICING.source, fetchedAt: item.source.fetchedAt };
    }
    return {
      model: item.model,
      rates: rates(item.rates),
      ...(longContext ? { longContext } : {}),
      ...(source ? { source } : {}),
    };
  });
}

/** Chat Completions includes cache hits and writes in prompt_tokens, and reasoning in output. */
export function parseOpenAITokenUsage(value: unknown): BillableTokenUsage | undefined {
  const fail = () => new Error("Invalid OpenAI token usage.");
  if (!isRecord(value)) throw fail();
  const count = (value: unknown): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw fail();
    return value as number;
  };
  const prompt = count(value.prompt_tokens);
  const output = count(value.completion_tokens);
  if (!Number.isSafeInteger(prompt + output) || count(value.total_tokens) !== prompt + output)
    throw fail();
  // Compatible endpoints may omit the breakdown; preserve totals without guessing cost.
  if (value.prompt_tokens_details == null) return;
  if (!isRecord(value.prompt_tokens_details)) throw fail();
  const details = value.prompt_tokens_details;
  const cached = count(details.cached_tokens ?? 0);
  const written = count(details.cache_write_tokens ?? 0);
  if (!Number.isSafeInteger(cached + written) || cached + written > prompt) throw fail();
  if (count(details.audio_tokens ?? 0) || count(details.image_tokens ?? 0)) return;
  if (value.completion_tokens_details != null) {
    if (!isRecord(value.completion_tokens_details)) throw fail();
    if (count(value.completion_tokens_details.audio_tokens ?? 0)) return;
    if (count(value.completion_tokens_details.reasoning_tokens ?? 0) > output) throw fail();
  }
  return {
    inputTokens: prompt - cached - written,
    outputTokens: output,
    cacheReadTokens: cached,
    cacheCreationTokens: written,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    ...(written ? { cacheWriteTokens: written } : {}),
  };
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
export function tokenCost(pricing: ModelPricing, usage: BillableTokenUsage) {
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
    cacheWrite: usage.cacheWriteTokens ?? 0,
  };
  if (tokens.cacheWrite && rates.cacheWrite === undefined) return null;
  const fields = BILLING_PRICE_FIELDS.filter((field) => rates[field] !== undefined);
  const amounts = Object.fromEntries(
    fields.map((field) => [
      field,
      (tokens[field] * (rates[field] ?? 0)) / MODEL_PRICING_LIMITS.perMillion,
    ]),
  ) as TokenRates;
  const totalUsd = fields.reduce((sum, field) => sum + (amounts[field] ?? 0), 0);
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
      rates.cacheWrite ?? 0,
    ]),
  );
  const output = Math.max(...tiers.map((rates) => rates.output));
  return (promptTokens * prompt + outputTokens * output) / MODEL_PRICING_LIMITS.perMillion;
}

export function reviewBilling(
  pricing: ModelPricing | null,
  usage: BillableTokenUsage[],
  calls: number,
  basis?: "api-equivalent",
): ReviewBilling {
  const priced = pricing ? usage.map((item) => tokenCost(pricing, item)) : [];
  const available = priced.filter((item) => item !== null);
  return {
    ...(basis ? { basis } : {}),
    pricing: pricing ? structuredClone(pricing) : null,
    usage: usage.map((item, index) => ({ ...item, request: index + 1 })),
    cost:
      pricing && (available.length || calls === 0)
        ? {
            currency: "USD",
            totalUsd: available.reduce((sum, item) => sum + item.totalUsd, 0),
            complete: usage.length === calls && available.length === calls,
            ...(basis ? { basis } : {}),
          }
        : null,
  };
}

export function sumCosts(costs: (CostSummary | null | undefined)[]): CostSummary | null {
  const available = costs.filter((cost) => cost != null);
  if (!available.length) return null;
  const bases = new Set(available.map((cost) => cost.basis ?? "api"));
  const basis = bases.size > 1 ? "mixed" : available[0]?.basis;
  return {
    currency: "USD",
    totalUsd: available.reduce((sum, cost) => sum + cost.totalUsd, 0),
    complete: available.length === costs.length && available.every((cost) => cost.complete),
    ...(basis ? { basis } : {}),
  };
}
