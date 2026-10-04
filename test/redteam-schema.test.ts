import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";
import { createCampaignPlan, newCampaign, summarizeScope } from "../src/redteam/campaign.ts";
import { compareCampaigns } from "../src/redteam/comparison.ts";
import { planProject } from "../src/redteam/plan.ts";
import { newRun } from "../src/redteam/run.ts";
import { REDTEAM_SCHEMAS } from "../src/redteam/schema.ts";
import { fixturePath } from "./support/fixtures.ts";
import { offlineProvider } from "./support/provider.ts";

const ajv = new Ajv({ allErrors: true, strict: true });
const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;
addFormats(ajv);
const validators = Object.fromEntries(
  Object.entries(REDTEAM_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]),
);

describe("separate versioned dynamic evidence schemas", () => {
  it("validates preparing, interrupted and completed managed evidence and unavailable comparisons", async () => {
    const project = await planProject(fixturePath("redteam/vercel"));
    const plan = createCampaignPlan(project, {
      provider: "ollama",
      model: "test-model",
      limits: { maxModelCalls: 12, maxTokens: 200_000, timeoutMs: 600_000 },
    });
    const campaign = newCampaign(plan);
    const run = newRun(plan.root, {
      provider: offlineProvider("ollama", plan.model),
      target: plan.target,
      sourceDigest: plan.sourceDigest,
      profile: plan.profile,
      limits: plan.limits,
    });
    campaign.runs.push(run);
    const after = newCampaign(plan);
    for (const [name, value] of [
      ["redteam-run-v1.schema.json", run],
      ["redteam-campaign-plan-v1.schema.json", plan],
      ["redteam-campaign-v1.schema.json", campaign],
      ["redteam-comparison-v1.schema.json", compareCampaigns(campaign, after, "Require approval")],
    ] as const) {
      const validate = validators[name];
      expect(validate?.(value), JSON.stringify(validate?.errors)).toBe(true);
    }
    run.state = "stopped";
    run.finishedAt = new Date().toISOString();
    run.cleanupConfirmed = false;
    if (run.trials[1]) {
      run.trials[1].started = true;
      run.trials[1].outcome = "violation_observed";
    }
    expect(validators["redteam-run-v1.schema.json"]?.(run)).toBe(true);
    expect(summarizeScope(campaign)).toMatchObject({
      exercised: 1,
      unsupported: 4,
      discovered: 5,
      incomplete: false,
    });
  });
  it("keeps checked-in contracts in sync and excludes credential or unknown contract fields", async () => {
    for (const [name, schema] of Object.entries(REDTEAM_SCHEMAS)) {
      expect(
        JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8")),
      ).toEqual(schema);
    }
    const project = await planProject(fixturePath("redteam/vercel"));
    const plan = createCampaignPlan(project, {
      provider: "ollama",
      model: "test-model",
      limits: { maxModelCalls: 12, maxTokens: 200_000, timeoutMs: 600_000 },
    });
    const validate = validators["redteam-campaign-plan-v1.schema.json"];
    expect(validate?.({ ...plan, apiKey: "must-never-export" })).toBe(false);
    expect(validate?.({ ...plan, schemaVersion: 2 })).toBe(false);
    expect(
      validate?.({
        ...plan,
        providerConfig: {
          id: "test",
          name: "test",
          baseUrl: "http://127.0.0.1:11434/v1",
          temperature: null,
          maxOutputTokens: 1024,
          apiKey: "must-never-export",
        },
      }),
    ).toBe(false);
  });
});
