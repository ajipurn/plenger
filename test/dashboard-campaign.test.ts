import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StartCampaignRequest } from "../src/dashboard/contract.ts";
import {
  type CampaignPolicy,
  type CampaignReport,
  createCampaignPlan,
  newCampaign,
  refreshCampaignDerived,
} from "../src/redteam/campaign.ts";
import { planProject } from "../src/redteam/plan.ts";
import { newRun } from "../src/redteam/run.ts";
import { DashboardStore, ProviderRepository } from "../src/storage/store.ts";
import { required, startTestDashboard, type TestDashboard } from "./support/dashboard.ts";
import { fixturePath } from "./support/fixtures.ts";
import { stubProvider } from "./support/provider.ts";
import { temporaryDir } from "./support/tmp.ts";

const fixture = fixturePath("redteam/llmfy");
const policy: CampaignPolicy = {
  failOn: "high",
  minCoverage: 1,
  minimumEvaluable: 2,
  suppressions: [],
};
let root: string;
let dashboard: TestDashboard;
let config: StartCampaignRequest & { providerId: string };
let launches: number;
let finish: (() => void) | undefined;

async function start() {
  dashboard = await startTestDashboard({
    root,
    workspace: fixture,
    campaignExecutor: async (report, provider, options = {}) => {
      launches++;
      report.state = "running";
      const run = newRun(report.plan.root, {
        provider,
        target: report.plan.target,
        sourceDigest: report.plan.sourceDigest,
        limits: report.plan.limits,
      });
      report.runs.push(run);
      run.state = "running";
      const control = required(run.trials[0], "control trial");
      control.started = true;
      control.completed = true;
      control.outcome = "not_observed";
      run.cleanControlPassed = true;
      const update = () => {
        refreshCampaignDerived(report);
        options.onUpdate?.(structuredClone(report));
      };
      update();
      await new Promise<void>((resolve) => {
        finish = resolve;
        options.signal?.addEventListener("abort", () => setTimeout(resolve, 10), { once: true });
      });
      report.state = options.signal?.aborted ? "stopped" : "completed";
      report.finishedAt = new Date().toISOString();
      run.state = report.state;
      run.finishedAt = report.finishedAt;
      run.cleanupConfirmed = true;
      update();
      return report;
    },
  });
}
const request: TestDashboard["request"] = (...args) => dashboard.request(...args);
const state = () => dashboard.state();

describe("dashboard repeated security tests", () => {
  beforeEach(async () => {
    launches = 0;
    finish = undefined;
    root = await temporaryDir("plenger-campaign-api-");
    const discovery = await planProject(fixture);
    const target = required(
      discovery.targets.find((item) => item.kind === "factory"),
      "factory target",
    ).id;
    const plan = await planProject(fixture, { target });
    const store = await DashboardStore.open(join(root, "data"));
    const provider = store.saveProvider({
      name: "Local tests",
      provider: "ollama",
      model: "local-test",
      baseUrl: "http://127.0.0.1:11434/v1",
      temperature: null,
      maxOutputTokens: 1024,
      isDefault: true,
      apiKey: "saved-secret",
    });
    store.close();
    config = {
      path: fixture,
      target,
      sourceDigest: plan.sourceDigest,
      providerId: provider.id,
      repetitions: 3,
      limits: { maxModelCalls: 24, maxTokens: 400000, timeoutMs: 120000 },
      policy,
    };
    await start();
  });
  afterEach(async () => {
    finish?.();
    await dashboard?.close();
  });

  it("persists campaign settings, provider snapshots and incomplete evidence across reload and restart", async () => {
    const response = await request("/api/redteam/campaign/start", config);
    expect(response.status).toBe(202);
    const report = (await response.json()) as CampaignReport;
    expect(report.plan).toMatchObject({
      repetitions: 3,
      provider: "ollama",
      model: "local-test",
      providerConfig: { name: "Local tests" },
      policy,
    });
    expect((await state()).campaigns[0]?.id).toBe(report.id);
    expect((await state()).runProfile).toMatchObject({
      providerId: config.providerId,
      repetitions: 3,
      policy,
    });
    expect(JSON.stringify(await state())).not.toContain("saved-secret");
    expect(
      ((await (await request(`/api/redteam/campaign?id=${report.id}`)).json()) as CampaignReport)
        .id,
    ).toBe(report.id);
    finish?.();
    await expect.poll(async () => (await state()).campaigns[0]?.state).toBe("completed");
    await dashboard.close();
    await start();
    const saved = required((await state()).campaigns[0], "saved campaign");
    expect(saved.runs[0]?.cleanupConfirmed).toBe(true);
    expect(saved.gate.exitCode).toBe(1);
    expect(saved.statistics[0]).toMatchObject({ planned: 3, evaluable: 0, rate: null });
    expect((await request("/api/state/clear", {})).status).toBe(200);
    expect(await state()).toMatchObject({ campaigns: [], runProfile: null });
    expect(await (await request("/api/providers")).json()).toEqual([]);
  });

  it("does not recover active dashboard work when the CLI opens the provider store", async () => {
    const report = (await (
      await request("/api/redteam/campaign/start", config)
    ).json()) as CampaignReport;
    const reader = await ProviderRepository.open(join(root, "data"));
    try {
      expect(reader.providers.readProviders().map((item) => item.name)).toEqual(["Local tests"]);
    } finally {
      reader.close();
    }
    expect((await state()).campaigns[0]?.state).toBe("running");
    for (const [path, body] of [
      ["/api/redteam/start", config],
      ["/api/redteam/campaign/start", config],
      ["/api/state/clear", {}],
      ["/api/project", { path: fixture }],
      ["/api/plan", { path: fixture }],
    ] as const) {
      expect((await request(path, body)).status).toBe(409);
    }
    expect((await request("/api/redteam/cancel", { id: report.id })).status).toBe(202);
    await expect.poll(async () => (await state()).campaigns[0]?.state).toBe("stopped");
    expect((await state()).campaigns[0]?.runs[0]?.cleanupConfirmed).toBe(true);
    expect(launches).toBe(1);
  });

  it("rejects unauthenticated and malformed settings before a worker or model can run", async () => {
    expect(
      (await request("/api/redteam/campaign/start", config, { "X-Plenger-Token": "wrong" })).status,
    ).toBe(403);
    expect(
      (
        await request("/api/redteam/campaign/start", config, {
          Origin: "https://untrusted.example",
        })
      ).status,
    ).toBe(403);
    for (const change of [
      { repetitions: 0 },
      { repetitions: null },
      { repetitions: 101 },
      { policy: null },
      { policy: false },
      { policy: { ...policy, suppressions: [{ caseId: "direct-override", reason: "" }] } },
      { policy: { ...policy, minCoverage: 0 } },
      { policy: { ...policy, surprise: true } },
      { providerId: "deleted" },
      { apiKey: "ambiguous-secret" },
      { limits: { maxModelCalls: 1201, maxTokens: 400000, timeoutMs: 120000 } },
    ]) {
      expect((await request("/api/redteam/campaign/start", { ...config, ...change })).status).toBe(
        400,
      );
    }
    expect(
      (await request("/api/redteam/campaign/start", { ...config, sourceDigest: "0".repeat(64) }))
        .status,
    ).toBe(409);
    expect(launches).toBe(0);
    expect((await state()).campaigns).toEqual([]);
  });

  it("recovers a crashed campaign without changing positive evidence into a safe result", async () => {
    await dashboard.close();
    const store = await DashboardStore.open(join(root, "data"));
    const plan = await planProject(fixture, { target: config.target });
    const report = newCampaign(
      createCampaignPlan(plan, {
        provider: "ollama",
        model: "local-test",
        repetitions: 3,
        limits: config.limits,
      }),
    );
    const run = newRun(fixture, {
      provider: stubProvider({ name: "ollama", model: "local-test" }),
      target: report.plan.target,
      sourceDigest: report.plan.sourceDigest,
      limits: report.plan.limits,
    });
    run.state = "running";
    const probe = required(run.trials[1], "probe trial");
    probe.started = true;
    probe.outcome = "violation_observed";
    report.runs.push(run);
    report.state = "running";
    store.saveCampaign(report);
    store.close();
    await start();
    const saved = required((await state()).campaigns[0], "recovered campaign");
    expect(saved.state).toBe("stopped");
    expect(saved.runs[0]?.cleanupConfirmed).toBe(false);
    expect(saved.statistics[0]?.counts.violation_observed).toBe(1);
    expect(saved.gate.exitCode).toBe(3);
  });
});
