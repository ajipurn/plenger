import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StartRunRequest } from "../src/dashboard/contract.ts";
import { planProject } from "../src/redteam/plan.ts";
import { newRun, type RedteamRun } from "../src/redteam/run.ts";
import { DashboardStore } from "../src/storage/store.ts";
import { required, startTestDashboard, type TestDashboard } from "./support/dashboard.ts";
import { fixturePath } from "./support/fixtures.ts";
import { offlineProvider } from "./support/provider.ts";
import { temporaryDir } from "./support/tmp.ts";

const fixture = fixturePath("redteam/llmfy");
let root: string;
let dashboard: TestDashboard;
let config: StartRunRequest;
let launches: number;
let finish: (() => void) | undefined;

async function start() {
  dashboard = await startTestDashboard({
    root,
    workspace: fixture,
    runExecutor: async (run, options) => {
      launches += 1;
      run.state = "running";
      options.onUpdate?.(structuredClone(run));
      await new Promise<void>((resolve) => {
        finish = resolve;
        options.signal?.addEventListener("abort", () => setTimeout(resolve, 10), { once: true });
      });
      run.state = options.signal?.aborted ? "stopped" : "completed";
      run.finishedAt = new Date().toISOString();
      run.cleanupConfirmed = true;
      options.onUpdate?.(structuredClone(run));
      return run;
    },
  });
}
const request: TestDashboard["request"] = (...args) => dashboard.request(...args);
const state = () => dashboard.state();

describe("dashboard managed runs", () => {
  beforeEach(async () => {
    launches = 0;
    finish = undefined;
    root = await temporaryDir("plenger-run-api-");
    const discovery = await planProject(fixture);
    const target = required(
      discovery.targets.find((item) => item.kind === "factory"),
      "factory target",
    ).id;
    const plan = await planProject(fixture, { target });
    config = {
      path: fixture,
      target,
      sourceDigest: plan.sourceDigest,
      provider: "openai",
      model: "test-model",
      apiKey: "test-key-do-not-persist",
      limits: { maxModelCalls: 12, maxTokens: 200_000, timeoutMs: 120_000 },
    };
    await start();
  });
  afterEach(async () => {
    finish?.();
    await dashboard?.close();
  });

  it("persists non-secret run settings and evidence across refreshes and restarts", async () => {
    const source = await readFile(join(fixture, "agent.py"));
    const response = await request("/api/redteam/start", config);
    expect(response.status).toBe(202);
    const run = (await response.json()) as RedteamRun;
    expect(run.state).toBe("running");
    expect((await state()).runs[0]?.id).toBe(run.id);
    expect((await state()).runProfile).toEqual({
      target: config.target,
      provider: "openai",
      model: "test-model",
      limits: config.limits,
    });
    const stored = await readFile(join(root, "data/dashboard.sqlite-wal"));
    expect(stored.toString()).not.toContain("test-key-do-not-persist");
    expect(JSON.stringify(await state())).not.toContain("test-key-do-not-persist");
    finish?.();
    await expect.poll(async () => (await state()).runs[0]?.state).toBe("completed");
    await dashboard.close();
    await start();
    expect((await state()).runs[0]).toMatchObject({
      id: run.id,
      state: "completed",
      cleanupConfirmed: true,
    });
    expect((await state()).runProfile?.model).toBe("test-model");
    expect(await readFile(join(fixture, "agent.py"))).toEqual(source);
    expect((await request("/api/state/clear", {})).status).toBe(200);
    expect(await state()).toMatchObject({ runs: [], runProfile: null });
  });

  it("selects the managed Next.js profile and saves Gemini settings without its key", async () => {
    const next = fixturePath("redteam/vercel");
    const plan = await planProject(next);
    expect((await request("/api/plan", { path: next })).status).toBe(200);
    const response = await request("/api/redteam/start", {
      ...config,
      path: next,
      target: plan.selectedTarget,
      sourceDigest: plan.sourceDigest,
      provider: "gemini",
      apiKey: "gemini-key-do-not-persist",
      limits: { maxModelCalls: 12, maxTokens: 1000000, timeoutMs: 600000 },
    });
    expect(response.status).toBe(202);
    const run = (await response.json()) as RedteamRun;
    expect(run.profile).toBe("vercel-booking-sqlite-v1");
    expect(run.evidenceScope).toBe("isolated-route-sqlite");
    expect(run.trials.map((trial) => trial.id)).toEqual([
      "clean-control",
      "manager-price-override",
      "zero-payment",
    ]);
    expect((await state()).runProfile?.provider).toBe("gemini");
    expect((await readFile(join(root, "data/dashboard.sqlite-wal"))).toString()).not.toContain(
      "gemini-key-do-not-persist",
    );
  });

  it("protects active runs and persists cancellation after cleanup", async () => {
    const run = (await (await request("/api/redteam/start", config)).json()) as RedteamRun;
    for (const [path, body] of [
      ["/api/redteam/start", config],
      ["/api/state/clear", {}],
      ["/api/project", { path: fixture }],
      ["/api/scan", { path: fixture }],
      ["/api/plan", { path: fixture }],
      ["/api/history/open", { id: "saved" }],
    ] as const)
      expect((await request(path, body)).status).toBe(409);
    expect((await request("/api/redteam/cancel", { id: "other" })).status).toBe(409);
    expect((await request("/api/redteam/cancel", { id: run.id })).status).toBe(202);
    await dashboard.close();
    await start();
    expect((await state()).runs[0]).toMatchObject({
      id: run.id,
      state: "stopped",
      cleanupConfirmed: true,
    });
    expect(launches).toBe(1);
  });

  it("validates model access, budgets and a fresh source digest before launching", async () => {
    for (const patch of [
      { sourceDigest: "bad" },
      { target: "not-a-target" },
      { provider: "arbitrary" },
      { model: "https://evil.example" },
      { apiKey: "" },
      { extra: true },
      { limits: [] },
      { limits: "limits" },
      { limits: { maxModelCalls: 0, maxTokens: 1000, timeoutMs: 1000 } },
      { limits: { maxModelCalls: 1, maxTokens: 1000, timeoutMs: 600001 } },
      { limits: { maxModelCalls: 1, maxTokens: 1000, timeoutMs: 1000, extra: true } },
    ])
      expect((await request("/api/redteam/start", { ...config, ...patch })).status).toBe(400);
    expect(
      (await request("/api/redteam/start", { ...config, sourceDigest: "0".repeat(64) })).status,
    ).toBe(409);
    expect(launches).toBe(0);
    expect((await state()).runs).toEqual([]);
  });

  it("authenticates start, progress and cancellation using the dashboard boundary", async () => {
    expect(
      (await request("/api/redteam/start", config, { Origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await request("/api/redteam/start", config, { "X-Plenger-Token": "" })).status).toBe(
      403,
    );
    expect((await request("/api/redteam/start")).status).toBe(405);
    expect((await request("/api/redteam/run?id=unknown")).status).toBe(404);
    expect((await request("/api/redteam/run")).status).toBe(400);
    expect(
      (await request("/api/redteam/run?id=unknown", undefined, { "X-Plenger-Token": "" })).status,
    ).toBe(403);
    expect(
      (await request("/api/redteam/cancel", { id: "other" }, { "X-Plenger-Token": "" })).status,
    ).toBe(403);
    expect(launches).toBe(0);
  });

  it("waits for run cancellation and cleanup before closing its database", async () => {
    const run = (await (await request("/api/redteam/start", config)).json()) as RedteamRun;
    await dashboard.close();
    await start();
    expect((await state()).runs[0]).toMatchObject({
      id: run.id,
      state: "stopped",
      cleanupConfirmed: true,
    });
  });

  it("recovers unfinished run evidence after a service crash without claiming cleanup", async () => {
    await dashboard.close();
    const store = await DashboardStore.open(join(root, "data"));
    const run = newRun(fixture, {
      target: config.target,
      sourceDigest: config.sourceDigest,
      limits: config.limits,
      provider: offlineProvider("synthetic", "test"),
    });
    run.state = "running";
    const trial = required(run.trials[0], "initial control");
    trial.started = true;
    trial.outcome = "violation_observed";
    store.saveRun(run);
    store.close();
    await start();
    expect((await state()).runs[0]).toMatchObject({
      id: run.id,
      state: "stopped",
      cleanupConfirmed: false,
      trials: [{ started: true, outcome: "violation_observed" }, {}, {}, {}, {}],
    });
    expect((await state()).runs[0]?.error).toContain("restarted");
  });
});
