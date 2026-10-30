import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheModelPricing } from "../dashboard/src/api/model-pricing-cache.ts";
import { API, type ModelPricingResult } from "../src/dashboard/contract.ts";
import { MODELS_DEV_PRICING } from "../src/redteam/constants.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function client() {
  return {
    modelPricing: cacheModelPricing(async (input, signal) => {
      const response = await fetch(API.modelPricing, {
        method: "POST",
        body: JSON.stringify(input),
        ...(signal ? { signal } : {}),
      });
      const value = (await response.json()) as ModelPricingResult & { error?: string };
      if (!response.ok) throw new Error(value.error);
      return value;
    }),
  };
}

describe("provider settings pricing requests", () => {
  it("reuses fresh pricing when settings are reopened", async () => {
    let pricingRequests = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url !== API.modelPricing) throw new Error("Unexpected request");
      pricingRequests++;
      return Response.json({
        pricing: {
          model: "gpt-test",
          rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 0, cacheWrite1h: 0 },
          source: { name: "models.dev", fetchedAt: new Date().toISOString() },
        },
        stale: false,
      });
    });
    const api = client();
    const first = await api.modelPricing({ provider: "openai", model: "gpt-test" });
    const reopened = await api.modelPricing({ provider: "openai", model: "gpt-test" });
    expect(pricingRequests).toBe(1);
    expect(reopened).toEqual(first);
  });

  it("does not retry unavailable models on every reopen, but refresh retries immediately", async () => {
    let pricingRequests = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      expect(url).toBe(API.modelPricing);
      pricingRequests++;
      return Response.json({ error: "Pricing unavailable" }, { status: 400 });
    });
    const api = client();
    const input = { provider: "openai", model: "gpt-unknown" } as const;
    await expect(api.modelPricing(input)).rejects.toThrow("Pricing unavailable");
    await expect(api.modelPricing(input)).rejects.toThrow("Pricing unavailable");
    expect(pricingRequests).toBe(1);
    await expect(api.modelPricing({ ...input, refresh: true })).rejects.toThrow();
    expect(pricingRequests).toBe(2);
  });

  it("expires cached prices and failed lookups, and keeps a valid price after a failed refresh", async () => {
    vi.useFakeTimers();
    let pricingRequests = 0;
    let fail = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      expect(url).toBe(API.modelPricing);
      pricingRequests++;
      if (fail) return Response.json({ error: "Pricing unavailable" }, { status: 400 });
      const { model } = JSON.parse(String(init?.body));
      return Response.json({
        pricing: {
          model,
          rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 0, cacheWrite1h: 0 },
          source: { name: "models.dev", fetchedAt: new Date().toISOString() },
        },
        stale: false,
      });
    });
    const api = client();
    const input = { provider: "openai", model: "gpt-test" } as const;
    const first = await api.modelPricing(input);
    first.pricing.rates.input = 999;
    expect((await api.modelPricing(input)).pricing.rates.input).toBe(2);
    fail = true;
    await expect(api.modelPricing({ ...input, refresh: true })).rejects.toThrow();
    expect((await api.modelPricing(input)).pricing.rates.input).toBe(2);
    expect(pricingRequests).toBe(2);
    vi.advanceTimersByTime(MODELS_DEV_PRICING.cacheMs);
    await expect(api.modelPricing(input)).rejects.toThrow();
    await expect(api.modelPricing(input)).rejects.toThrow();
    expect(pricingRequests).toBe(3);
    vi.advanceTimersByTime(MODELS_DEV_PRICING.retryMs);
    fail = false;
    await api.modelPricing(input);
    expect(pricingRequests).toBe(4);
    await api.modelPricing({ provider: "anthropic", model: "gpt-test" });
    expect(pricingRequests).toBe(5);
  });

  it("does not cache an aborted request or prevent the next editor from loading", async () => {
    let pricingRequests = 0;
    const controller = new AbortController();
    vi.stubGlobal("fetch", async (url: string): Promise<Response> => {
      expect(url).toBe(API.modelPricing);
      pricingRequests++;
      if (pricingRequests === 1) {
        controller.abort();
        throw controller.signal.reason;
      }
      return Response.json({
        pricing: {
          model: "gpt-test",
          rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 0, cacheWrite1h: 0 },
          source: { name: "models.dev", fetchedAt: new Date().toISOString() },
        },
        stale: false,
      } satisfies ModelPricingResult);
    });
    const api = client();
    const input = { provider: "openai", model: "gpt-test" } as const;
    await expect(api.modelPricing(input, controller.signal)).rejects.toThrow();
    await api.modelPricing(input);
    expect(pricingRequests).toBe(2);
  });
});
