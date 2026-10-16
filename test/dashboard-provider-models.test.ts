import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API, type ProviderModelsResult } from "../src/dashboard/contract.ts";
import type { SavedProvider } from "../src/redteam/provider-config.ts";
import { startTestDashboard, type TestDashboard } from "./support/dashboard.ts";
import { temporaryDir } from "./support/tmp.ts";

describe("dashboard provider model discovery", () => {
  let dashboard: TestDashboard;
  let root: string;
  let baseUrl: string;
  let status: number;
  let data: { id: string; display_name: string }[];
  let calls: { path: string; key: string; method: string }[];
  const upstream = createServer((request, response) => {
    calls.push({
      path: request.url ?? "",
      method: request.method ?? "",
      key: String(request.headers["x-api-key"] ?? request.headers.authorization ?? ""),
    });
    response.setHeader("Content-Type", "application/json");
    response.statusCode = status;
    response.end(
      JSON.stringify(
        status === 200
          ? {
              object: "list",
              data,
              has_more: false,
            }
          : { error: "private-draft-key upstream request details" },
      ),
    );
  });
  beforeEach(async () => {
    calls = [];
    status = 200;
    data = [{ id: "model-test", display_name: "Available model" }];
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Test provider did not bind.");
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
    root = await temporaryDir("plenger-catalog-");
    dashboard = await startTestDashboard({ root });
  });
  afterEach(async () => {
    await dashboard.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it.each(["anthropic", "openai"] as const)(
    "loads %s draft models without saving the key or creating a provider",
    async (provider) => {
      const result = await dashboard.request(API.providerModels, {
        provider,
        baseUrl,
        apiKey: "private-draft-key",
      });
      expect(result.status).toBe(200);
      const body = (await result.json()) as ProviderModelsResult;
      expect(body.models).toEqual([{ id: "model-test", name: "Available model" }]);
      expect(JSON.stringify(body)).not.toContain("private-draft-key");
      expect(await (await dashboard.request(API.providers)).json()).toEqual([]);
      expect(calls).toEqual([
        {
          path: provider === "anthropic" ? "/v1/models?limit=100" : "/v1/models",
          method: "GET",
          key: provider === "anthropic" ? "private-draft-key" : "Bearer private-draft-key",
        },
      ]);
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(root, "data/dashboard.sqlite"));
      try {
        const rows = db.prepare("SELECT * FROM provider_model_catalogs").all();
        expect(rows).toHaveLength(1);
        expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["connection_id", "payload"]);
        expect(rows[0]?.connection_id).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(rows)).not.toContain("private-draft-key");
      } finally {
        db.close();
      }
      await dashboard.close();
      dashboard = await startTestDashboard({ root });
      const restored = await dashboard.request(API.providerModels, {
        provider,
        baseUrl: `${baseUrl}/`,
        apiKey: "private-draft-key",
      });
      expect(await restored.json()).toEqual(body);
      expect(calls).toHaveLength(1);
      const saved = (await (
        await dashboard.request(API.providers, {
          name: "Saved after loading models",
          provider,
          baseUrl,
          apiKey: "private-draft-key",
          model: "model-test",
          temperature: null,
          maxOutputTokens: null,
        })
      ).json()) as SavedProvider;
      expect(
        await (await dashboard.request(`${API.providerModels}?id=${saved.id}`)).json(),
      ).toEqual(body);
      expect(calls).toHaveLength(1);
    },
  );

  it("uses a saved key only for its existing destination and preserves automatic settings", async () => {
    const settings = {
      name: "Claude",
      provider: "anthropic",
      model: "model-test",
      baseUrl,
      apiKey: "saved-private-key",
      temperature: null,
      maxOutputTokens: null,
    };
    const saved = (await (
      await dashboard.request(API.providers, settings)
    ).json()) as SavedProvider;
    expect(saved).toMatchObject({ temperature: null, maxOutputTokens: null, hasApiKey: true });
    const input = { id: saved.id, provider: "anthropic", baseUrl };
    expect(
      await (await dashboard.request(`${API.providerModels}?id=${saved.id}`)).json(),
    ).toBeNull();
    expect(calls).toHaveLength(0);
    expect((await dashboard.request(API.providerModels, input)).status).toBe(200);
    expect(calls[0]?.key).toBe("saved-private-key");
    for (const patch of [{ provider: "openai" }, { baseUrl: `${baseUrl}/other` }])
      expect((await dashboard.request(API.providerModels, { ...input, ...patch })).status).toBe(
        400,
      );
    expect(calls).toHaveLength(1);
    expect(await (await dashboard.request(API.providers)).json()).toEqual([saved]);
    expect(
      (
        await dashboard.request(API.providerModels, {
          ...input,
          baseUrl: `${baseUrl}/other`,
          apiKey: "replacement-key",
        })
      ).status,
    ).toBe(200);
    expect(calls[1]?.key).toBe("replacement-key");
    expect((await dashboard.request(API.providerModels, input)).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("restores a saved provider catalog across restarts and keeps it when a refresh fails", async () => {
    const saved = (await (
      await dashboard.request(API.providers, {
        name: "Claude",
        provider: "anthropic",
        model: "model-test",
        baseUrl,
        apiKey: "saved-private-key",
        temperature: null,
        maxOutputTokens: null,
      })
    ).json()) as SavedProvider;
    const input = { id: saved.id, provider: "anthropic", baseUrl };
    const first = await (await dashboard.request(API.providerModels, input)).json();
    await dashboard.close();
    dashboard = await startTestDashboard({ root });
    expect(await (await dashboard.request(`${API.providerModels}?id=${saved.id}`)).json()).toEqual(
      first,
    );
    expect(calls).toHaveLength(1);
    status = 401;
    expect((await dashboard.request(API.providerModels, { ...input, refresh: true })).status).toBe(
      400,
    );
    expect(await (await dashboard.request(`${API.providerModels}?id=${saved.id}`)).json()).toEqual(
      first,
    );
    expect(await (await dashboard.request(API.providerModels, input)).json()).toEqual(first);
    expect(calls).toHaveLength(2);
    status = 200;
    data = [{ id: "new-model", display_name: "New model" }];
    const refreshed = await dashboard.request(API.providerModels, { ...input, refresh: true });
    expect(await refreshed.json()).toEqual({ models: [{ id: "new-model", name: "New model" }] });
    expect(calls).toHaveLength(3);
    expect(await (await dashboard.request(`${API.providerModels}?id=${saved.id}`)).json()).toEqual({
      models: [{ id: "new-model", name: "New model" }],
    });
    expect((await dashboard.request(API.clear, {})).status).toBe(200);
    expect(await (await dashboard.request(`${API.providerModels}?id=${saved.id}`)).json()).toEqual({
      models: [{ id: "new-model", name: "New model" }],
    });
  });

  it("keeps an empty catalog cached until an explicit refresh", async () => {
    data = [];
    const input = { provider: "openai", baseUrl, apiKey: "empty-catalog-key" };
    expect(await (await dashboard.request(API.providerModels, input)).json()).toEqual({
      models: [],
    });
    data = [{ id: "new-model", display_name: "New model" }];
    expect(await (await dashboard.request(API.providerModels, input)).json()).toEqual({
      models: [],
    });
    expect(calls).toHaveLength(1);
    expect(
      await (await dashboard.request(API.providerModels, { ...input, refresh: true })).json(),
    ).toEqual({ models: [{ id: "new-model", name: "New model" }] });
    expect(calls).toHaveLength(2);
  });

  it.each(["id", "name", '"'])(
    "preserves catalog fields when a compatible endpoint key contains %j",
    async (apiKey) => {
      const input = { provider: "openai", baseUrl, apiKey };
      const expected = { models: [{ id: "model-test", name: "Available model" }] };
      const loaded = await dashboard.request(API.providerModels, input);
      expect(loaded.status).toBe(200);
      expect(await loaded.json()).toEqual(expected);
      await dashboard.close();
      dashboard = await startTestDashboard({ root });
      const restored = await dashboard.request(API.providerModels, input);
      expect(restored.status).toBe(200);
      expect(await restored.json()).toEqual(expected);
      expect(calls).toHaveLength(1);
    },
  );

  it("persists redacted model names without changing model identifiers", async () => {
    data = [{ id: "customX9r2L8m4N6q7V3k5", display_name: "Model private-draft-key" }];
    const input = { provider: "openai", baseUrl, apiKey: "private-draft-key" };
    const expected = { models: [{ id: data[0]?.id, name: "Model <redacted>" }] };
    expect(await (await dashboard.request(API.providerModels, input)).json()).toEqual(expected);
    await dashboard.close();
    dashboard = await startTestDashboard({ root });
    expect(await (await dashboard.request(API.providerModels, input)).json()).toEqual(expected);
    expect(calls).toHaveLength(1);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(root, "data/dashboard.sqlite"));
    try {
      expect(
        db.prepare("SELECT payload FROM provider_model_catalogs").get()?.payload,
      ).not.toContain(input.apiKey);
    } finally {
      db.close();
    }
  });

  it("requires a separate catalog after changing the saved key, endpoint or provider", async () => {
    let settings = {
      name: "Scoped catalog",
      provider: "anthropic",
      model: "model-test",
      baseUrl,
      apiKey: "original-private-key",
      temperature: null,
      maxOutputTokens: null,
    };
    const saved = (await (
      await dashboard.request(API.providers, settings)
    ).json()) as SavedProvider;
    expect(
      (
        await dashboard.request(API.providerModels, {
          id: saved.id,
          provider: "anthropic",
          baseUrl,
        })
      ).status,
    ).toBe(200);
    for (const [index, patch] of [
      { apiKey: "rotated-private-key" },
      { baseUrl: `${baseUrl}/different` },
      { provider: "openai" },
    ].entries()) {
      settings = { ...settings, ...patch };
      expect((await dashboard.request(API.providers, { ...settings, id: saved.id })).status).toBe(
        200,
      );
      expect(
        await (await dashboard.request(`${API.providerModels}?id=${saved.id}`)).json(),
      ).toBeNull();
      expect(calls).toHaveLength(index + 1);
      expect(
        (
          await dashboard.request(API.providerModels, {
            id: saved.id,
            provider: settings.provider,
            baseUrl: settings.baseUrl,
          })
        ).status,
      ).toBe(200);
      expect(calls).toHaveLength(index + 2);
    }
    expect((await dashboard.request(API.deleteProvider, { id: saved.id })).status).toBe(200);
    expect((await dashboard.request(`${API.providerModels}?id=${saved.id}`)).status).toBe(404);
  });

  it("rejects unauthenticated, missing-key, unsupported-provider and injected requests before dispatch", async () => {
    const input = { provider: "anthropic", baseUrl, apiKey: "private-draft-key" };
    expect(
      (await dashboard.request(API.providerModels, input, { "X-Plenger-Token": "" })).status,
    ).toBe(403);
    expect((await dashboard.request(API.providerModels)).status).toBe(400);
    expect((await dashboard.request(`${API.providerModels}?id=missing`)).status).toBe(404);
    expect(
      (
        await dashboard.request(`${API.providerModels}?id=missing`, undefined, {
          "X-Plenger-Token": "",
        })
      ).status,
    ).toBe(403);
    expect(
      (await dashboard.request(API.providerModels, input, { Origin: "https://foreign.example" }))
        .status,
    ).toBe(403);
    for (const patch of [
      { provider: "ollama" },
      { apiKey: "" },
      { apiKey: "bad\nkey" },
      { apiKey: null },
      { baseUrl: "http://192.168.1.1/v1" },
      { headers: {} },
      { model: "injected" },
      { refresh: "true" },
    ])
      expect((await dashboard.request(API.providerModels, { ...input, ...patch })).status).toBe(
        400,
      );
    expect(calls).toHaveLength(0);
  });

  it("does not leak upstream error bodies or retry rejected credentials", async () => {
    status = 401;
    const result = await dashboard.request(API.providerModels, {
      provider: "openai",
      baseUrl,
      apiKey: "private-draft-key",
    });
    expect(result.status).toBe(400);
    const body = await result.text();
    expect(body).toContain("HTTP 401");
    expect(body).not.toContain("private-draft-key");
    expect(body).not.toContain("upstream request details");
    expect(calls).toHaveLength(1);
  });
});
