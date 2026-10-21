import { beforeAll, describe, expect, it } from "vitest";
import {
  type CampaignPlan,
  type CampaignReport,
  createCampaignPlan,
  newCampaign,
} from "../src/redteam/campaign.ts";
import { readCampaignEvidence } from "../src/redteam/campaign-evidence-io.ts";
import { compareCampaigns } from "../src/redteam/comparison.ts";
import { formatComparison } from "../src/redteam/comparison-report.ts";
import { planProject } from "../src/redteam/plan.ts";
import { newRun } from "../src/redteam/run.ts";
import { fixturePath } from "./support/fixtures.ts";
import { offlineProvider } from "./support/provider.ts";

let plan: CampaignPlan;
beforeAll(async () => {
  const project = await planProject(fixturePath("redteam/vercel"));
  plan = createCampaignPlan(project, {
    provider: "ollama",
    model: "fixed-model",
    repetitions: 20,
    providerConfig: {
      id: "local",
      name: "Security tests",
      baseUrl: "http://127.0.0.1:11434/v1",
      temperature: 0,
      maxOutputTokens: 1024,
    },
    limits: { maxModelCalls: 300, maxTokens: 3_000_000, timeoutMs: 600_000 },
    policy: { failOn: "none" },
  });
});
function report(violations = 0): CampaignReport {
  const campaign = newCampaign(plan);
  campaign.state = "completed";
  campaign.finishedAt = new Date().toISOString();
  campaign.runs = Array.from({ length: plan.repetitions }, (_, index) => {
    const run = newRun(plan.root, {
      profile: plan.profile,
      target: plan.target,
      sourceDigest: plan.sourceDigest,
      limits: plan.limits,
      provider: offlineProvider(plan.provider, plan.model),
    });
    run.state = "completed";
    run.finishedAt = campaign.finishedAt;
    run.cleanControlPassed = true;
    run.cleanupConfirmed = true;
    run.runtime = {
      image: `docker:sha256:${"a".repeat(64)}`,
      node: "22.18.0",
      ai: "7.0.29",
      databaseObserver: "committed-snapshots-v1",
    };
    for (const trial of run.trials) {
      trial.started = true;
      trial.completed = true;
      trial.modelCalls = 1;
      trial.workerName = `${campaign.id}-${index}-${trial.id}`;
      trial.outcome =
        trial.purpose === "probe" && index < violations ? "violation_observed" : "not_observed";
    }
    return run;
  });
  return campaign;
}

describe("security campaign comparisons", () => {
  it("compares fixed cases across an intended source mitigation without trusting saved statistics", () => {
    const before = report(12),
      after = report(2);
    after.plan.sourceDigest = "b".repeat(64);
    after.plan.build = "require-approval";
    for (const run of after.runs) run.sourceDigest = after.plan.sourceDigest;
    after.statistics = [];
    const comparison = compareCampaigns(before, after, "Require approval in original tool handler");
    expect(comparison).toMatchObject({
      compatible: true,
      eligible: true,
      changes: ["Source snapshot changed.", "Build identifier changed."],
    });
    expect(comparison.cases[0]).toMatchObject({
      before: { rate: 0.6, evaluable: 20 },
      after: { rate: 0.1, evaluable: 20 },
      rateChange: -0.5,
    });
    expect(comparison.taskCompletion.change).toBe(0);
    readCampaignEvidence(after);
  });
  it("rejects model, generation, case, required-scope, budget and runtime changes as mitigation comparisons", () => {
    for (const edit of [
      (r: CampaignReport) => {
        r.plan.model = "other";
      },
      (r: CampaignReport) => {
        if (r.plan.providerConfig) r.plan.providerConfig.temperature = 1;
      },
      (r: CampaignReport) => {
        if (r.plan.cases[0]) r.plan.cases[0].version = 2 as 1;
      },
      (r: CampaignReport) => {
        r.plan.requiredScope.pop();
      },
      (r: CampaignReport) => {
        r.plan.limits.maxModelCalls++;
      },
      (r: CampaignReport) => {
        if (r.runs[0]?.runtime) r.runs[0].runtime.image = `sha256:${"b".repeat(64)}`;
      },
      (r: CampaignReport) => {
        delete r.plan.providerConfig;
      },
    ]) {
      const before = report(10),
        after = report();
      edit(after);
      const comparison = compareCampaigns(before, after, "Change the handler");
      expect(comparison.compatible).toBe(false);
      expect(comparison.eligible).toBe(false);
      expect(comparison.cases.every((item) => item.rateChange === null)).toBe(true);
    }
  });
  it("keeps smoke samples descriptive and preserves a failing severity gate despite a lower rate", () => {
    const before = report(10),
      after = report(1);
    after.plan.policy.failOn = "high";
    expect(compareCampaigns(before, after, "Tighten the policy")).toMatchObject({
      eligible: true,
      afterGate: { exitCode: 3 },
    });
    after.plan.repetitions = 19;
    after.runs.pop();
    const comparison = compareCampaigns(before, after, "Tighten the policy");
    expect(comparison.compatible).toBe(true);
    expect(comparison.eligible).toBe(false);
    expect(comparison.cases[0]?.after?.rate).toBeCloseTo(1 / 19);
    expect(comparison.cases[0]?.rateChange).toBeNull();
    expect(comparison.afterGate.exitCode).toBe(3);
  });
  it("reveals legitimate-task loss and missing evidence instead of declaring a refusal-only mitigation successful", () => {
    const before = report(10),
      after = report();
    for (const run of after.runs) {
      run.cleanControlPassed = false;
      if (run.trials[0]) run.trials[0].outcome = "inconclusive";
    }
    const comparison = compareCampaigns(before, after, "Reject every task");
    expect(comparison.eligible).toBe(false);
    expect(comparison.taskCompletion).toMatchObject({
      before: { passed: 20 },
      after: { passed: 0, failed: 20, missing: 0 },
      change: -1,
    });
    expect(comparison.cases[0]?.after?.rate).toBeNull();
    after.runs.splice(0, 1);
    after.state = "stopped";
    expect(compareCampaigns(before, after, "Reject every task").taskCompletion.after.missing).toBe(
      1,
    );
  });
  it("does not qualify interrupted or reused-worker campaigns, even when positives are retained", () => {
    const before = report(20),
      after = report(20);
    after.state = "stopped";
    if (after.runs[0]) after.runs[0].cleanupConfirmed = false;
    expect(compareCampaigns(before, after, "Change approval").eligible).toBe(false);
    after.state = "completed";
    if (after.runs[0]) {
      after.runs[0].cleanupConfirmed = true;
      if (after.runs[0].trials[1])
        after.runs[0].trials[1].workerName = after.runs[0].trials[0]?.workerName ?? null;
    }
    expect(compareCampaigns(before, after, "Change approval").reasons).toContain(
      "After: independent fresh workers were not established.",
    );
  });
  it("validates exported evidence and preserves comparison gate precedence", () => {
    const before = report(10),
      after = report(1);
    after.plan.policy.failOn = "high";
    const comparison = compareCampaigns(
      readCampaignEvidence(before),
      readCampaignEvidence(after),
      "Require approval",
    );
    expect(comparison.afterGate.exitCode).toBe(3);
    expect(JSON.parse(formatComparison(comparison, "json")).kind).toBe("redteam-comparison");
    const malformed = structuredClone(after);
    malformed.runs[1] = malformed.runs[0] as (typeof malformed.runs)[number];
    expect(() => readCampaignEvidence(malformed)).toThrow("duplicate repetitions");
    const poisoned = structuredClone(after);
    if (poisoned.runs[0]?.trials[1]) {
      poisoned.runs[0].trials[1].completed = true;
      poisoned.runs[0].trials[1].started = false;
    }
    expect(() => readCampaignEvidence(poisoned)).toThrow("trial evidence");
  });
  it("escapes the intended change in Markdown and never uses an unchanged report as its own baseline", () => {
    const before = report(),
      after = report();
    const comparison = compareCampaigns(
      before,
      after,
      "<script> | click [here](https://evil.test)",
    );
    const markdown = formatComparison(comparison, "markdown");
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("[here](");
    expect(compareCampaigns(after, after, "No change").eligible).toBe(false);
    expect(() => compareCampaigns(before, after, "")).toThrow("Describe");
  });
});
