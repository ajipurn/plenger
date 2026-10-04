import { cp, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli/index.ts";
import * as campaign from "../src/redteam/campaign.ts";
import { PROVIDER_URLS } from "../src/redteam/provider-config.ts";
import { newRun } from "../src/redteam/run.ts";
import { DashboardStore } from "../src/storage/store.ts";
import { temporaryDir } from "./support/tmp.ts";

let root: string;
let project: string;
let dataDir: string;
let dispatched = 0;
async function command(...argv: string[]) {
  const out: string[] = [],
    err: string[] = [];
  const code = await main(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    color: false,
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}
describe("dynamic red-team CLI", () => {
  beforeEach(async () => {
    root = await temporaryDir("plenger-command-");
    project = root;
    dataDir = join(root, "store");
    dispatched = 0;
    await writeFile(join(project, "requirements.txt"), "llmfy==0.11.0\n");
    await writeFile(
      join(project, "agent.py"),
      `from llmfy import LLMfy, OpenAIChatModel
agent = LLMfy(OpenAIChatModel(model="project-model"))
def chat(message: str):
    return agent.invoke(message)
`,
    );
    const store = await DashboardStore.open(dataDir);
    try {
      store.saveProvider({
        name: "Test connection",
        provider: "ollama",
        model: "test-model",
        baseUrl: PROVIDER_URLS.ollama,
        temperature: null,
        maxOutputTokens: 1024,
        apiKey: "never-export-this-test-key",
      });
    } finally {
      store.close();
    }
    vi.spyOn(campaign, "executeCampaign").mockImplementation(async (report, provider, options) => {
      dispatched++;
      const child = newRun(report.plan.root, {
        target: report.plan.target,
        sourceDigest: report.plan.sourceDigest,
        provider,
        limits: report.plan.limits,
      });
      child.state = "completed";
      child.finishedAt = new Date().toISOString();
      child.cleanControlPassed = true;
      child.cleanupConfirmed = true;
      for (const trial of child.trials) {
        trial.started = true;
        trial.completed = true;
        trial.outcome = "not_observed";
      }
      report.runs = Array.from({ length: report.plan.repetitions }, () => structuredClone(child));
      report.state = "completed";
      report.finishedAt = new Date().toISOString();
      report.statistics = campaign.summarizeCampaign(report);
      report.gate = campaign.evaluateCampaignGate(report);
      options?.onUpdate?.(structuredClone(report));
      return report;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it("uses saved model settings, writes private campaign evidence and exports a credential-free profile", async () => {
    const output = join(root, "suite.json");
    const result = await command(
      "redteam",
      "run",
      project,
      "--provider",
      "Test connection",
      "--data-dir",
      dataDir,
      "--repeat",
      "2",
      "--write-profile",
      output,
      "--format",
      "json",
    );
    expect(result.code).toBe(0);
    expect(dispatched).toBe(1);
    const report = JSON.parse(result.stdout);
    const profile = JSON.parse(await readFile(output, "utf8"));
    expect(report.plan.policy.failOn).toBe("none");
    expect(profile.kind).toBe("redteam-campaign-plan");
    expect(profile.providerConfig.maxOutputTokens).toBe(1024);
    expect(profile.repetitions).toBe(2);
    expect(result.stdout).not.toContain("never-export");
    expect(await readFile(output, "utf8")).not.toContain("never-export");
    const files = await readdir(join(project, ".plenger/runs"));
    expect(files).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(project, ".plenger/runs", files[0] as string), "utf8")).id,
    ).toBe(report.id);
    if (process.platform !== "win32") expect((await stat(output)).mode & 0o777).toBe(0o600);
    const rerun = await command(
      "redteam",
      "run",
      "--profile",
      output,
      "--data-dir",
      dataDir,
      "--format",
      "sarif",
    );
    expect(rerun.code).toBe(0);
    expect(JSON.parse(rerun.stdout).version).toBe("2.1.0");
  });
  it("can reuse a profile in CI through an explicitly named environment variable without local keys", async () => {
    const profile = join(root, "suite.json");
    await command("redteam", "run", project, "--data-dir", dataDir, "--write-profile", profile);
    vi.stubEnv("PLENGER_TEST_PROVIDER_KEY", "ci-key-do-not-export");
    const result = await command(
      "redteam",
      "run",
      "--profile",
      profile,
      "--api-key-env",
      "PLENGER_TEST_PROVIDER_KEY",
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("ci-key-do-not-export");
    expect(
      (
        await command(
          "redteam",
          "run",
          "--profile",
          profile,
          "--api-key-env",
          "PLENGER_EMPTY_TEST_KEY",
        )
      ).code,
    ).toBe(2);
  });
  it("relocates an exported Ollama profile to another checkout without a local provider store", async () => {
    const profile = join(root, "suite.json");
    await command("redteam", "run", project, "--data-dir", dataDir, "--write-profile", profile);
    const checkout = join(root, "ci-checkout");
    await mkdir(checkout);
    await cp(join(project, "agent.py"), join(checkout, "agent.py"));
    await cp(join(project, "requirements.txt"), join(checkout, "requirements.txt"));
    const original = JSON.parse(await readFile(profile, "utf8"));
    const result = await command("redteam", "run", checkout, "--profile", profile, "--json");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.plan.root).toBe(checkout);
    expect(report.plan.sourceDigest).toBe(original.sourceDigest);
    expect(report.plan.requiredScope).toEqual(original.requiredScope);
    expect(report.plan.providerConfig).toEqual(original.providerConfig);
    expect(await readdir(join(checkout, ".plenger/runs"))).toHaveLength(1);
    expect(JSON.parse(await readFile(profile, "utf8"))).toEqual(original);
  });
  it("rejects altered profiles, unknown flags, mismatched providers and impossible budgets before execution", async () => {
    for (const args of [
      ["--repeat", "0"],
      ["--calls", "0"],
      ["--timeout", "0"],
      ["--min-coverage", "0"],
      ["--fail-on", "urgent"],
      ["--refresh-source"],
      ["--arbitrary", "yes"],
    ])
      expect((await command("redteam", "run", project, "--data-dir", dataDir, ...args)).code).toBe(
        2,
      );
    expect(dispatched).toBe(0);
    const profile = join(root, "suite.json");
    await command("redteam", "run", project, "--data-dir", dataDir, "--write-profile", profile);
    const imported = JSON.parse(await readFile(profile, "utf8"));
    imported.apiKey = "untrusted-secret";
    await writeFile(profile, JSON.stringify(imported));
    expect(
      (await command("redteam", "run", "--profile", profile, "--data-dir", dataDir)).code,
    ).toBe(2);
    expect(dispatched).toBe(1);
  });
  it("requires a source refresh after changes and preserves the profile's required scope on refresh", async () => {
    const profile = join(root, "suite.json");
    await command("redteam", "run", project, "--data-dir", dataDir, "--write-profile", profile);
    const old = JSON.parse(await readFile(profile, "utf8"));
    await writeFile(
      join(project, "agent.py"),
      `${await readFile(join(project, "agent.py"), "utf8")}\n# Reviewed source change\n`,
    );
    expect(
      (await command("redteam", "run", "--profile", profile, "--data-dir", dataDir)).code,
    ).toBe(2);
    const updated = await command(
      "redteam",
      "run",
      "--profile",
      profile,
      "--refresh-source",
      "--data-dir",
      dataDir,
      "--json",
    );
    expect(updated.code).toBe(0);
    const report = JSON.parse(updated.stdout);
    expect(report.plan.sourceDigest).not.toBe(old.sourceDigest);
    expect(report.plan.requiredScope).toEqual(old.requiredScope);
  });
  it("refuses a project-supplied symlink as the default evidence directory before execution", async () => {
    const elsewhere = await temporaryDir("plenger-no-overwrite-");
    await symlink(elsewhere, join(project, ".plenger"));
    const result = await command("redteam", "run", project, "--data-dir", dataDir);
    expect(result.code).toBe(2);
    expect(dispatched).toBe(0);
    expect(await readdir(elsewhere)).toEqual([]);
  });
});
