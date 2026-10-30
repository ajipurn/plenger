import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API, type ModelPricingResult } from "../src/dashboard/contract.ts";
import { MODELS_DEV_PRICING } from "../src/redteam/constants.ts";
import { fetchModelPricing } from "../src/redteam/models-dev-pricing.ts";
import type { SavedProvider } from "../src/redteam/provider-config.ts";
import { PROVIDER_URLS } from "../src/redteam/provider-config.ts";
import { ProviderRepository } from "../src/storage/provider-repository.ts";
import { startTestDashboard, type TestDashboard } from "./support/dashboard.ts";
import { temporaryDir } from "./support/tmp.ts";

const actualFetch = globalThis.fetch;
const record = `schema = 2
[cost.text.input]
price = 3
cache = { read = 0.3, write = { "5m" = 3.75, "1h" = 6 } }
[cost.text.output]
price = 15
`;

describe("dashboard automatic model pricing", () => {
  let root: string;
  let dashboard: TestDashboard;
  let calls: string[];
  let upstream: () => Response;
  beforeEach(async () => {
    calls = [];
    upstream = () => new Response(record);
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(MODELS_DEV_PRICING.baseUrl)) {
        calls.push(url);
        expect(init?.headers).toBeUndefined();
        return Promise.resolve(upstream());
      }
      return actualFetch(input, init);
    });
    root = await temporaryDir("plenger-pricing-");
    dashboard = await startTestDashboard({ root, pricingLoader: fetchModelPricing });
  });
  afterEach(async () => {
    await dashboard.close();
    vi.unstubAllGlobals();
  });

  it("restores the pricing badge from the persistent cache before the pricing tab is opened", async () => {
    const input = {
      name: "OpenAI",
      provider: "openai",
      model: "gpt-test",
      baseUrl: PROVIDER_URLS.openai,
      temperature: null,
      maxOutputTokens: null,
      apiKey: "synthetic-key",
    };
    const saved = (await (await dashboard.request(API.providers, input)).json()) as SavedProvider;
    const subscription = (await (
      await dashboard.request(API.providers, {
        name: "Subscription",
        provider: "chatgpt",
        model: "gpt-test",
        baseUrl: PROVIDER_URLS.chatgpt,
        temperature: null,
        maxOutputTokens: null,
      })
    ).json()) as SavedProvider;
    upstream = () =>
      new Response(
        "schema = 2\n[cost.text.input]\nprice = 2\ncache = { read = 0.1 }\n[cost.text.output]\nprice = 10",
      );
    expect(
      (await dashboard.request(API.modelPricing, { provider: "openai", model: "gpt-test" })).status,
    ).toBe(200);
    expect(
      (await dashboard.request(API.modelPricing, { provider: "openai", model: "gpt-api-only" }))
        .status,
    ).toBe(200);
    const listings = async () =>
      (await (await dashboard.request(API.providers)).json()) as SavedProvider[];
    const first = await listings();
    expect(first.find((item) => item.id === saved.id)?.cachedModelPricing).toMatchObject([
      { model: "gpt-test" },
      { model: "gpt-api-only" },
    ]);
    expect(first.find((item) => item.id === subscription.id)?.cachedModelPricing).toMatchObject([
      { model: "gpt-test" },
    ]);
    expect(first.find((item) => item.id === saved.id)?.modelPricing).toBeUndefined();
    expect(calls).toHaveLength(2);
    await dashboard.close();
    dashboard = await startTestDashboard({ root, pricingLoader: fetchModelPricing });
    expect(
      (await listings()).find((item) => item.id === saved.id)?.cachedModelPricing,
    ).toMatchObject([{ model: "gpt-test" }, { model: "gpt-api-only" }]);
    expect(calls).toHaveLength(2);
  });

  it.each(["chat-latest", "babbage-002", "davinci-002"])(
    "loads non-GPT OpenAI pricing IDs without guessing an alias: %s",
    async (model) => {
      upstream = () =>
        new Response(
          "schema = 2\n[cost.text.input]\nprice = 1\ncache = { read = 0.5 }\n[cost.text.output]\nprice = 5",
        );
      const result = await dashboard.request(API.modelPricing, { provider: "openai", model });
      expect(result.status).toBe(200);
      const body = (await result.json()) as ModelPricingResult;
      expect(body.pricing).toMatchObject({ model, rates: { input: 1, output: 5, cacheRead: 0.5 } });
      expect(calls).toEqual([`${MODELS_DEV_PRICING.baseUrl}openai/models/${model}.toml`]);
    },
  );

  it("rejects unsafe OpenAI pricing paths before fetching", async () => {
    for (const model of [
      "../chat-latest",
      "chat-latest/../secret",
      "chat-latest?key=private",
      "https://example.com",
      "chat-latest%2fsecret",
    ])
      expect(
        (await dashboard.request(API.modelPricing, { provider: "openai", model })).status,
      ).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("caches public prices across restarts and only replaces manual settings on save", async () => {
    const settings = {
      name: "Claude",
      provider: "anthropic",
      model: "claude-test",
      baseUrl: PROVIDER_URLS.anthropic,
      temperature: null,
      maxOutputTokens: null,
      apiKey: "private-provider-key",
    };
    const manual = [
      {
        model: "claude-test",
        rates: { input: 1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 },
      },
    ];
    const saved = (await (
      await dashboard.request(API.providers, { ...settings, modelPricing: manual })
    ).json()) as SavedProvider;
    const loaded = await dashboard.request(API.modelPricing, { model: "claude-test" });
    expect(loaded.status).toBe(200);
    const first = (await loaded.json()) as ModelPricingResult;
    expect(first).toMatchObject({
      pricing: { source: { name: "models.dev" }, rates: { cacheWrite1h: 6 } },
      stale: false,
    });
    const providers = async () =>
      (await (await dashboard.request(API.providers)).json()) as SavedProvider[];
    expect((await providers())[0]?.modelPricing).toEqual(manual);
    expect(calls).toHaveLength(1);
    await dashboard.close();
    dashboard = await startTestDashboard({ root, pricingLoader: fetchModelPricing });
    expect(
      await (await dashboard.request(API.modelPricing, { model: "claude-test" })).json(),
    ).toEqual(first);
    expect(calls).toHaveLength(1);
    const automatic = (await (
      await dashboard.request(API.providers, {
        ...settings,
        id: saved.id,
        modelPricing: [first.pricing],
      })
    ).json()) as SavedProvider;
    expect(automatic.modelPricing).toEqual([first.pricing]);
    expect(JSON.stringify(automatic)).not.toContain(settings.apiKey);
    upstream = () => new Response(record.replace("price = 3", "price = 4"));
    const refreshed = (await (
      await dashboard.request(API.modelPricing, { model: "claude-test", refresh: true })
    ).json()) as ModelPricingResult;
    expect(refreshed.pricing.rates.input).toBe(4);
    expect((await providers())[0]?.modelPricing).toEqual([first.pricing]);
  });

  it("keeps cached prices when refresh fails and marks automatic stale fallback", async () => {
    const first = (await (
      await dashboard.request(API.modelPricing, { model: "claude-test" })
    ).json()) as ModelPricingResult;
    upstream = () => new Response("private upstream error", { status: 503 });
    const failed = await dashboard.request(API.modelPricing, {
      model: "claude-test",
      refresh: true,
    });
    expect(failed.status).toBe(400);
    expect(JSON.stringify(await failed.json())).not.toContain("private upstream error");
    expect(
      await (await dashboard.request(API.modelPricing, { model: "claude-test" })).json(),
    ).toEqual(first);
    const store = await ProviderRepository.open(`${root}/data`);
    try {
      store.providers.saveModelPricing({
        ...first.pricing,
        source: { name: "models.dev", fetchedAt: "2020-01-01T00:00:00.000Z" },
      });
    } finally {
      store.close();
    }
    expect(
      await (await dashboard.request(API.modelPricing, { model: "claude-test" })).json(),
    ).toMatchObject({ stale: true, pricing: { rates: first.pricing.rates } });
    const missing = await dashboard.request(API.modelPricing, { model: "claude-unknown" });
    expect(missing.status).toBe(400);
  });

  it("rejects arbitrary paths, credentials and refresh flags before fetching", async () => {
    for (const input of [
      { model: "claude-../private" },
      { model: "claude-test", refresh: "yes" },
      { model: "claude-test", apiKey: "private-key" },
      { model: "claude-test", baseUrl: "https://example.com" },
      { model: "gpt-test" },
    ])
      expect((await dashboard.request(API.modelPricing, input)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
