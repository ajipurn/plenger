import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";
import { ModelBudget } from "../src/redteam/budget.ts";
import {
  type CampaignPlan,
  createCampaignPlan,
  evaluateCampaignGate,
  executeCampaign,
  newCampaign,
  scopeId,
  summarizeCampaign,
  summarizeScope,
  validateCampaignPlan,
  wilson,
} from "../src/redteam/campaign.ts";
import { formatCampaign } from "../src/redteam/campaign-report.ts";
import { planProject } from "../src/redteam/plan.ts";
import { newRun, type RedteamRun } from "../src/redteam/run.ts";
import { fixturePath } from "./support/fixtures.ts";
import { stubProvider } from "./support/provider.ts";
import { temporaryDir } from "./support/tmp.ts";

const provider = stubProvider({
  name: "ollama",
  model: "test-model",
  maxOutputTokens: 10,
  generate: {
    value: { content: "done", toolCalls: [] },
    usage: { inputTokens: 5, outputTokens: 5, additionalTokens: 0 },
  },
});
async function plan(repetitions = 1) {
  const root = await temporaryDir("plenger-campaign-");
  await writeFile(join(root, "requirements.txt"), "llmfy==0.11.0\n");
  await writeFile(
    join(root, "agent.py"),
    `from pathlib import Path
from llmfy import LLMfy, OpenAIChatModel, Tool
@Tool()
def save(path: str, text: str):
    Path(path).write_text(text)
def build_agent():
    agent = LLMfy(OpenAIChatModel(model="project-model"))
    agent.register_tool([save])
    return agent
`,
  );
  const project = await planProject(root);
  return createCampaignPlan(project, {
    provider: "ollama",
    model: provider.model,
    repetitions,
    limits: { maxModelCalls: 1000, maxTokens: 100_000, timeoutMs: 10_000 },
  });
}
function run(
  plan: CampaignPlan,
  outcomes: ("violation_observed" | "not_observed" | "inconclusive")[] = [
    "not_observed",
    "not_observed",
  ],
): RedteamRun {
  const run = newRun(plan.root, {
    provider,
    target: plan.target,
    sourceDigest: plan.sourceDigest,
    limits: plan.limits,
    profile: plan.profile,
  });
  run.state = "completed";
  run.finishedAt = new Date().toISOString();
  run.cleanControlPassed = true;
  run.cleanupConfirmed = true;
  for (const [index, trial] of run.trials.entries()) {
    trial.started = true;
    trial.completed = true;
    trial.outcome = index === 0 ? "not_observed" : (outcomes[index - 1] ?? "inconclusive");
  }
  return run;
}
function completed(plan: CampaignPlan) {
  const report = newCampaign(plan);
  report.state = "completed";
  report.finishedAt = new Date().toISOString();
  report.runs = Array.from({ length: plan.repetitions }, () => run(plan));
  const budget = new ModelBudget(plan.limits);
  budget.finish();
  report.budget = budget.snapshot();
  return report;
}

describe("fixed campaign evidence and gates", () => {
  it("uses 95% Wilson intervals and leaves zero-trial rates unknown", () => {
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(10, 20)?.low).toBeCloseTo(0.299298, 5);
    expect(wilson(10, 20)?.high).toBeCloseTo(0.700702, 5);
    expect(wilson(0, 20)?.high).toBeCloseTo(0.161125, 5);
    expect(wilson(20, 20)?.low).toBeCloseTo(0.838875, 5);
    expect(wilson(0, 20)?.low).toBe(0);
    expect(() => wilson(2, 1)).toThrow();
  });
  it("excludes failed controls, interrupted negatives, errors and skipped trials from the denominator", async () => {
    const report = completed(await plan(5));
    const first = report.runs[0] as RedteamRun;
    first.cleanControlPassed = false;
    const second = report.runs[1] as RedteamRun;
    second.state = "stopped";
    if (second.trials[1]) second.trials[1].completed = false;
    const third = report.runs[2] as RedteamRun;
    third.state = "failed";
    if (third.trials[1]) third.trials[1].completed = false;
    const fourth = report.runs[3] as RedteamRun;
    if (fourth.trials[1]) fourth.trials[1].started = false;
    report.runs.pop();
    const stats = summarizeCampaign(report)[0];
    expect(stats).toMatchObject({
      planned: 5,
      evaluable: 0,
      coverage: 0,
      rate: null,
      interval: null,
      counts: { inconclusive: 2, error: 1, skipped: 2, violation_observed: 0, not_observed: 0 },
    });
    expect(evaluateCampaignGate(report).exitCode).toBe(1);
  });
  it("retains observed effects after interruption, with finding exit code taking precedence", async () => {
    const report = completed(await plan(2));
    const interrupted = report.runs[0] as RedteamRun;
    interrupted.state = "stopped";
    interrupted.cleanupConfirmed = false;
    if (interrupted.trials[1]) {
      interrupted.trials[1].completed = false;
      interrupted.trials[1].outcome = "violation_observed";
    }
    report.runs.pop();
    report.state = "stopped";
    expect(summarizeCampaign(report)[0]).toMatchObject({
      evaluable: 1,
      rate: 1,
      counts: { violation_observed: 1, skipped: 1 },
    });
    expect(evaluateCampaignGate(report)).toMatchObject({
      exitCode: 3,
      reasons: expect.arrayContaining([
        { kind: "finding", message: expect.stringContaining("direct-override") },
      ]),
    });
  });
  it("keeps severity suppressions and fail-on none independent from coverage and required scope", async () => {
    const report = completed(await plan());
    report.runs[0] = run(report.plan, ["violation_observed", "not_observed"]);
    report.plan.policy.suppressions = [
      { caseId: "direct-override", reason: "Accepted in isolated fixture" },
    ];
    expect(evaluateCampaignGate(report).exitCode).toBe(0);
    report.plan.requiredScope.push(scopeId("removed-target", "direct-override"));
    expect(evaluateCampaignGate(report).exitCode).toBe(1);
    report.plan.policy.failOn = "none";
    expect(evaluateCampaignGate(report).reasons.map((item) => item.kind)).toContain("scope");
    if (report.runs[0]?.trials[1]) report.runs[0].trials[1].outcome = "inconclusive";
    expect(evaluateCampaignGate(report).reasons.map((item) => item.kind)).toContain("coverage");
  });
  it("qualifies comparisons only after 20 evaluable trials per case", async () => {
    const report = completed(await plan(20));
    expect(summarizeCampaign(report).every((item) => item.comparisonEligible)).toBe(true);
    if (report.runs[0]?.trials[1]) report.runs[0].trials[1].outcome = "inconclusive";
    expect(summarizeCampaign(report)[0]?.comparisonEligible).toBe(false);
    expect(summarizeCampaign(report)[1]?.comparisonEligible).toBe(true);
  });
  it("retains unsupported tool, MCP, web and both retrieval scenarios without treating input success as full coverage", async () => {
    const project = await planProject(fixturePath("redteam/vercel"));
    const location = project.targets[0]?.location;
    if (!location || !project.coverage) throw new Error("Fixture discovery missing");
    project.coverage.surfaces?.push(
      { id: "surface:test-mcp", kind: "mcp", label: "Remote tools", location },
      { id: "surface:test-web", kind: "web", label: "Search result", location },
      { id: "surface:test-retrieval", kind: "retrieval", label: "Knowledge documents", location },
    );
    const config = createCampaignPlan(project, {
      provider: "ollama",
      model: provider.model,
      limits: { maxModelCalls: 12, maxTokens: 200_000, timeoutMs: 10_000 },
    });
    const report = completed(config);
    expect(
      config.scope.filter((item) => item.kind === "retrieval").map((item) => item.caseId),
    ).toEqual(["retrieval-context", "retrieval-index"]);
    expect(
      config.scope
        .filter((item) => item.kind !== "input")
        .every((item) => !item.supported && !item.selected && !!item.reason),
    ).toBe(true);
    expect(summarizeScope(report)).toMatchObject({ exercised: 1, discovered: 8, unsupported: 7 });
    const requirement = config.scope.find((item) => item.kind === "mcp");
    if (!requirement) throw new Error("Scope missing");
    config.requiredScope.push(requirement.id);
    report.plan.requiredScope.push(requirement.id);
    expect(evaluateCampaignGate(report).reasons).toEqual(
      expect.arrayContaining([{ kind: "scope", message: expect.stringContaining(requirement.id) }]),
    );
    project.coverage.surfaces =
      project.coverage.surfaces?.filter((item) => item.kind !== "mcp") ?? [];
    const fresh = createCampaignPlan(project, {
      provider: "ollama",
      model: provider.model,
      limits: config.limits,
      requiredScope: config.requiredScope,
    });
    expect(evaluateCampaignGate(completed(fresh)).exitCode).toBe(1);
    expect(summarizeCampaign(completed(fresh)).every((item) => item.coverage === 1)).toBe(true);
  });
  it("gates a confirmed backend boundary violation even when model probes refuse it", async () => {
    const project = await planProject(fixturePath("redteam/vercel"));
    const config = createCampaignPlan(project, {
      provider: "ollama",
      model: provider.model,
      limits: { maxModelCalls: 12, maxTokens: 200_000, timeoutMs: 10_000 },
    });
    const report = completed(config);
    const child = report.runs[0] as RedteamRun;
    child.backendChecks = [
      {
        tool: "update_invoice_amount",
        outcome: "violation_observed",
        arguments: { amount: 1000 },
        before: {
          bookings: [],
          payments: [],
          invoices: [{ bookingId: "test", amount: 350000, status: "unpaid" }],
        },
        after: {
          bookings: [],
          payments: [],
          invoices: [{ bookingId: "test", amount: 1000, status: "unpaid" }],
        },
      },
    ];
    expect(summarizeCampaign(report)[0]).toMatchObject({
      rate: 0,
      counts: { violation_observed: 0 },
    });
    expect(evaluateCampaignGate(report).exitCode).toBe(3);
    expect(
      JSON.parse(formatCampaign(report, "sarif")).runs[0].results[0].properties.backendObservations,
    ).toBe(1);
    report.plan.policy.suppressions = [
      { caseId: "manager-price-override", reason: "Explicitly accepted backend boundary" },
    ];
    expect(evaluateCampaignGate(report).exitCode).toBe(0);
  });
  it("rejects altered case versions, oracle metadata and embedded credential settings before dispatch", async () => {
    const valid = await plan();
    for (const edit of [
      (value: CampaignPlan) => {
        if (value.cases[0]) value.cases[0].rationale = "changed";
      },
      (value: CampaignPlan) => {
        value.policy.minimumEvaluable = 2;
      },
      (value: CampaignPlan) => {
        value.cases.push(value.cases[0] as (typeof value.cases)[number]);
      },
      (value: CampaignPlan) => {
        Object.assign(value, { apiKey: "never-persist" });
      },
      (value: CampaignPlan) => {
        Object.assign(value.limits, { arbitrary: true });
      },
    ]) {
      const invalid = structuredClone(valid);
      edit(invalid);
      expect(() => validateCampaignPlan(invalid)).toThrow();
    }
    validateCampaignPlan(valid);
  });
  it("runs the fixed number of fresh repetitions through one ledger, even after a positive", async () => {
    const config = await plan(3);
    const report = newCampaign(config);
    const seen = new Set<unknown>();
    let calls = 0;
    await executeCampaign(report, provider, {
      execute: async (child, options) => {
        seen.add(options.sharedBudget);
        calls++;
        const request = { messages: [], tools: null };
        await options.sharedBudget?.execute(provider.reservation(request, "probe"), (allowance) =>
          provider.generate(request, allowance),
        );
        Object.assign(child, run(config, ["violation_observed", "not_observed"]));
        return child;
      },
    });
    expect(calls).toBe(3);
    expect(seen.size).toBe(1);
    expect(report.budget?.callsAdmitted).toBe(3);
    expect(report.state).toBe("completed");
    expect(report.gate.exitCode).toBe(3);
    expect(new Set(report.runs.map((run) => run.id)).size).toBe(3);
  });
  it("does not reset the call cap between repetitions and records unstarted repetitions", async () => {
    const config = await plan(3);
    config.limits.maxModelCalls = 1;
    const report = newCampaign(config);
    await executeCampaign(report, provider, {
      execute: async (child, options) => {
        const request = { messages: [], tools: null };
        await options.sharedBudget?.execute(provider.reservation(request, "probe"), (allowance) =>
          provider.generate(request, allowance),
        );
        Object.assign(child, run(config));
        return child;
      },
    });
    expect(report.state).toBe("stopped");
    expect(report.budget?.callsAdmitted).toBe(1);
    expect(summarizeCampaign(report)[0]).toMatchObject({
      planned: 3,
      evaluable: 1,
      counts: { skipped: 2 },
    });
    expect(report.gate.exitCode).toBe(1);
  });
  it("never dispatches a cancelled campaign and never turns a duplicate observation into a pass", async () => {
    const config = await plan();
    const report = newCampaign(config);
    let dispatched = false;
    await executeCampaign(report, provider, {
      signal: AbortSignal.abort(),
      execute: async (run) => {
        dispatched = true;
        return run;
      },
    });
    expect(dispatched).toBe(false);
    expect(report.state).toBe("stopped");
    const malformed = completed(config);
    const child = malformed.runs[0] as RedteamRun;
    child.trials.push(child.trials[1] as (typeof child.trials)[number]);
    expect(summarizeCampaign(malformed)[0]).toMatchObject({ evaluable: 0, counts: { error: 1 } });
  });
  it("exports observed results and incomplete scope in terminal, JSON, Markdown and SARIF", async () => {
    const report = completed(await plan());
    report.runs[0] = run(report.plan, ["violation_observed", "inconclusive"]);
    report.plan.policy.suppressions = [
      { caseId: "direct-override", reason: "<img src=https://evil.example>" },
    ];
    const json = JSON.parse(formatCampaign(report, "json"));
    expect(json.kind).toBe("redteam-campaign");
    expect(json.statistics[1].rate).toBeNull();
    expect(formatCampaign(report, "terminal")).toContain("unknown");
    const markdown = formatCampaign(report, "markdown");
    expect(markdown).toContain("95% Wilson");
    expect(markdown).toContain("\\<img");
    const sarif = JSON.parse(formatCampaign(report, "sarif"));
    const ajv = new Ajv({ allErrors: true, strict: false, unicodeRegExp: false });
    const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");
    addFormats(ajv);
    const validate = ajv.compile(
      JSON.parse(
        await readFile(
          new URL("fixtures/reports/sarif-2.1.0.schema.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    expect(validate(sarif), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(JSON.parse(formatCampaign(newCampaign(report.plan), "sarif")))).toBe(true);
    expect(sarif.runs[0].invocations[0].executionSuccessful).toBe(false);
    expect(sarif.runs[0].results[0].suppressions[0].justification).toContain("<img");
    expect(sarif.runs[0].results[0].ruleId).toBe("direct-override");
    expect(await readFile(join(report.plan.root, "requirements.txt"), "utf8")).toBe(
      "llmfy==0.11.0\n",
    );
  });
});
