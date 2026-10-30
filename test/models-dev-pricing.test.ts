import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { MODELS_DEV_PRICING } from "../src/redteam/constants.ts";
import {
  parseClaudeTokenUsage,
  reviewBilling,
  tokenCost,
  validateModelPricing,
} from "../src/redteam/model-pricing.ts";
import { fetchModelPricing, parseModelPricing } from "../src/redteam/models-dev-pricing.ts";

// Models.dev's full record format. api.json deliberately omits the 1-hour write rate.
const pricingRecord = `schema = 2
name = "Claude test"
[cost.text.input]
price = 3
cache = { read = 0.3, write = { "5m" = 3.75, "1h" = 6 } }
[cost.text.output]
price = 15
`;

describe("Models.dev Claude pricing", () => {
  it("imports OpenAI default cache-write rates and long context without Claude cache fields", async () => {
    const record = `schema = 2
base_model = "openai/gpt-test"
[cost.text.input]
price = 2
cache = { read = 0.2, write = 2.5 }
[[cost.text.input.overrides]]
when = { context = { gt = 272000 } }
price = 4
cache = { read = 0.4, write = 5 }
[cost.text.output]
price = 10
[[cost.text.output.overrides]]
when = { context = { gt = 272000 } }
price = 15
`;
    let requested: unknown;
    const pricing = await fetchModelPricing(
      "gpt-test",
      undefined,
      async (url) => {
        requested = url;
        return new Response(record);
      },
      "openai",
    );
    expect(requested).toBe(`${MODELS_DEV_PRICING.baseUrl}openai/models/gpt-test.toml`);
    expect(pricing.rates).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
    expect(pricing.longContext).toMatchObject({
      threshold: 272000,
      rates: { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
    });
    const older = parseModelPricing(
      "gpt-test",
      parse("schema = 2\n[cost.text.input]\nprice = 1\n[cost.text.output]\nprice = 5"),
      "openai",
    );
    expect(older.rates.cacheRead).toBe(1);
    expect(older.rates.cacheWrite).toBeUndefined();
  });
  it("imports exact cache lifetimes and snapshots price provenance with the scan", async () => {
    const calls: unknown[] = [];
    const pricing = await fetchModelPricing("claude-test", undefined, async (url, init) => {
      calls.push({ url, init });
      return new Response(pricingRecord);
    });
    expect(calls).toEqual([
      {
        url: `${MODELS_DEV_PRICING.baseUrl}anthropic/models/claude-test.toml`,
        init: { redirect: "error", signal: expect.any(AbortSignal) },
      },
    ]);
    expect(pricing).toEqual({
      model: "claude-test",
      rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
      source: { name: "models.dev", fetchedAt: expect.any(String) },
    });
    const usage = parseClaudeTokenUsage({ input_tokens: 1000, output_tokens: 100 });
    const snapshot = reviewBilling(pricing, [usage], 1);
    pricing.rates.input = 100;
    expect(snapshot.pricing?.rates.input).toBe(3);
    expect(snapshot.pricing?.source).toEqual(pricing.source);
    expect(snapshot.cost?.totalUsd).toBeCloseTo(0.0045);
    expect(validateModelPricing([pricing])[0]?.source).toEqual(pricing.source);
  });

  it("imports long-context overrides, including cached prompt tokens at the boundary", () => {
    const record = `${pricingRecord}
[[cost.text.input.overrides]]
when = { context = { gt = 200000 } }
price = 6
cache = { read = 0.6, write = { "5m" = 7.5, "1h" = 12 } }
[[cost.text.output.overrides]]
when = { context = { gt = 200000 } }
price = 22.5
`;
    const pricing = parseModelPricing("claude-test", parse(record));
    expect(pricing.longContext).toEqual({
      threshold: 200_000,
      rates: { input: 6, output: 22.5, cacheRead: 0.6, cacheWrite5m: 7.5, cacheWrite1h: 12 },
    });
    const usage = parseClaudeTokenUsage({
      input_tokens: 1,
      output_tokens: 10,
      cache_read_input_tokens: 199999,
    });
    expect(tokenCost(pricing, usage)?.longContext).toBe(false);
    expect(tokenCost(pricing, { ...usage, inputTokens: 2 })?.longContext).toBe(true);
  });

  it.each([
    pricingRecord.replace(', "1h" = 6', ""),
    pricingRecord.replace("price = 3", "price = -1"),
    pricingRecord.replace("price = 15", "price = inf"),
    `${pricingRecord}\n[[cost.text.input.overrides]]\nwhen = { context = { gte = 200000 } }\nprice = 6`,
    `${pricingRecord}\n[[cost.text.input.overrides]]\nwhen = { context = { gt = 200000 } }\nprice = 6\n[[cost.text.output.overrides]]\nwhen = { context = { gt = 300000 } }\nprice = 30`,
    `${pricingRecord}\n[[cost.multipliers]]\nwhen = { context = { gt = 200000 } }\nfactor = 2`,
  ])("refuses incomplete or unrepresentable rates without guessing (%#)", (record) => {
    expect(() => parseModelPricing("claude-test", parse(record))).toThrow();
  });

  it("keeps explicit zero prices and rejects invalid provenance", () => {
    const pricing = parseModelPricing(
      "claude-test",
      parse(pricingRecord.replace("price = 3", "price = 0")),
    );
    expect(pricing.rates.input).toBe(0);
    for (const source of [
      { name: "other", fetchedAt: new Date().toISOString() },
      { name: "models.dev", fetchedAt: "yesterday" },
    ])
      expect(() => validateModelPricing([{ ...pricing, source }])).toThrow();
  });

  it("bounds public downloads, rejects paths and returns safe failures", async () => {
    let calls = 0;
    for (const model of [
      "claude-../secret",
      "claude-test?key=private",
      "https://example.com",
      "gpt-test",
    ])
      await expect(
        fetchModelPricing(model, undefined, async () => {
          calls++;
          return new Response(pricingRecord);
        }),
      ).rejects.toThrow("Choose a supported model");
    expect(calls).toBe(0);
    for (const response of [
      new Response("private upstream error", { status: 404 }),
      new Response("not toml = private"),
      new Response("x".repeat(MODELS_DEV_PRICING.bytes + 1)),
    ])
      await expect(
        fetchModelPricing("claude-test", undefined, async () => response),
      ).rejects.toThrow("Unable to load complete pricing from Models.dev");
  });
});
