import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API, type ModelWindowResult } from "../src/dashboard/contract.ts";
import { ModelWindowCatalog } from "../src/dashboard/model-windows.ts";
import { MODELS_DEV_PRICING } from "../src/redteam/constants.ts";
import { fetchModelWindow } from "../src/redteam/models-dev-window.ts";
import {
  PROVIDER_URLS,
  type ProviderInput,
  type SavedProvider,
} from "../src/redteam/provider-config.ts";
import { ProviderRepository } from "../src/storage/provider-repository.ts";
import { startTestDashboard } from "./support/dashboard.ts";
import { temporaryDir } from "./support/tmp.ts";

const providerRecord = (base: string, extra = "") =>
  `schema = 2\nbase_model = "${base}"\n${extra}[cost.text.input]\nprice = 1\n`;
const baseRecord = (limit: string) => `schema = 2\nname = "Test model"\n[limit]\n${limit}\n`;
const providerUrl = (provider: string, model: string) =>
  `${MODELS_DEV_PRICING.baseUrl}${provider}/models/${model}.toml`;
const baseUrl = (base: string) => `${MODELS_DEV_PRICING.modelsUrl}${base}.toml`;

/** Serves the given Models.dev records and answers 404 for any other path. */
function modelsDev(records: Record<string, string>) {
  const requested: string[] = [];
  const dispatch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const record = records[url];
    return record === undefined ? new Response("Not found", { status: 404 }) : new Response(record);
  }) as typeof fetch;
  return { requested, dispatch };
}

describe("Models.dev input windows", () => {
  it("reads the input limit of the base model a provider record names", async () => {
    const { requested, dispatch } = modelsDev({
      [providerUrl("openai", "gpt-test")]: providerRecord("openai/gpt-test"),
      [baseUrl("openai/gpt-test")]: baseRecord(
        "context = 1_050_000\ninput = 922_000\noutput = 128_000",
      ),
    });
    const window = await fetchModelWindow("openai", "gpt-test", undefined, dispatch);
    expect(window.inputTokens).toBe(922_000);
    expect(requested).toEqual([providerUrl("openai", "gpt-test"), baseUrl("openai/gpt-test")]);
  });

  it("uses the context window when a record lists no separate input limit", async () => {
    const { dispatch } = modelsDev({
      [providerUrl("google", "gemini-test")]: providerRecord("google/gemini-test"),
      [baseUrl("google/gemini-test")]: baseRecord("context = 1_048_576\noutput = 65_536"),
    });
    const window = await fetchModelWindow("google", "gemini-test", undefined, dispatch);
    expect(window.inputTokens).toBe(1_048_576);
  });

  it("prefers a limit on the provider's own record", async () => {
    const { requested, dispatch } = modelsDev({
      [providerUrl("anthropic", "claude-test")]: providerRecord(
        "anthropic/claude-test",
        "[limit]\ncontext = 200_000\noutput = 64_000\n",
      ),
    });
    const window = await fetchModelWindow("anthropic", "claude-test", undefined, dispatch);
    expect(window.inputTokens).toBe(200_000);
    expect(requested).toHaveLength(1);
  });

  it("lists no window for an unlisted model, a malformed name or an unsafe base model", async () => {
    const { requested, dispatch } = modelsDev({
      [providerUrl("openai", "gpt-escape")]: providerRecord("../providers/openai"),
    });
    expect((await fetchModelWindow("openai", "gpt-missing", undefined, dispatch)).inputTokens).toBe(
      null,
    );
    expect((await fetchModelWindow("openai", "gpt-escape", undefined, dispatch)).inputTokens).toBe(
      null,
    );
    expect((await fetchModelWindow("openai", "../gpt", undefined, dispatch)).inputTokens).toBe(
      null,
    );
    expect(requested).toEqual([
      providerUrl("openai", "gpt-missing"),
      providerUrl("openai", "gpt-escape"),
    ]);
  });

  it("fails when Models.dev cannot answer, so a cached window is not replaced", async () => {
    await expect(
      fetchModelWindow(
        "openai",
        "gpt-test",
        undefined,
        async () => new Response("", { status: 500 }),
      ),
    ).rejects.toThrow("Models.dev record unavailable.");
    await expect(
      fetchModelWindow("openai", "gpt-test", undefined, async () => {
        throw new TypeError("fetch failed");
      }),
    ).rejects.toThrow();
  });
});

describe("model window catalog", () => {
  let store: Awaited<ReturnType<typeof ProviderRepository.open>>;
  let loads: string[];
  let fail: boolean;
  let catalog: ModelWindowCatalog;
  const now = () => new Date().toISOString();
  const save = (input: Partial<ProviderInput> & Pick<ProviderInput, "provider">) =>
    store.providers.saveProvider({
      name: `${input.provider} ${input.baseUrl ?? "default"}`,
      model: "gpt-test",
      baseUrl: PROVIDER_URLS[input.provider],
      temperature: null,
      maxOutputTokens: 8192,
      ...input,
    });
  beforeEach(async () => {
    store = await ProviderRepository.open(join(await temporaryDir("plenger-windows-"), "data"));
    loads = [];
    fail = false;
    catalog = new ModelWindowCatalog(store.providers, async (provider, model) => {
      loads.push(`${provider}/${model}`);
      if (fail) throw new Error("Models.dev record unavailable.");
      return { inputTokens: model === "gpt-unlisted" ? null : 400_000, fetchedAt: now() };
    });
  });
  afterEach(() => store.close());

  it("looks up every hosted provider under its Models.dev name and caches the window", async () => {
    const chatgpt = save({ provider: "chatgpt" });
    const openai = save({ provider: "openai", apiKey: "synthetic-key" });
    const gemini = save({ provider: "gemini", model: "gemini-test", apiKey: "synthetic-key" });
    const claude = save({ provider: "anthropic", model: "claude-test", apiKey: "synthetic-key" });
    expect(await catalog.forScan(chatgpt, undefined, "gpt-test")).toBe(400_000);
    expect(await catalog.forScan(openai, "synthetic-key", "gpt-test")).toBe(400_000);
    expect(await catalog.forScan(gemini, "synthetic-key", "gemini-test")).toBe(400_000);
    expect(await catalog.forScan(claude, "synthetic-key", "claude-test")).toBe(400_000);
    // ChatGPT and the OpenAI API share one cached record.
    expect(loads).toEqual(["openai/gpt-test", "google/gemini-test", "anthropic/claude-test"]);
  });

  it("looks an unlisted model up again instead of caching its absence", async () => {
    const chatgpt = save({ provider: "chatgpt" });
    expect(await catalog.forScan(chatgpt, undefined, "gpt-unlisted")).toBeNull();
    expect(await catalog.forScan(chatgpt, undefined, "gpt-unlisted")).toBeNull();
    expect(loads).toEqual(["openai/gpt-unlisted", "openai/gpt-unlisted"]);
  });

  it("skips local Ollama models and other endpoints, whose context can be smaller", async () => {
    const ollama = save({ provider: "ollama", model: "gpt-oss:20b" });
    const proxy = save({
      provider: "openai",
      baseUrl: "https://proxy.example.test/v1",
      apiKey: "synthetic-key",
    });
    expect(await catalog.forScan(ollama, undefined, "gpt-oss:20b")).toBeNull();
    expect(await catalog.forScan(proxy, "synthetic-key", "gpt-test")).toBeNull();
    expect(loads).toEqual([]);
  });

  it("prefers the window in the provider's own model catalog", async () => {
    const claude = save({ provider: "anthropic", model: "claude-test", apiKey: "synthetic-key" });
    store.providers.saveModelCatalog(
      { provider: "anthropic", baseUrl: PROVIDER_URLS.anthropic, apiKey: "synthetic-key" },
      [{ id: "claude-test", name: "Claude test", maxInputTokens: 200_000 }],
    );
    expect(await catalog.forScan(claude, "synthetic-key", "claude-test")).toBe(200_000);
    expect(loads).toEqual([]);
  });

  it("keeps an expired window when Models.dev fails, and otherwise uses none", async () => {
    const chatgpt = save({ provider: "chatgpt" });
    const expired = new Date(Date.now() - MODELS_DEV_PRICING.cacheMs - 1000).toISOString();
    store.providers.saveModelWindow("openai", "gpt-test", {
      inputTokens: 300_000,
      fetchedAt: expired,
    });
    fail = true;
    expect(await catalog.forScan(chatgpt, undefined, "gpt-test")).toBe(300_000);
    expect(await catalog.forScan(chatgpt, undefined, "gpt-other")).toBeNull();
    expect(loads).toEqual(["openai/gpt-test", "openai/gpt-other"]);
  });
});

describe("dashboard model window", () => {
  it("gives New Scan the window a scan with that model uses", async () => {
    const loads: string[] = [];
    const dashboard = await startTestDashboard({
      root: await temporaryDir("plenger-window-route-"),
      windowLoader: async (provider, model) => {
        loads.push(`${provider}/${model}`);
        return { inputTokens: 922_000, fetchedAt: new Date().toISOString() };
      },
    });
    try {
      const saved = (await (
        await dashboard.request(API.providers, {
          name: "OpenAI",
          provider: "openai",
          model: "gpt-test",
          baseUrl: PROVIDER_URLS.openai,
          temperature: null,
          maxOutputTokens: null,
          apiKey: "synthetic-key",
        })
      ).json()) as SavedProvider;
      const response = await dashboard.request(API.modelWindow, {
        id: saved.id,
        model: "gpt-test",
      });
      expect(response.status).toBe(200);
      expect((await response.json()) as ModelWindowResult).toEqual({ inputTokens: 922_000 });
      expect(loads).toEqual(["openai/gpt-test"]);
      expect(
        (await dashboard.request(API.modelWindow, { id: saved.id, model: "https://x" })).status,
      ).toBe(400);
      expect(
        (await dashboard.request(API.modelWindow, { id: "missing", model: "gpt-test" })).status,
      ).toBe(404);
    } finally {
      await dashboard.close();
    }
  });
});
