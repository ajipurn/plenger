import { describe, expect, it, vi } from "vitest";
import { ModelBudget } from "../src/redteam/budget.ts";
import { ANTHROPIC, PROVIDER_MODEL_LIMITS } from "../src/redteam/constants.ts";
import { createRunProvider } from "../src/redteam/provider.ts";
import { validateProviderConfig, validateProviderInput } from "../src/redteam/provider-config.ts";
import { listProviderModels } from "../src/redteam/provider-models.ts";

const key = "private-test-api-key";
const request = { messages: [{ role: "user", content: "Hello" }], tools: null };

describe("provider model catalogs and generation defaults", () => {
  it("keeps a Claude model's reported input window and ignores invalid ones", async () => {
    const dispatch: typeof fetch = async () =>
      Response.json({
        data: [
          { id: "claude-wide", display_name: "Wide", max_input_tokens: 1_000_000 },
          { id: "claude-unknown", display_name: "Unknown", max_input_tokens: null },
          { id: "claude-broken", display_name: "Broken", max_input_tokens: -5 },
        ],
        has_more: false,
        last_id: "claude-broken",
      });
    expect(
      await listProviderModels({ provider: "anthropic", apiKey: key }, undefined, dispatch),
    ).toEqual([
      { id: "claude-wide", name: "Wide", maxInputTokens: 1_000_000 },
      { id: "claude-unknown", name: "Unknown" },
      { id: "claude-broken", name: "Broken" },
    ]);
  });

  it("loads every Claude catalog page with native headers and provider display names", async () => {
    const dispatch = vi.fn<typeof fetch>(async (url, options) => {
      expect(options).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: { "x-api-key": key, "anthropic-version": ANTHROPIC.version },
      });
      expect(options?.body).toBeUndefined();
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get("limit")).toBe(String(PROVIDER_MODEL_LIMITS.pageSize));
      return Response.json(
        parsed.searchParams.has("after_id")
          ? {
              data: [{ id: "claude-second", display_name: "Second model" }],
              has_more: false,
              last_id: "claude-second",
            }
          : {
              data: [{ id: "claude-first", display_name: "First model" }],
              has_more: true,
              last_id: "claude-first",
            },
      );
    });
    expect(
      await listProviderModels({ provider: "anthropic", apiKey: key }, undefined, dispatch),
    ).toEqual([
      { id: "claude-first", name: "First model" },
      { id: "claude-second", name: "Second model" },
    ]);
    expect(new URL(String(dispatch.mock.calls[1]?.[0])).searchParams.get("after_id")).toBe(
      "claude-first",
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("loads OpenAI model identifiers from one authenticated GET and deduplicates them", async () => {
    const dispatch = vi.fn<typeof fetch>(async (url, options) => {
      expect(url).toBe("https://api.openai.com/v1/models");
      expect(options).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: { Authorization: `Bearer ${key}` },
      });
      return Response.json({
        object: "list",
        data: [{ id: "model-a" }, { id: "model-a" }, { id: "model-b" }],
      });
    });
    expect(
      await listProviderModels({ provider: "openai", apiKey: key }, undefined, dispatch),
    ).toEqual([
      { id: "model-a", name: "model-a" },
      { id: "model-b", name: "model-b" },
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { data: [{ id: "bad\nmodel" }], has_more: false },
    { data: [], has_more: true, last_id: "same-cursor" },
    { data: [{ id: key }], has_more: false },
    { data: Array(PROVIDER_MODEL_LIMITS.models + 1).fill({ id: "model-a" }), has_more: false },
  ])("rejects malformed or unbounded catalogs without exposing credentials", async (response) => {
    const dispatch = vi.fn<typeof fetch>(async () => Response.json(response));
    await expect(
      listProviderModels({ provider: "anthropic", apiKey: key }, undefined, dispatch),
    ).rejects.toThrow("Unable to load models.");
    expect(dispatch.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("redacts reflected secrets and reduces provider errors to their HTTP status without retries", async () => {
    expect(
      await listProviderModels({ provider: "anthropic", apiKey: key }, undefined, async () =>
        Response.json({
          data: [{ id: "claude-test", display_name: `Model ${key}` }],
          has_more: false,
        }),
      ),
    ).toEqual([{ id: "claude-test", name: "Model <redacted>" }]);
    const dispatch = vi.fn<typeof fetch>(async () =>
      Response.json({ error: key }, { status: 401 }),
    );
    await expect(
      listProviderModels({ provider: "openai", apiKey: key }, undefined, dispatch),
    ).rejects.toThrow("HTTP 401");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("persists null defaults without accepting null limits for other providers", () => {
    const value = {
      name: "OpenAI",
      provider: "openai",
      model: "model-a",
      baseUrl: "https://api.openai.com/v1",
      temperature: null,
      maxOutputTokens: null,
    };
    expect(validateProviderInput(value)).toEqual(value);
    const { provider: _provider, model: _model, ...config } = value;
    expect(() =>
      validateProviderConfig({ ...config, id: "saved-provider" }, "openai", "model-a"),
    ).not.toThrow();
    expect(() => validateProviderInput({ ...value, provider: "ollama" })).toThrow("output limit");
  });

  it("sends the operation allowance as the OpenAI output cap for automatic settings", async () => {
    const dispatch = vi.fn<typeof fetch>(async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      expect(body).not.toHaveProperty("temperature");
      expect(body).toHaveProperty("max_completion_tokens", 2000);
      expect(body).not.toHaveProperty("max_tokens");
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: "OK" } }],
        usage: { prompt_tokens: 10, completion_tokens: 1500, total_tokens: 1510 },
      });
    });
    const provider = createRunProvider(
      {
        provider: "openai",
        model: "model-a",
        apiKey: key,
        temperature: null,
        maxOutputTokens: null,
        outputTokenBudget: 2000,
      },
      dispatch,
    );
    const reservation = provider.reservation(request, "setup");
    expect(reservation).toMatchObject({ maxOutputTokens: 2000 });
    expect(reservation).not.toHaveProperty("tokenLimitMode");
    const budget = new ModelBudget({ maxModelCalls: 1, maxTokens: 100_000, timeoutMs: 1000 });
    try {
      expect(
        await budget.execute(reservation, (allowance) => provider.generate(request, allowance)),
      ).toMatchObject({ content: "OK" });
      const snapshot = budget.finish();
      expect(snapshot).toMatchObject({ observedTokens: 1510, state: "completed" });
      expect(snapshot).not.toHaveProperty("tokenLimitMode");
    } finally {
      budget.finish();
    }
  });

  it.each([4096, 32_000])(
    "sets required Claude output automatically from model metadata and the operation allowance: %i",
    async (modelLimit) => {
      const bodies: Record<string, unknown>[] = [];
      const dispatch = vi.fn<typeof fetch>(async (url, options) => {
        if (options?.method === "GET") {
          expect(url).toBe("https://api.anthropic.com/v1/models/claude-test");
          return Response.json({ id: "claude-test", max_tokens: modelLimit });
        }
        bodies.push(JSON.parse(String(options?.body)));
        return Response.json({
          type: "message",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 10, output_tokens: 2 },
        });
      });
      const provider = createRunProvider(
        {
          provider: "anthropic",
          model: "claude-test",
          apiKey: key,
          temperature: null,
          maxOutputTokens: null,
          outputTokenBudget: 8192,
        },
        dispatch,
      );
      const allowance = {
        signal: new AbortController().signal,
        maxOutputTokens: provider.reservation(request, "setup").maxOutputTokens,
      };
      await provider.generate(request, allowance);
      await provider.generate(request, allowance);
      expect(bodies).toHaveLength(2);
      for (const body of bodies) {
        expect(body.max_tokens).toBe(Math.min(modelLimit, 8192));
        expect(body).not.toHaveProperty("temperature");
      }
      expect(dispatch).toHaveBeenCalledTimes(3);
    },
  );
});
