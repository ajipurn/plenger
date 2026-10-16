import { randomBytes } from "node:crypto";
import { chmod, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DashboardState } from "../src/dashboard/contract.ts";
import { ANTHROPIC } from "../src/redteam/constants.ts";
import { planProject } from "../src/redteam/plan.ts";
import {
  PROVIDER_URLS,
  type ProviderInput,
  type SavedProvider,
} from "../src/redteam/provider-config.ts";
import type { RedteamRun } from "../src/redteam/run.ts";
import { openProviderKey, sealProviderKey } from "../src/storage/provider-secrets.ts";
import { DashboardStore } from "../src/storage/store.ts";
import { required, startTestDashboard, type TestDashboard } from "./support/dashboard.ts";
import { fixturePath } from "./support/fixtures.ts";
import { temporaryDir } from "./support/tmp.ts";

const fixture = fixturePath("redteam/llmfy");
const settings: ProviderInput = {
  name: "Qwen security tests",
  provider: "ollama",
  model: "qwen3-coder:480b-cloud",
  baseUrl: PROVIDER_URLS.ollama,
  temperature: 0.2,
  maxOutputTokens: 2048,
};
let root: string;
let dashboard: TestDashboard;
let launches: number;
let finish: (() => void) | undefined;
let receivedProvider: { name: string; model: string } | undefined;

async function start() {
  dashboard = await startTestDashboard({
    root,
    workspace: fixture,
    runExecutor: async (run, options) => {
      launches++;
      receivedProvider = { name: options.provider.name, model: options.provider.model };
      run.state = "running";
      options.onUpdate?.(structuredClone(run));
      await new Promise<void>((resolve) => {
        finish = resolve;
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      run.state = "completed";
      run.cleanupConfirmed = true;
      run.finishedAt = new Date().toISOString();
      options.onUpdate?.(structuredClone(run));
      return run;
    },
  });
}
const request: TestDashboard["request"] = (...args) => dashboard.request(...args);
async function save(input: ProviderInput = settings): Promise<SavedProvider> {
  const result = await request("/api/providers", input);
  expect(result.status).toBe(200);
  return (await result.json()) as SavedProvider;
}
async function providers(): Promise<SavedProvider[]> {
  return (await (await request("/api/providers")).json()) as SavedProvider[];
}
async function factoryTarget() {
  const discovery = await planProject(fixture);
  return required(
    discovery.targets.find((item) => item.kind === "factory"),
    "factory target",
  ).id;
}

describe("saved provider settings", () => {
  beforeEach(async () => {
    root = await temporaryDir("plenger-providers-");
    launches = 0;
    finish = undefined;
    receivedProvider = undefined;
    await start();
  });
  afterEach(async () => {
    finish?.();
    await dashboard.close();
  });

  it("persists per-model prices as provider settings, validates all rates and keeps them when clearing scan data", async () => {
    const rates = { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 };
    const input: ProviderInput = {
      ...settings,
      name: "Claude pricing",
      provider: "anthropic",
      model: "default-model",
      apiKey: "pricing-test-key",
      baseUrl: PROVIDER_URLS.anthropic,
      modelPricing: [
        {
          model: "priced-model",
          rates,
          longContext: { threshold: 100_000, rates: { ...rates, output: 20 } },
        },
      ],
    };
    const saved = await save(input);
    expect(saved.modelPricing).toEqual(input.modelPricing);
    expect(JSON.stringify(saved)).not.toContain("pricing-test-key");
    await dashboard.close();
    await start();
    expect((await providers())[0]?.modelPricing).toEqual(input.modelPricing);
    const { modelPricing: _prices, apiKey: _key, ...ordinary } = input;
    const updated = await save({ ...ordinary, id: saved.id, isDefault: false });
    expect(updated.modelPricing).toEqual(input.modelPricing);
    for (const patch of [
      { modelPricing: [{ model: "priced-model", rates: { ...rates, input: -1 } }] },
      { modelPricing: [{ model: "priced-model", rates: { input: 1, output: 2 } }] },
      {
        modelPricing: [
          { model: "priced-model", rates },
          { model: "priced-model", rates },
        ],
      },
      { modelPricing: [{ model: "priced-model", rates, longContext: { threshold: 0, rates } }] },
    ])
      expect(
        (await request("/api/providers", { ...ordinary, id: saved.id, ...patch })).status,
      ).toBe(400);
    expect((await request("/api/state/clear", {})).status).toBe(200);
    expect((await providers())[0]?.modelPricing).toEqual(input.modelPricing);
    expect((await save({ ...ordinary, id: saved.id, modelPricing: [] })).modelPricing).toEqual([]);
    expect(
      (await save({ ...input, id: saved.id, baseUrl: "https://new.example/v1" })).modelPricing,
    ).toEqual(input.modelPricing);
    expect(
      (
        await save({
          ...ordinary,
          id: saved.id,
          apiKey: "replacement-test-key",
          baseUrl: "https://another.example/v1",
        })
      ).modelPricing,
    ).toBeUndefined();
  });

  it("persists named connections and one explicit default across restarts and project changes", async () => {
    const first = await save();
    expect(first).toMatchObject({ ...settings, isDefault: true, hasApiKey: false });
    const second = await save({
      ...settings,
      name: "Qwen alternate",
      temperature: null,
      isDefault: true,
    });
    expect((await providers()).map((item) => [item.id, item.isDefault])).toEqual([
      [second.id, true],
      [first.id, false],
    ]);
    await dashboard.close();
    await start();
    expect(await providers()).toHaveLength(2);
    expect((await providers())[0]).toEqual(second);
    const conflict = await request("/api/providers", { ...settings, name: "qwen ALTERNATE" });
    expect(conflict.status).toBe(400);
    expect(await providers()).toHaveLength(2);
    expect((await request("/api/providers/delete", { id: second.id })).status).toBe(200);
    expect((await providers())[0]?.isDefault).toBe(false);
  });

  it("encrypts credentials and returns only a bounded key preview outside run exports", async () => {
    const secret = "test-provider-secret-do-not-export";
    const saved = await save({
      ...settings,
      provider: "openai",
      baseUrl: PROVIDER_URLS.openai,
      apiKey: secret,
    });
    expect(saved).toMatchObject({ hasApiKey: true, apiKeyPreview: "••••••••••••port" });
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(await providers()).toEqual([saved]);
    expect(JSON.stringify(await providers())).not.toContain(secret);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(root, "data/dashboard.sqlite"));
    try {
      const row = db
        .prepare("SELECT credential, payload FROM model_providers WHERE id = ?")
        .get(saved.id);
      expect(row?.credential).not.toContain(secret);
      expect(row?.payload).not.toContain(secret);
      expect(row?.payload).not.toContain("apiKey");
      expect(row?.payload).not.toContain(saved.apiKeyPreview);
      const key = await readFile(join(root, "data/provider-key"));
      expect(openProviderKey(key, saved.id, String(row?.credential))).toBe(secret);
    } finally {
      db.close();
    }
    if (process.platform !== "win32")
      expect((await stat(join(root, "data/provider-key"))).mode & 0o777).toBe(0o600);
    await dashboard.close();
    await start();
    expect(await providers()).toEqual([saved]);
    const store = await DashboardStore.open(join(root, "data"));
    try {
      expect(store.resolveProvider(saved.id).access.apiKey).toBe(secret);
    } finally {
      store.close();
    }
    const target = await factoryTarget();
    const selected = await planProject(fixture, { target });
    const launch = await request("/api/redteam/start", {
      path: fixture,
      target,
      sourceDigest: selected.sourceDigest,
      providerId: saved.id,
      limits: { maxModelCalls: 12, maxTokens: 200_000, timeoutMs: 120_000 },
    });
    expect(launch.status).toBe(202);
    const run = (await launch.json()) as RedteamRun;
    expect(receivedProvider).toEqual({ name: "openai", model: settings.model });
    expect(run.providerConfig).toEqual({
      id: saved.id,
      name: saved.name,
      baseUrl: saved.baseUrl,
      temperature: 0.2,
      maxOutputTokens: 2048,
    });
    const state = (await (await request("/api/state")).json()) as DashboardState;
    expect(state.runProfile?.providerId).toBe(saved.id);
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(JSON.stringify(state)).not.toContain(saved.apiKeyPreview);
    expect((await readFile(join(root, "data/dashboard.sqlite-wal"))).toString()).not.toContain(
      secret,
    );
  });

  it("fully masks short keys rather than revealing most or all of the credential", async () => {
    for (const [index, apiKey] of ["x", "ABCD", "abcdefghijk", "🔐🔑🔒🔓🔏🔐"].entries()) {
      const saved = await save({ ...settings, name: `Short key ${index}`, apiKey });
      expect(saved).toMatchObject({ hasApiKey: true, apiKeyPreview: "••••••••••••" });
    }
    expect((await providers()).map((item) => item.apiKeyPreview)).toEqual([
      "••••••••••••",
      "••••••••••••",
      "••••••••••••",
      "••••••••••••",
    ]);
  });

  it("retains a saved key on ordinary edits but requires replacement before changing its destination", async () => {
    const saved = await save({
      ...settings,
      provider: "openai",
      baseUrl: PROVIDER_URLS.openai,
      apiKey: "first-key",
    });
    const update = {
      ...settings,
      id: saved.id,
      provider: "openai" as const,
      baseUrl: PROVIDER_URLS.openai,
      model: "another-model",
    };
    expect(await save(update)).toMatchObject({
      hasApiKey: true,
      apiKeyPreview: "••••••••••••",
    });
    expect(
      (await request("/api/providers", { ...update, baseUrl: "https://different.example/v1" }))
        .status,
    ).toBe(400);
    expect((await providers())[0]?.baseUrl).toBe(PROVIDER_URLS.openai);
    const replaced = await save({
      ...update,
      baseUrl: "https://different.example/v1",
      apiKey: "replacement-key",
    });
    expect(replaced.baseUrl).toBe("https://different.example/v1");
    expect(replaced.apiKeyPreview).toBe("••••••••••••-key");
    expect((await request("/api/providers", { ...update, apiKey: "" })).status).toBe(400);
    const local = await save({ ...settings, name: "Optional key", apiKey: "optional-key" });
    expect(local.apiKeyPreview).toBe("••••••••••••-key");
    const cleared = await save({ ...settings, id: local.id, name: local.name, apiKey: "" });
    expect(cleared.hasApiKey).toBe(false);
    expect(cleared).not.toHaveProperty("apiKeyPreview");
    expect((await providers()).find((item) => item.id === local.id)).not.toHaveProperty(
      "apiKeyPreview",
    );
  });

  it.each(["ollama", "anthropic"] as const)(
    "checks the saved %s endpoint and generation settings with exactly one request",
    async (provider) => {
      const bodies: Record<string, unknown>[] = [];
      const headers: string[] = [];
      let retired = false;
      const modelServer = createServer(async (req, res) => {
        let body = "";
        for await (const part of req) body += part;
        bodies.push(JSON.parse(body));
        headers.push(String(req.headers.authorization ?? req.headers["x-api-key"] ?? ""));
        expect(req.url).toBe(provider === "anthropic" ? "/v1/messages" : "/v1/chat/completions");
        if (provider === "anthropic")
          expect(req.headers["anthropic-version"]).toBe(ANTHROPIC.version);
        res.setHeader("Content-Type", "application/json");
        if (retired) {
          res.statusCode = 410;
          res.end(JSON.stringify({ error: "sensitive-request-data-do-not-export" }));
          return;
        }
        res.end(
          JSON.stringify(
            provider === "anthropic"
              ? {
                  type: "message",
                  role: "assistant",
                  stop_reason: "end_turn",
                  content: [{ type: "text", text: "OK" }],
                  usage: { input_tokens: 5, output_tokens: 1 },
                }
              : {
                  choices: [{ finish_reason: "stop", message: { content: "OK", tool_calls: [] } }],
                  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
                },
          ),
        );
      });
      await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
      try {
        const address = modelServer.address();
        if (!address || typeof address === "string") throw new Error("Model server did not bind.");
        const saved = await save({
          ...settings,
          provider,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "local-test-key",
        });
        const result = await request("/api/providers/test", { id: saved.id });
        expect(result.status).toBe(200);
        expect(await result.json()).toMatchObject({ connected: true, model: settings.model });
        expect(bodies).toEqual([
          {
            model: settings.model,
            messages: [
              {
                role: "user",
                content:
                  provider === "anthropic"
                    ? [{ type: "text", text: "Reply with OK." }]
                    : "Reply with OK.",
              },
            ],
            stream: false,
            temperature: 0.2,
            max_tokens: 2048,
          },
        ]);
        expect(headers).toEqual([
          provider === "anthropic" ? "local-test-key" : "Bearer local-test-key",
        ]);
        expect(
          (await request("/api/providers/test", { id: saved.id, baseUrl: "https://evil.example" }))
            .status,
        ).toBe(400);
        expect(bodies).toHaveLength(1);
        retired = true;
        const unavailable = await request("/api/providers/test", { id: saved.id });
        expect(unavailable.status).toBe(400);
        const message = await unavailable.text();
        expect(message).toContain("HTTP 410");
        expect(message).not.toContain("sensitive-request-data");
        expect(bodies).toHaveLength(2);
      } finally {
        await new Promise<void>((resolve) => modelServer.close(() => resolve()));
      }
    },
  );

  it("rejects unauthenticated access, invalid settings and deleted or mixed run selections", async () => {
    expect((await request("/api/providers", undefined, { "X-Plenger-Token": "" })).status).toBe(
      403,
    );
    expect(
      (await request("/api/providers", settings, { Origin: "https://evil.example" })).status,
    ).toBe(403);
    for (const patch of [
      { baseUrl: "http://192.168.1.2/v1" },
      { baseUrl: "https://user:key@example.com/v1" },
      { baseUrl: "https://example.com/?key=secret" },
      { temperature: 3 },
      { maxOutputTokens: 0 },
      { apiKey: "key\r\nHeader: value" },
      { apiKeyPreview: "••••••••••••fake" },
      { name: "bad\u0000name" },
      { headers: {} },
    ])
      expect((await request("/api/providers", { ...settings, ...patch })).status).toBe(400);
    const saved = await save();
    const target = await factoryTarget();
    const plan = await planProject(fixture, { target });
    const config = {
      path: fixture,
      target,
      sourceDigest: plan.sourceDigest,
      providerId: saved.id,
      limits: { maxModelCalls: 12, maxTokens: 200_000, timeoutMs: 120_000 },
    };
    expect((await request("/api/redteam/start", { ...config, model: "other-model" })).status).toBe(
      400,
    );
    await request("/api/providers/delete", { id: saved.id });
    expect((await request("/api/redteam/start", config)).status).toBe(400);
    expect(launches).toBe(0);
    expect((await request("/api/providers", { ...settings, id: saved.id })).status).toBe(400);
  });

  it("keeps providers and their keys when the rest of saved data is cleared", async () => {
    const saved = await save({ ...settings, apiKey: "keep-this-key" });
    expect((await request("/api/state/clear", {})).status).toBe(200);
    expect((await providers()).map((item) => item.id)).toEqual([saved.id]);
    await dashboard.close();
    await start();
    expect(await providers()).toMatchObject([{ id: saved.id, hasApiKey: true }]);
  });

  it("fails closed on credential tampering and unsafe encryption-key permissions", async () => {
    const key = randomBytes(32);
    const sealed = sealProviderKey(key, "first", "test-secret");
    expect(() => openProviderKey(key, "second", sealed)).toThrow("could not be unlocked");
    expect(() => openProviderKey(randomBytes(32), "first", sealed)).toThrow(
      "could not be unlocked",
    );
    const saved = await save({ ...settings, apiKey: "original-test-key" });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(root, "data/dashboard.sqlite"));
    try {
      db.prepare("UPDATE model_providers SET credential = ? WHERE id = ?").run(sealed, saved.id);
    } finally {
      db.close();
    }
    expect(await providers()).toMatchObject([
      { id: saved.id, hasApiKey: true, apiKeyPreview: "••••••••••••" },
    ]);
    const store = await DashboardStore.open(join(root, "data"));
    try {
      expect(() => store.resolveProvider(saved.id)).toThrow("could not be unlocked");
    } finally {
      store.close();
    }
    const restored = await save({
      ...settings,
      id: saved.id,
      apiKey: "replacement-7xQ2",
    });
    expect(restored.apiKeyPreview).toBe("••••••••••••7xQ2");
    if (process.platform !== "win32") {
      await dashboard.close();
      await chmod(join(root, "data/provider-key"), 0o644);
      await expect(start()).rejects.toThrow("private 32-byte file");
      await chmod(join(root, "data/provider-key"), 0o600);
      await start();
    }
  });
});
