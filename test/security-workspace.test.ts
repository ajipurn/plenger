import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidationCandidate } from "../src/assessment/review-model.ts";
import {
  API,
  batchCostBound,
  batchTokenBound,
  type LocalRepository,
  type RepositorySource,
  remainingBudget,
  reviewBudget,
  SCAN_BUDGET_LIMITS,
  type ScanSourceFiles,
  type SecurityEvent,
  type SecurityScan,
  type SecurityWorkspace,
  TOKEN_HEADER,
} from "../src/dashboard/contract.ts";
import { ModelWindowCatalog } from "../src/dashboard/model-windows.ts";
import { OperationSupervisor } from "../src/dashboard/operations.ts";
import { SecurityCoordinator } from "../src/dashboard/security-coordinator.ts";
import { PROVIDER_URLS, type SavedProvider } from "../src/redteam/provider-config.ts";
import { SERVICE_STOPPED_PAUSE } from "../src/security/model.ts";
import { DashboardStore } from "../src/storage/store.ts";
import { startTestDashboard, type TestDashboard } from "./support/dashboard.ts";
import {
  nativeReviewReply,
  reviewDecision,
  reviewDiscovery,
  writeReviewProject,
} from "./support/security-review.ts";
import { temporaryDir } from "./support/tmp.ts";

const execute = promisify(execFile);
/** Full coverage under the default token limit. */
const FULL = {
  depth: "full",
  budget: { kind: "tokens", tokens: SCAN_BUDGET_LIMITS.defaultTokens },
} as const;
const pathFor = (path: string, id: string) => path.replace(":id", encodeURIComponent(id));
const key = "owned-workspace-provider-key";
let dashboard: TestDashboard;
let model: Server;
let root: string;
let project: string;
let provider: SavedProvider;
let bodies: Record<string, unknown>[];
let mode: "normal" | "refusal" | "error" | "long-stride" | "validation-error";
let discoveryReply: ReturnType<typeof reviewDiscovery> | undefined;
let validationReply: ((candidates: ValidationCandidate[]) => unknown) | undefined;
let billingUsage: Record<string, unknown> | undefined;
let hold: (() => Promise<void>) | undefined;
let release: (() => void) | undefined;

beforeEach(async () => {
  root = await temporaryDir("plenger-security-workspace-");
  project = await writeReviewProject(join(root, "project"));
  bodies = [];
  mode = "normal";
  discoveryReply = undefined;
  validationReply = undefined;
  billingUsage = undefined;
  hold = undefined;
  release = undefined;
  model = createServer(async (request, response) => {
    if (request.headers["x-api-key"] !== key) {
      response.writeHead(401);
      response.end("Missing saved provider credential.");
      return;
    }
    let encoded = "";
    for await (const part of request) encoded += part;
    const body = JSON.parse(encoded);
    bodies.push(body);
    await hold?.();
    if (
      mode === "error" ||
      (mode === "validation-error" && JSON.parse(body.messages[0].content[0].text).candidates)
    ) {
      response.writeHead(429);
      response.end(`Private error ${key}`);
      return;
    }
    const data = JSON.parse(body.messages[0].content[0].text);
    let content: unknown =
      mode === "refusal"
        ? `Declined ${key}`
        : data.candidates
          ? reviewDecision(data.candidates.map((item: { id: string }) => item.id))
          : (discoveryReply ?? reviewDiscovery());
    if (
      !data.candidates &&
      !data.files?.some((item: { path: string }) => item.path === "server.ts")
    ) {
      const empty = reviewDiscovery();
      empty.findings = [];
      empty.stride = empty.stride.map((entry) => ({
        ...entry,
        status: "insufficient-context",
        evidence: [],
      }));
      content = empty;
    }
    if (data.candidates && validationReply) content = validationReply(data.candidates);
    if (data.finding)
      content = {
        status: "generated",
        prompt:
          "Inspect the tenant boundary and apply a focused fix after confirming the source evidence.",
      };
    if (mode === "long-stride" && !data.candidates && !data.finding) {
      const discovery = reviewDiscovery();
      const citation = discovery.findings[0]?.evidence[0];
      const entry = discovery.stride[1];
      if (!citation || !entry) throw new Error("Missing citation fixture.");
      entry.evidence = [{ ...citation }, { ...citation, endLine: 35 }];
      content = discovery;
    }
    // An exploring review answers through its submit tool.
    const submit = (body.tools as { name: string }[] | undefined)?.find((tool) =>
      tool.name.startsWith("submit_"),
    );
    if (submit && mode === "normal") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          type: "message",
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: `toolu_${bodies.length}`, name: submit.name, input: content },
          ],
          usage: { input_tokens: 500, output_tokens: 500 },
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ...(nativeReviewReply(content, mode === "refusal" ? "refusal" : "end_turn") as object),
        ...(billingUsage ? { usage: billingUsage } : {}),
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    model.once("error", reject);
    model.listen(0, "127.0.0.1", resolve);
  });
  const address = model.address();
  if (!address || typeof address === "string") throw new Error("No model server.");
  dashboard = await startTestDashboard({ root, workspace: project });
  provider = (await (
    await dashboard.request(API.providers, {
      name: "Claude workspace",
      provider: "anthropic",
      model: "claude-test",
      apiKey: key,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      maxOutputTokens: 8192,
      temperature: null,
    })
  ).json()) as SavedProvider;
});
afterEach(async () => {
  release?.();
  await dashboard.close();
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
});
async function workspace(): Promise<SecurityWorkspace> {
  return (await (await dashboard.request(API.securityWorkspace)).json()) as SecurityWorkspace;
}
async function repository(): Promise<LocalRepository> {
  const response = await dashboard.request(API.repositories, {
    path: project,
    name: "Invoice service",
    environment: "Staging",
    notes: "Multi-tenant invoices. Review cross-tenant access.",
  });
  expect(response.status).toBe(200);
  return (await response.json()) as LocalRepository;
}
async function start(id: string, patch = {}): Promise<SecurityScan> {
  const response = await dashboard.request(API.securityScans, {
    repositoryId: id,
    providerId: provider.id,
    depth: "quick",
    ...patch,
  });
  expect(response.status, await response.clone().text()).toBe(202);
  return (await response.json()) as SecurityScan;
}
async function finished(id: string, timeout = 1000): Promise<SecurityScan> {
  let result: SecurityScan | undefined;
  await vi.waitFor(
    async () => {
      result = (await (
        await dashboard.request(pathFor(API.securityScan, id))
      ).json()) as SecurityScan;
      expect(result.status).not.toBe("running");
    },
    { timeout },
  );
  if (!result) throw new Error("No scan.");
  return result;
}

describe("project threat model", () => {
  /** The discovery messages the model server received, in order. */
  const discoveries = () =>
    bodies
      .map((body) =>
        JSON.parse(
          (body.messages as { content: { text: string }[] }[])[0]?.content[0]?.text ?? "{}",
        ),
      )
      .filter((data) => data.files && !data.candidates);
  const saved = async (id: string) =>
    (await workspace()).repositories.find((item) => item.id === id)?.threatModel;

  it("derives a model from a scan, sends it to later reviews and keeps one the user wrote", async () => {
    const repo = await repository();
    const expected = reviewDiscovery();
    const first = await finished((await start(repo.id)).id);
    expect(first.status).toBe("completed");
    expect(first.threatModel).toBeUndefined();
    expect(discoveries()[0]?.projectModel).toBeUndefined();
    expect(await saved(repo.id)).toMatchObject({
      version: 1,
      origin: "review",
      scanId: first.id,
      architecture: expected.architecture,
      assets: expected.assets,
      trustBoundaries: expected.trustBoundaries,
    });

    bodies.length = 0;
    const second = await finished((await start(repo.id)).id);
    expect(second.threatModel).toEqual({ version: 1, origin: "review" });
    expect(discoveries()[0]?.projectModel).toEqual({
      origin: "review",
      architecture: expected.architecture,
      assets: expected.assets,
      trustBoundaries: expected.trustBoundaries,
    });
    expect((await saved(repo.id))?.version).toBe(2);

    const written = {
      architecture: "An invoice API behind a gateway.",
      assets: ["Invoices"],
      trustBoundaries: ["Gateway to API"],
    };
    const update = await dashboard.request(pathFor(API.updateRepository, repo.id), {
      threatModel: written,
    });
    expect(update.status, await update.clone().text()).toBe(200);
    expect(((await update.json()) as LocalRepository).threatModel).toMatchObject({
      ...written,
      version: 3,
      origin: "user",
      scanId: null,
    });
    bodies.length = 0;
    const third = await finished((await start(repo.id)).id);
    expect(third.threatModel).toEqual({ version: 3, origin: "user" });
    expect(discoveries()[0]?.projectModel).toEqual({ origin: "user", ...written });
    // Reviews keep a model the user wrote.
    expect(await saved(repo.id)).toMatchObject({ ...written, version: 3, origin: "user" });

    for (const threatModel of [
      { ...written, assets: Array.from({ length: 13 }, (_, index) => `Asset ${index}`) },
      { ...written, assets: [""] },
      { ...written, notes: "extra" },
      "An invoice API.",
    ])
      expect(
        (await dashboard.request(pathFor(API.updateRepository, repo.id), { threatModel })).status,
      ).toBe(400);
    const reset = await dashboard.request(pathFor(API.updateRepository, repo.id), {
      threatModel: null,
    });
    expect(((await reset.json()) as LocalRepository).threatModel).toBeUndefined();
  });
});

describe("local project security workspace", () => {
  it("uses a per-scan model and snapshots cache-aware USD prices without changing the provider default", async () => {
    const rates = { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 };
    const chosenModel = "synthetic-override-model";
    const input = {
      id: provider.id,
      name: provider.name,
      provider: provider.provider,
      model: provider.model,
      baseUrl: provider.baseUrl,
      temperature: provider.temperature,
      maxOutputTokens: provider.maxOutputTokens,
    };
    const saved = await dashboard.request(API.providers, {
      ...input,
      modelPricing: [{ model: chosenModel, rates }],
    });
    expect(saved.status).toBe(200);
    billingUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
    };
    const repo = await repository();
    let validating = false;
    const validationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hold = async () => {
      if (bodies.length === 2) {
        validating = true;
        await validationGate;
      }
    };
    const job = await start(repo.id, { model: chosenModel });
    try {
      await vi.waitFor(() => expect(validating).toBe(true));
      const pending = (await (
        await dashboard.request(pathFor(API.securityScan, job.id))
      ).json()) as SecurityScan;
      expect(pending.status).toBe("running");
      expect(pending.tokens).toBe(650);
      expect(pending.cost?.totalUsd).toBeCloseTo(0.00162, 12);
      expect(pending.reviews).toHaveLength(0);
    } finally {
      release?.();
      hold = undefined;
    }
    const result = await finished(job.id);
    expect(result.status).toBe("completed");
    expect(result.provider?.model).toBe(chosenModel);
    expect(bodies.map((body) => body.model)).toEqual([chosenModel, chosenModel]);
    expect(result.tokens).toBe(1300);
    expect(result.cost).toMatchObject({ currency: "USD", complete: true });
    expect(result.cost?.totalUsd).toBeCloseTo(0.00324, 12);
    expect(result.reviews[0]?.request.billing).toMatchObject({
      pricing: { model: chosenModel, rates },
      usage: [{ inputTokens: 100, cacheWrite1hTokens: 100 }, { inputTokens: 100 }],
    });
    const savedProviders = (await (
      await dashboard.request(API.providers)
    ).json()) as SavedProvider[];
    expect(savedProviders[0]?.model).toBe(provider.model);
    await dashboard.request(API.providers, {
      ...input,
      modelPricing: [{ model: chosenModel, rates: { ...rates, output: 100 } }],
    });
    await dashboard.close();
    dashboard = await startTestDashboard({ root, workspace: project });
    const restored = (await (
      await dashboard.request(pathFor(API.securityScan, result.id))
    ).json()) as SecurityScan;
    expect(restored.cost).toEqual(result.cost);
    expect(restored.reviews[0]?.request.billing?.pricing?.rates.output).toBe(10);
    expect((await workspace()).scans[0]?.cost).toEqual(result.cost);
    for (const model of ["", "https://invalid.example", 12, "model\nsecret"])
      expect(
        (
          await dashboard.request(API.securityScans, {
            repositoryId: repo.id,
            providerId: provider.id,
            depth: "quick",
            model,
          })
        ).status,
      ).toBe(400);
    expect(bodies).toHaveLength(2);
  });

  it("clears every project's scans, findings and reviews across restarts while keeping usable provider credentials", async () => {
    const source = await readFile(join(project, "server.ts"), "utf8");
    const repo = await repository();
    const first = await finished((await start(repo.id)).id);
    const otherProject = await writeReviewProject(join(root, "other-project"));
    const otherRepo = (await (
      await dashboard.request(API.repositories, { path: otherProject, name: "Other project" })
    ).json()) as LocalRepository;
    await finished((await start(otherRepo.id)).id);
    expect(await workspace()).toMatchObject({
      repositories: [{ id: repo.id }, { id: otherRepo.id }],
      findings: expect.any(Array),
    });
    expect((await workspace()).findings).toHaveLength(2);
    expect((await workspace()).scans).toHaveLength(2);
    expect(
      await (await dashboard.request(`${API.securityReviews}?scanId=${first.sourceScanId}`)).json(),
    ).toHaveLength(1);

    const response = await dashboard.request(API.clear, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      report: null,
      plan: null,
      history: [],
      runs: [],
      campaigns: [],
      runProfile: null,
    });
    const empty = { repositories: [], scans: [], findings: [] };
    expect(await workspace()).toEqual(empty);
    expect((await dashboard.request(pathFor(API.securityScan, first.id))).status).toBe(404);
    expect(
      (await dashboard.request(`${API.securityReviews}?scanId=${first.sourceScanId}`)).status,
    ).toBe(404);
    expect(await (await dashboard.request(API.providers)).json()).toEqual([provider]);

    await dashboard.close();
    dashboard = await startTestDashboard({ root, workspace: project });
    expect(await workspace()).toEqual(empty);
    expect((await dashboard.state()).history).toEqual([]);
    expect(await (await dashboard.request(API.providers)).json()).toEqual([provider]);
    expect(await readFile(join(project, "server.ts"), "utf8")).toBe(source);
    const freshRepo = await repository();
    const fresh = await finished((await start(freshRepo.id)).id);
    expect(fresh).toMatchObject({ status: "completed", findingCount: 1, modelCalls: 2 });
    expect(bodies).toHaveLength(6);
  });

  it("deletes one project with its scans, findings and reviews across restarts and keeps the other projects", async () => {
    const source = await readFile(join(project, "server.ts"), "utf8");
    const repo = await repository();
    const first = await finished((await start(repo.id)).id);
    const otherProject = await writeReviewProject(join(root, "other-project"));
    const otherRepo = (await (
      await dashboard.request(API.repositories, { path: otherProject, name: "Other project" })
    ).json()) as LocalRepository;
    const other = await finished((await start(otherRepo.id)).id);
    expect((await workspace()).findings).toHaveLength(2);

    expect(
      (await dashboard.request(pathFor(API.deleteRepository, repo.id), { force: true })).status,
    ).toBe(400);
    const response = await dashboard.request(pathFor(API.deleteRepository, repo.id), {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(await workspace()).toMatchObject({
      repositories: [{ id: otherRepo.id }],
      scans: [{ id: other.id }],
      findings: [{ repositoryId: otherRepo.id }],
    });
    expect((await dashboard.request(pathFor(API.securityScan, first.id))).status).toBe(404);
    expect(
      (await dashboard.request(`${API.securityReviews}?scanId=${first.sourceScanId}`)).status,
    ).toBe(404);
    expect(
      await (await dashboard.request(`${API.securityReviews}?scanId=${other.sourceScanId}`)).json(),
    ).toHaveLength(1);
    expect((await dashboard.request(pathFor(API.deleteRepository, repo.id), {})).status).toBe(404);
    expect(await (await dashboard.request(API.providers)).json()).toEqual([provider]);
    expect(await readFile(join(project, "server.ts"), "utf8")).toBe(source);

    await dashboard.close();
    dashboard = await startTestDashboard({ root, workspace: project });
    expect((await workspace()).repositories).toEqual([
      expect.objectContaining({ id: otherRepo.id }),
    ]);
    const again = await repository();
    expect(again.id).not.toBe(repo.id);
    expect((await finished((await start(again.id)).id)).status).toBe("completed");
  });

  it("completes a dashboard scan when STRIDE evidence spans more than 13 submitted source lines", async () => {
    await appendFile(join(project, "server.ts"), `\n${"// submitted context\n".repeat(40)}`);
    mode = "long-stride";
    const repo = await repository();
    const result = await finished((await start(repo.id)).id);
    expect(result).toMatchObject({
      status: "completed",
      error: null,
      modelCalls: 2,
      findingCount: 1,
    });
    expect(result.reviews[0]?.stride[1]?.evidence[1]).toMatchObject({
      path: "server.ts",
      endLine: 35,
    });
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("registers a local folder without Git, runs source analysis in the background, and preserves finding triage and credentials across rescans and restarts", async () => {
    const repo = await repository();
    expect(bodies).toHaveLength(0);
    const first = await start(repo.id);
    expect(first.status).toBe("running");
    const scan = await finished(first.id);
    expect(scan).toMatchObject({
      status: "completed",
      scope: "local",
      initiatedBy: "Local user",
      findingCount: 1,
      modelCalls: 2,
      environment: { name: "Staging" },
    });
    expect(scan.reviews[0]?.stride).toHaveLength(6);
    expect(scan.findings[0]?.evidence[1]?.path).toBe("store.ts");
    expect(JSON.stringify(bodies)).toContain("Multi-tenant invoices");
    expect(JSON.stringify(bodies)).not.toContain(key);
    const finding = scan.findings[0];
    if (!finding) throw new Error("Missing finding.");
    const triage = await dashboard.request(pathFor(API.findingStatus, finding.id), {
      status: "triaged",
    });
    expect(triage.status).toBe(200);
    const second = await finished((await start(repo.id, { scope: "repository" })).id);
    expect(second.findings[0]).toMatchObject({
      id: finding.id,
      status: "triaged",
      detectedAt: finding.detectedAt,
    });
    await dashboard.close();
    dashboard = await startTestDashboard({ root, workspace: project });
    const restored = await workspace();
    expect(restored.findings).toHaveLength(1);
    expect(restored.findings[0]?.status).toBe("triaged");
    expect(restored.scans).toHaveLength(2);
    expect(await (await dashboard.request(API.providers)).json()).toMatchObject([
      { id: provider.id, hasApiKey: true },
    ]);
    const prompt = await dashboard.request(API.generateFixPrompt, {
      scanId: finding.sourceScanId,
      reviewId: finding.reviewId,
      fingerprint: finding.sourceFindingId,
      providerId: provider.id,
    });
    expect(prompt.status).toBe(200);
    expect(JSON.stringify(await prompt.json())).not.toContain(key);
  });

  it("authenticates all writes and rejects injected access, execution, unknown records and invalid triage", async () => {
    expect(
      (await dashboard.request(API.repositories, { path: project }, { [TOKEN_HEADER]: "" })).status,
    ).toBe(403);
    expect(
      (
        await dashboard.request(
          API.repositories,
          { path: project },
          { Origin: "https://untrusted.example" },
        )
      ).status,
    ).toBe(403);
    const repo = await repository();
    expect(
      (await dashboard.request(pathFor(API.deleteRepository, repo.id), {}, { [TOKEN_HEADER]: "" }))
        .status,
    ).toBe(403);
    expect((await workspace()).repositories).toEqual([repo]);
    for (const patch of [
      { repositoryId: "missing" },
      { providerId: "missing" },
      { scope: "shell" },
      { depth: "unlimited" },
      { depth: "deep" },
      { depth: "full", budget: { kind: "tokens", tokens: 5 } },
      { depth: "full", budget: { kind: "tokens", tokens: 1.5e6 + 0.5 } },
      { depth: "full", budget: { kind: "usd", usd: 0.001 } },
      { depth: "full", budget: { kind: "usd", usd: 5 } },
      { depth: "full", budget: { kind: "tokens", tokens: 2e6, usd: 5 } },
      { depth: "full", budget: "2000000" },
      { changesSince: "main" },
      { apiKey: "untrusted" },
      { path: "/" },
    ]) {
      const response = await dashboard.request(API.securityScans, {
        repositoryId: repo.id,
        providerId: provider.id,
        scope: "repository",
        depth: "quick",
        ...patch,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    const continuous = await dashboard.request(API.securityScans, {
      repositoryId: repo.id,
      providerId: provider.id,
      scope: "continuous",
      depth: "quick",
    });
    expect(continuous.status).toBe(400);
    expect(await continuous.text()).toContain("Only manual scans of local folders");
    expect(
      (await dashboard.request(pathFor(API.findingStatus, "missing"), { status: "confirmed" }))
        .status,
    ).toBe(400);
    expect(
      (await dashboard.request(pathFor(API.findingStatus, "missing"), { status: "triaged" }))
        .status,
    ).toBe(404);
    expect(bodies).toHaveLength(0);
  });

  it("keeps a job running after its start response, serializes project operations, and supports explicit cancellation", async () => {
    const repo = await repository();
    let enter: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    hold = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        enter?.();
      });
    const job = await start(repo.id);
    await entered;
    expect((await workspace()).scans[0]).toMatchObject({
      status: "running",
      tokens: null,
      cost: null,
      modelCalls: 1,
    });
    expect(
      (
        await dashboard.request(API.securityScans, {
          repositoryId: repo.id,
          providerId: provider.id,
          scope: "repository",
          depth: "quick",
        })
      ).status,
    ).toBe(409);
    expect((await dashboard.request(API.clear, {})).status).toBe(409);
    expect((await dashboard.request(pathFor(API.deleteRepository, repo.id), {})).status).toBe(409);
    // A Quick scan has one round, so it only stops.
    expect((await dashboard.request(pathFor(API.pauseSecurityScan, job.id), {})).status).toBe(409);
    expect((await dashboard.request(pathFor(API.cancelSecurityScan, job.id), {})).status).toBe(200);
    expect(await finished(job.id)).toMatchObject({
      status: "cancelled",
      error: null,
      tokens: null,
      cost: null,
      modelCalls: 1,
    });
    release?.();
    hold = undefined;
    expect(bodies).toHaveLength(1);
  });

  it("migrates the earlier schema and imports scan history without changing saved providers or invoking a model", async () => {
    await dashboard.request(API.scan, { path: project });
    await dashboard.close();
    const { DatabaseSync } = await import("node:sqlite");
    const legacy = new DatabaseSync(join(root, "data", "dashboard.sqlite"));
    try {
      legacy.exec(`
        DROP TABLE security_findings;
        DROP TABLE security_scans;
        DROP TABLE security_repositories;
        PRAGMA user_version = 7;
      `);
    } finally {
      legacy.close();
    }
    dashboard = await startTestDashboard({ root, workspace: project });
    const restored = await workspace();
    expect(restored.repositories).toHaveLength(1);
    expect(restored.scans[0]?.initiatedBy).toBe("Imported history");
    expect(restored.scans[0]?.modelCalls).toBe(0);
    expect(bodies).toHaveLength(0);
    await dashboard.close();
    dashboard = await startTestDashboard({ root, workspace: project });
    expect((await workspace()).scans).toHaveLength(1);
    expect((await finished((await start(restored.repositories[0]?.id ?? "")).id)).status).toBe(
      "completed",
    );
  });

  it("extends deep coverage across independent batches without re-sending previous files", async () => {
    for (let i = 0; i < 50; i++)
      await writeFile(join(project, `module-${i}.ts`), `export const value${i} = ${i};\n`);
    const repo = await repository();
    const scan = await finished((await start(repo.id, FULL)).id);
    expect(scan.status).toBe("completed");
    expect(scan.reviews).toHaveLength(3);
    const paths = scan.reviews.flatMap((review) => review.scope.files.map((file) => file.path));
    expect(paths).toHaveLength(52);
    expect(new Set(paths).size).toBe(52);
    expect(scan.modelCalls).toBeLessThanOrEqual(6);
  });

  it("runs Full coverage without a limit until every file is covered", async () => {
    for (let i = 0; i < 50; i++)
      await writeFile(join(project, `module-${i}.ts`), `export const value${i} = ${i};\n`);
    const repo = await repository();
    const scan = await finished((await start(repo.id, { depth: "full" })).id, 5000);
    expect(scan.status).toBe("completed");
    expect(scan.budget).toBeUndefined();
    expect(scan.reviews).toHaveLength(3);
    expect(scan.coverage).toMatchObject({ stop: "complete", eligibleFiles: 52, sentFiles: 52 });
    expect(scan.coverage?.charged.tokens).toBeGreaterThan(0);
  });

  it("streams scan saves and the reply under way, which the scan record also carries", async () => {
    const repo = await repository();
    const events = await dashboard.request(API.securityEvents);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    if (!events.body) throw new Error("No event stream.");
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    const received: SecurityEvent[] = [];
    let buffered = "";
    const until = async (match: (event: SecurityEvent) => boolean) => {
      for (;;) {
        const found = received.find(match);
        if (found) return found;
        const chunk = await reader.read();
        if (chunk.done) throw new Error("The event stream ended.");
        buffered += decoder.decode(chunk.value, { stream: true });
        const frames = buffered.split("\n\n");
        buffered = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) received.push(JSON.parse(data.slice(6)));
        }
      }
    };
    let held = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hold = async () => {
      held = true;
      await gate;
    };
    try {
      const job = await start(repo.id);
      try {
        await until((event) => event.type === "scan" && event.id === job.id);
        expect(
          await until((event) => event.type === "reply" && event.id === job.id && !!event.reply),
        ).toMatchObject({
          reply: { batch: 0, phase: "discovery", characters: 0, thinking: false, tool: null },
        });
        await vi.waitFor(() => expect(held).toBe(true));
        const running = (await (
          await dashboard.request(pathFor(API.securityScan, job.id))
        ).json()) as SecurityScan;
        expect(running.reply).toMatchObject({ batch: 0, phase: "discovery" });
      } finally {
        release?.();
        hold = undefined;
      }
      await until((event) => event.type === "reply" && event.id === job.id && !event.reply);
      const result = await finished(job.id);
      expect(result.status).toBe("completed");
      expect(result).not.toHaveProperty("reply");
    } finally {
      await reader.cancel();
    }
  });

  it("lists the files a scan could read from its saved static scan", async () => {
    await writeFile(join(project, "module.ts"), "export const value = 1;\n");
    const repo = await repository();
    const scan = await finished((await start(repo.id)).id, 5000);
    const response = await dashboard.request(pathFor(API.scanSourceFiles, scan.id));
    expect(response.status).toBe(200);
    const { paths } = (await response.json()) as ScanSourceFiles;
    expect(paths).toHaveLength(scan.coverage?.eligibleFiles ?? -1);
    expect(paths).toContain("module.ts");
    expect((await dashboard.request(pathFor(API.scanSourceFiles, "missing"))).status).toBe(404);
  });

  it("reviews a folder without Python, JavaScript or TypeScript as plain text", async () => {
    const service = join(root, "go-service");
    await mkdir(join(service, "templates"), { recursive: true });
    await writeFile(join(service, "main.go"), "package main\n\nfunc main() {}\n");
    await writeFile(join(service, "templates", "index.html"), "<p>{{ .Name }}</p>\n");
    const repo = (await (
      await dashboard.request(API.repositories, { path: service, name: "Go service" })
    ).json()) as LocalRepository;
    const scan = await finished((await start(repo.id)).id);
    expect(scan.status).toBe("completed");
    expect(scan.reviews[0]?.scope.files.map((file) => file.path)).toEqual([
      "main.go",
      "templates/index.html",
    ]);
    expect(JSON.stringify(bodies[0])).toContain("1: package main");
  });

  it("stops Full coverage when the next batch's maximum no longer fits the token limit", async () => {
    for (let i = 0; i < 50; i++)
      await writeFile(join(project, `module-${i}.ts`), `export const value${i} = ${i};\n`);
    const repo = await repository();
    const most = batchTokenBound(reviewBudget([])).total;
    const low = await dashboard.request(API.securityScans, {
      repositoryId: repo.id,
      providerId: provider.id,
      depth: "full",
      budget: { kind: "tokens", tokens: most - 1 },
    });
    expect(low.status).toBe(400);
    expect(await low.text()).toContain("below one round's maximum");
    const budget = { kind: "tokens", tokens: most } as const;
    const scan = await finished((await start(repo.id, { depth: "full", budget })).id);
    expect(scan.status).toBe("completed");
    expect(scan.budget).toEqual(budget);
    // One batch fits; after it charged anything, the next batch's maximum does not.
    expect(scan.reviews).toHaveLength(1);
    expect(scan.coverage).toMatchObject({ stop: "budget", eligibleFiles: 52, sentFiles: 24 });
    expect(scan.coverage?.charged.tokens).toBe(scan.reviews[0]?.request.charged?.tokens);
    expect(scan.coverage?.charged.tokens).toBeGreaterThan(0);
  });

  it("continues a Full coverage scan that stopped at its limit, and records its activity", async () => {
    for (let i = 0; i < 50; i++)
      await writeFile(join(project, `module-${i}.ts`), `export const value${i} = ${i};\n`);
    const repo = await repository();
    const most = batchTokenBound(reviewBudget([])).total;
    const budget = { kind: "tokens", tokens: most } as const;
    const first = await finished(
      (
        await start(repo.id, {
          depth: "full",
          budget,
          validatorProviderId: provider.id,
          validatorModel: "claude-validation-override",
        })
      ).id,
    );
    expect(first.coverage?.stop).toBe("budget");
    expect(first.reviews).toHaveLength(1);
    // The timeline holds the requests and the finished batch.
    expect(first.activity?.map((entry) => entry.kind)).toEqual(["request", "request", "batch"]);
    expect(first.activity?.at(-1)?.detail).toMatch(/^Round 1 finished: 24 files, \d+ findings?$/);

    const path = pathFor(API.continueSecurityScan, first.id);
    expect((await dashboard.request(path, {})).status).toBe(400);
    expect(
      (await dashboard.request(path, { budget: { kind: "tokens", tokens: most - 1 } })).status,
    ).toBe(400);
    const response = await dashboard.request(path, { budget });
    expect(response.status, await response.clone().text()).toBe(202);
    const second = await finished(first.id);
    expect(second.status).toBe("completed");
    expect(second.reviews).toHaveLength(2);
    expect(second.validator?.model).toBe("claude-validation-override");
    expect(
      second.reviews.every((review) => review.validator?.model === second.validator?.model),
    ).toBe(true);
    // The new limit counts what the scan spends from now on; the first limit is kept.
    expect(second.budget).toEqual(budget);
    expect(second.continuations).toEqual([
      { at: expect.any(String), budget, charged: first.coverage?.charged },
    ]);
    expect(second.coverage).toMatchObject({ stop: "budget", sentFiles: 48 });
    expect(second.coverage?.charged.tokens).toBe(
      (first.coverage?.charged.tokens ?? 0) + (second.reviews[1]?.request.charged?.tokens ?? 0),
    );
    // Files sent whole are not sent again.
    const before = new Set(second.reviews[0]?.scope.files.map((file) => file.path));
    expect(second.reviews[1]?.scope.files.some((file) => before.has(file.path))).toBe(false);
    expect(
      second.activity?.filter((entry) => entry.kind === "batch").map((entry) => entry.batch),
    ).toEqual([0, 1]);
    expect(second.durationMs).toBeGreaterThanOrEqual(first.durationMs);
    // Only a Full coverage scan stopped at its limit can continue.
    const quick = await finished((await start(repo.id)).id);
    expect(
      (await dashboard.request(pathFor(API.continueSecurityScan, quick.id), { budget })).status,
    ).toBe(400);
  });

  it("continues a Full coverage scan whose later batch failed on a provider error", async () => {
    for (let i = 0; i < 50; i++)
      await writeFile(join(project, `module-${i}.ts`), `export const value${i} = ${i};\n`);
    const repo = await repository();
    // The provider rate-limits from the second batch on.
    hold = async () => {
      if (bodies.length > 2) mode = "error";
    };
    const failed = await finished((await start(repo.id, FULL)).id);
    expect(failed.status).toBe("failed");
    expect(failed.reviews.map((review) => review.status)).toEqual(["completed", "failed"]);
    hold = undefined;
    mode = "normal";
    const response = await dashboard.request(pathFor(API.continueSecurityScan, failed.id), {
      budget: FULL.budget,
    });
    expect(response.status, await response.clone().text()).toBe(202);
    const continued = await finished(failed.id);
    expect(continued.status).toBe("completed");
    expect(continued.error).toBeNull();
    expect(continued.coverage?.stop).toBe("complete");
    // The failed batch stays in the record; its files were not sent and are sent now.
    expect(continued.reviews.map((review) => review.status)).toEqual([
      "completed",
      "failed",
      "completed",
      "completed",
    ]);
    expect(continued.coverage?.sentFiles).toBe(52);
    // A completed scan that covered everything cannot continue.
    expect(
      (
        await dashboard.request(pathFor(API.continueSecurityScan, failed.id), {
          budget: FULL.budget,
        })
      ).status,
    ).toBe(400);
  });

  /** Starts a Full coverage scan whose second round waits until `release`. */
  async function heldInSecondRound(patch = {}): Promise<SecurityScan> {
    for (let i = 0; i < 50; i++)
      await writeFile(join(project, `module-${i}.ts`), `export const value${i} = ${i};\n`);
    const repo = await repository();
    let enter: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    hold = () =>
      bodies.length > 2
        ? new Promise<void>((resolve) => {
            release = resolve;
            enter?.();
          })
        : Promise.resolve();
    const job = await start(repo.id, { depth: "full", ...patch });
    await entered;
    return job;
  }

  it("pauses a Full coverage scan and continues it without a limit from the round that was running", async () => {
    const job = await heldInSecondRound();
    expect((await dashboard.request(pathFor(API.pauseSecurityScan, "missing"), {})).status).toBe(
      404,
    );
    expect((await dashboard.request(pathFor(API.pauseSecurityScan, job.id), {})).status).toBe(200);
    const paused = await finished(job.id);
    release?.();
    hold = undefined;
    expect(paused).toMatchObject({ status: "paused", error: null });
    // The round that was running stays as a record of what it charged.
    expect(paused.reviews.map((review) => review.status)).toEqual(["completed", "cancelled"]);
    expect(paused.findings.length).toBeGreaterThan(0);
    expect((await dashboard.request(pathFor(API.pauseSecurityScan, job.id), {})).status).toBe(409);
    // A paused scan holds no lock, so another scan can run meanwhile.
    expect((await finished((await start(job.repositoryId)).id)).status).toBe("completed");
    // It ran without a limit, so it continues without one.
    const response = await dashboard.request(pathFor(API.continueSecurityScan, job.id), {});
    expect(response.status, await response.clone().text()).toBe(202);
    const continued = await finished(job.id, 5000);
    expect(continued).toMatchObject({ status: "completed", error: null });
    expect(continued.coverage).toMatchObject({ stop: "complete", sentFiles: 52 });
    expect(continued.reviews.map((review) => review.status)).toEqual([
      "completed",
      "cancelled",
      "completed",
      "completed",
    ]);
    expect(continued.continuations).toEqual([
      { at: expect.any(String), charged: paused.coverage?.charged },
    ]);
  });

  it("continues a paused scan under what is left of its limit", async () => {
    const job = await heldInSecondRound({ budget: FULL.budget });
    expect((await dashboard.request(pathFor(API.pauseSecurityScan, job.id), {})).status).toBe(200);
    const paused = await finished(job.id);
    release?.();
    hold = undefined;
    const charged = paused.coverage?.charged.tokens ?? 0;
    expect(charged).toBeGreaterThan(0);
    const left = remainingBudget(paused);
    expect(left).toEqual({ kind: "tokens", tokens: FULL.budget.tokens - charged });
    const path = pathFor(API.continueSecurityScan, job.id);
    // Its run had a limit, so continuing names one.
    expect((await dashboard.request(path, {})).status).toBe(400);
    const response = await dashboard.request(path, { budget: left });
    expect(response.status, await response.clone().text()).toBe(202);
    const continued = await finished(job.id, 5000);
    expect(continued.status).toBe("completed");
    expect(continued.continuations).toEqual([
      { at: expect.any(String), budget: left, charged: paused.coverage?.charged },
    ]);
    // A later pause counts from where the continuation began.
    expect(remainingBudget(continued)).toEqual({
      kind: "tokens",
      tokens:
        (left?.kind === "tokens" ? left.tokens : 0) -
        (continued.coverage?.charged.tokens ?? 0) +
        charged,
    });
  });

  it("pauses a Full coverage scan when the service stops, so it continues after a restart", async () => {
    const job = await heldInSecondRound();
    await dashboard.close();
    release?.();
    hold = undefined;
    dashboard = await startTestDashboard({ root, workspace: project });
    expect(await finished(job.id)).toMatchObject({
      status: "paused",
      error: SERVICE_STOPPED_PAUSE,
    });
    // A run that ended without saving its end, as after a crash, pauses on the next start.
    await dashboard.close();
    const { DatabaseSync } = await import("node:sqlite");
    const saved = new DatabaseSync(join(root, "data", "dashboard.sqlite"));
    try {
      saved
        .prepare(
          "UPDATE security_scans SET payload = json_set(payload, '$.status', 'running', '$.error', json('null')) WHERE id = ?",
        )
        .run(job.id);
    } finally {
      saved.close();
    }
    dashboard = await startTestDashboard({ root, workspace: project });
    expect(await finished(job.id)).toMatchObject({
      status: "paused",
      error: SERVICE_STOPPED_PAUSE,
    });
    const response = await dashboard.request(pathFor(API.continueSecurityScan, job.id), {});
    expect(response.status, await response.clone().text()).toBe(202);
    expect(await finished(job.id, 5000)).toMatchObject({ status: "completed", error: null });
  });

  it("limits Full coverage in USD only when every selected model has prices", async () => {
    for (let i = 0; i < 50; i++)
      await writeFile(join(project, `module-${i}.ts`), `export const value${i} = ${i};\n`);
    const repo = await repository();
    const unpriced = await dashboard.request(API.securityScans, {
      repositoryId: repo.id,
      providerId: provider.id,
      depth: "full",
      budget: { kind: "usd", usd: 5 },
    });
    expect(unpriced.status).toBe(400);
    expect(await unpriced.text()).toContain("model prices");
    const pricing = {
      model: provider.model,
      rates: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
    };
    const saved = await dashboard.request(API.providers, {
      id: provider.id,
      name: provider.name,
      provider: provider.provider,
      model: provider.model,
      baseUrl: provider.baseUrl,
      temperature: provider.temperature,
      maxOutputTokens: provider.maxOutputTokens,
      modelPricing: [pricing],
    });
    expect(saved.status).toBe(200);
    const most = batchCostBound(reviewBudget([]), pricing);
    const budget = { kind: "usd", usd: Math.ceil(most * 100) / 100 } as const;
    const scan = await finished((await start(repo.id, { depth: "full", budget })).id);
    expect(scan.status).toBe("completed");
    expect(scan.reviews).toHaveLength(1);
    expect(scan.coverage?.stop).toBe("budget");
    // Two calls of 500 input and 500 output tokens at the saved prices.
    expect(scan.coverage?.charged.usd).toBeCloseTo(0.012, 12);
    expect(scan.cost?.totalUsd).toBeCloseTo(0.012, 12);
  });

  it("estimates what a review could read before a scan starts", async () => {
    await writeFile(join(project, "main.go"), "package main\n");
    await mkdir(join(project, ".github", "workflows"), { recursive: true });
    await writeFile(join(project, ".github", "workflows", "ci.yml"), "on: push\n");
    await mkdir(join(project, ".vscode"), { recursive: true });
    await writeFile(join(project, ".vscode", "settings.json"), "{}\n");
    const repo = await repository();
    const response = await dashboard.request(pathFor(API.repositorySource, repo.id));
    expect(response.status).toBe(200);
    const source = (await response.json()) as RepositorySource;
    // server.ts, store.ts, main.go and the CI workflow; hidden settings stay out.
    expect(source).toMatchObject({ files: 4, truncated: false });
    expect(source.bytes).toBeGreaterThan(0);
    expect((await dashboard.request(pathFor(API.repositorySource, "missing"))).status).toBe(404);
    expect(bodies).toHaveLength(0);
  });

  it("continues a file too large for one batch until Full coverage has sent all of it", async () => {
    const helpers = Array.from({ length: 1000 }, (_, index) =>
      [`export function helper${index}(value: number) {`, `  return value + ${index};`, "}"].join(
        "\n",
      ),
    );
    await writeFile(
      join(project, "helpers.ts"),
      ['import { join } from "node:path";', "", ...helpers, ""].join("\n"),
    );
    const repo = await repository();
    // Several batches over a large file can take seconds on a shared CI runner.
    const scan = await finished((await start(repo.id, FULL)).id, 15_000);
    expect(scan.status).toBe("completed");
    expect(scan.reviews.length).toBeGreaterThan(3);
    expect(scan.coverage).toMatchObject({ stop: "complete", sentFiles: 3, eligibleFiles: 3 });
    const sent = scan.reviews.flatMap((review) => {
      const file = review.scope.files.find((item) => item.path === "helpers.ts");
      if (!file) return [];
      expect(file.ranges).toBeDefined();
      return [
        (file.ranges ?? []).flatMap((range) =>
          Array.from({ length: range.endLine - range.line + 1 }, (_, index) => range.line + index),
        ),
      ];
    });
    // Only the import line is sent again; together the batches send every function.
    const all = sent.flat().filter((line) => line !== 1);
    expect(new Set(all).size).toBe(all.length);
    for (let index = 0; index < 1000; index++) expect(all).toContain(3 + index * 3);
    expect(scan.coverage?.charged.tokens).toBeGreaterThan(0);
  }, 20_000);

  it("sizes the batch from the input window in the provider's saved model catalog", async () => {
    const repo = await repository();
    await dashboard.close();
    const store = await DashboardStore.open(join(root, "data"));
    const supervisor = new OperationSupervisor();
    const coordinator = new SecurityCoordinator(store, supervisor);
    try {
      store.providers.saveModelCatalog(
        { provider: "anthropic", baseUrl: provider.baseUrl, apiKey: key },
        [{ id: "claude-test", name: "Claude test", maxInputTokens: 200_000 }],
      );
      const started = await coordinator.start({
        repositoryId: repo.id,
        providerId: provider.id,
        depth: "quick",
      });
      await supervisor.settled();
      expect(store.security.scan(started.id)?.reviews[0]?.scope.budget).toMatchObject({
        contextBytes: 105_593,
        inputTokens: 200_000,
      });
    } finally {
      supervisor.abortAll();
      await coordinator.close();
      await supervisor.settled();
      store.close();
    }
  });

  it("sizes the batch from the Models.dev window when the provider lists none", async () => {
    const repo = await repository();
    await dashboard.close();
    const address = model.address();
    if (!address || typeof address === "string") throw new Error("No model server.");
    // The connection keeps Anthropic's own endpoint; its requests reach the local model.
    const actualFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      actualFetch(
        String(input).replace(PROVIDER_URLS.anthropic, `http://127.0.0.1:${address.port}/v1`),
        init,
      ),
    );
    const store = await DashboardStore.open(join(root, "data"));
    const supervisor = new OperationSupervisor();
    const loads: string[] = [];
    const windows = new ModelWindowCatalog(store.providers, async (name, id) => {
      loads.push(`${name}/${id}`);
      return { inputTokens: 200_000, fetchedAt: new Date().toISOString() };
    });
    const coordinator = new SecurityCoordinator(store, supervisor, undefined, windows);
    try {
      const claude = store.providers.saveProvider({
        name: "Claude API",
        provider: "anthropic",
        model: "claude-test",
        apiKey: key,
        baseUrl: PROVIDER_URLS.anthropic,
        maxOutputTokens: 8192,
        temperature: null,
      });
      const started = await coordinator.start({
        repositoryId: repo.id,
        providerId: claude.id,
        depth: "quick",
      });
      await supervisor.settled();
      expect(loads).toEqual(["anthropic/claude-test"]);
      const scan = store.security.scan(started.id);
      expect(scan?.status).toBe("completed");
      expect(scan?.reviews[0]?.scope.budget).toMatchObject({
        contextBytes: 105_593,
        inputTokens: 200_000,
      });
    } finally {
      vi.unstubAllGlobals();
      supervisor.abortAll();
      await coordinator.close();
      await supervisor.settled();
      store.close();
    }
  });

  it.each([undefined, "claude-validator-override"])(
    "runs validation on a separately chosen saved connection with model override %s",
    async (validatorModel) => {
      const address = model.address();
      if (!address || typeof address === "string") throw new Error("No model server.");
      const second = (await (
        await dashboard.request(API.providers, {
          name: "Claude validator",
          provider: "anthropic",
          model: "claude-validator",
          apiKey: key,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          maxOutputTokens: 8192,
          temperature: null,
        })
      ).json()) as SavedProvider;
      const repo = await repository();
      const scan = await finished(
        (
          await start(repo.id, {
            validatorProviderId: second.id,
            ...(validatorModel ? { validatorModel } : {}),
          })
        ).id,
      );
      expect(scan.status).toBe("completed");
      expect(scan.validator).toEqual({
        id: second.id,
        name: "Claude validator",
        model: validatorModel ?? "claude-validator",
      });
      expect(scan.reviews[0]?.validator).toEqual(scan.validator);
      expect(bodies.map((body) => body.model)).toEqual([
        "claude-test",
        validatorModel ?? "claude-validator",
      ]);
      expect(scan.modelCalls).toBe(2);
    },
  );

  it.each(["batch", "explore"] as const)(
    "uses a different validation model on the same connection in %s mode",
    async (mode) => {
      const validatorModel = "claude-validation-override";
      const rates = { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 };
      expect(
        (
          await dashboard.request(API.providers, {
            id: provider.id,
            name: provider.name,
            provider: provider.provider,
            model: provider.model,
            baseUrl: provider.baseUrl,
            temperature: provider.temperature,
            maxOutputTokens: provider.maxOutputTokens,
            modelPricing: [{ model: validatorModel, rates }],
          })
        ).status,
      ).toBe(200);
      const repo = await repository();
      const scan = await finished(
        (
          await start(repo.id, {
            mode,
            validatorProviderId: provider.id,
            validatorModel,
          })
        ).id,
      );
      expect(scan.status).toBe("completed");
      expect(scan.validator).toEqual({
        id: provider.id,
        name: provider.name,
        model: validatorModel,
      });
      expect(bodies.map((body) => body.model)).toEqual([provider.model, validatorModel]);
      expect(scan.reviews[0]?.request.validatorBilling?.pricing).toEqual({
        model: validatorModel,
        rates,
      });
      const saved = (await (await dashboard.request(API.providers)).json()) as SavedProvider[];
      expect(saved.find((item) => item.id === provider.id)?.model).toBe(provider.model);
    },
  );

  it("rejects invalid validation model choices before starting a scan", async () => {
    const repo = await repository();
    for (const validatorModel of ["", "https://invalid.example", 12, null, "model\nsecret"])
      expect(
        (
          await dashboard.request(API.securityScans, {
            repositoryId: repo.id,
            providerId: provider.id,
            depth: "quick",
            validatorProviderId: provider.id,
            validatorModel,
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await dashboard.request(API.securityScans, {
          repositoryId: repo.id,
          providerId: provider.id,
          depth: "quick",
          validatorModel: "claude-validation-override",
        })
      ).status,
    ).toBe(400);
    expect(bodies).toHaveLength(0);
    expect((await workspace()).scans).toHaveLength(0);
  });

  it("runs exploring reviews for Quick and Full coverage and rejects an unknown mode", async () => {
    const repo = await repository();
    const full = await finished((await start(repo.id, { mode: "explore", ...FULL })).id);
    expect(full.status).toBe("completed");
    expect(full.mode).toBe("explore");
    // The first exploring review held every file of this small project.
    expect(full.coverage?.stop).toBe("complete");
    expect(full.reviews).toHaveLength(1);
    bodies.length = 0;
    const unknown = await dashboard.request(API.securityScans, {
      repositoryId: repo.id,
      providerId: provider.id,
      depth: "quick",
      mode: "agentic",
    });
    expect(unknown.status).toBe(400);
    const scan = await finished((await start(repo.id, { mode: "explore" })).id);
    expect(scan.status).toBe("completed");
    expect(scan.mode).toBe("explore");
    expect(scan.reviews).toHaveLength(1);
    expect(scan.reviews[0]?.mode).toBe("explore");
    expect(scan.reviews[0]?.exploration?.map((item) => [item.phase, item.stop])).toEqual([
      ["discovery", "submitted"],
      ["validation", "submitted"],
    ]);
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => Array.isArray(body.tools))).toBe(true);
    expect(scan.findings.filter((item) => item.origin === "ai")).toHaveLength(1);
    // The first set held every file of this small project.
    expect(scan.coverage?.stop).toBe("complete");
  });

  it("stops at refusal and retains the failure outcome without leaking upstream credentials", async () => {
    const repo = await repository();
    mode = "refusal";
    const scan = await finished((await start(repo.id, FULL)).id);
    expect(scan.status).toBe("failed");
    expect(scan.reviews[0]?.status).toBe("refused");
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(scan)).not.toContain(key);
  });

  it("rejects continuous scans even for Git folders and disables saved monitors across startup", async () => {
    // Commits exist only in this disposable fixture, never in the user's checkout.
    const git = async (...args: string[]) =>
      execute("git", [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Plenger test",
        "-c",
        "user.email=test@example.invalid",
        "-C",
        project,
        ...args,
      ]);
    await git("init");
    await git("add", ".");
    await git("commit", "-m", "test: local project fixture");
    const repo = await repository();
    const rejected = await dashboard.request(API.securityScans, {
      repositoryId: repo.id,
      providerId: provider.id,
      scope: "continuous",
      depth: "quick",
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("Only manual scans of local folders");
    expect(bodies).toHaveLength(0);
    await dashboard.close();
    const store = await DashboardStore.open(join(root, "data"));
    const supervisor = new OperationSupervisor();
    repo.monitoring = {
      enabled: true,
      providerId: provider.id,
      depth: "quick",
      lastCommit: null,
      error: null,
    };
    store.security.saveRepository(repo);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const coordinator = new SecurityCoordinator(store, supervisor);
    try {
      expect(store.security.repository(repo.id)?.monitoring.enabled).toBe(false);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(store.security.workspace().scans).toHaveLength(0);
      expect(bodies).toHaveLength(0);
      const started = await coordinator.start({
        repositoryId: repo.id,
        providerId: provider.id,
        depth: "quick",
      });
      await supervisor.settled();
      expect(store.security.scan(started.id)).toMatchObject({
        status: "completed",
        scope: "local",
        initiatedBy: "Local user",
      });
      expect(store.security.scan(started.id)?.reviews[0]?.stride).toHaveLength(6);
      expect(bodies).toHaveLength(2);
      await writeFile(join(project, "comment.ts"), "// local change\n");
      await git("add", ".");
      await git("commit", "-m", "test: changed local project fixture");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(store.security.workspace().scans).toHaveLength(1);
      expect(bodies).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      supervisor.abortAll();
      await coordinator.close();
      await supervisor.settled();
      store.close();
    }
  });
});

/** These tests exercise the public dashboard with a local, scripted provider only. */
describe("static candidate source validation", () => {
  async function commandProject(count = 1, guard = false, padding = "") {
    await writeFile(
      join(project, "server.ts"),
      [
        'import express from "express";',
        'import { exec } from "node:child_process";',
        ...(guard ? ['import { assertCommand } from "./control.ts";'] : []),
        "const app = express();",
        ...Array.from({ length: count }, (_, index) =>
          [
            `app.get("/run${index}", (req, res) => {`,
            ...(guard ? ["  assertCommand(req.query.command);"] : []),
            padding,
            "  exec(req.query.command);",
            "  res.end();",
            "});",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
        "",
      ].join("\n"),
    );
    if (guard)
      await writeFile(
        join(project, "control.ts"),
        [
          "export function assertCommand(command: string) {",
          '  if (command !== "uptime") throw new Error("Command rejected");',
          "}",
          "",
        ].join("\n"),
      );
    discoveryReply = reviewDiscovery();
    discoveryReply.findings = [];
    discoveryReply.stride = discoveryReply.stride.map((item) => ({
      ...item,
      status: "insufficient-context",
      evidence: [],
    }));
    validationReply = (candidates) => ({
      status: "completed",
      reason: null,
      decisions: candidates.map((item) => ({
        id: item.id,
        verdict: "source-supported",
        reason:
          "server.ts:4-7 forwards request query input directly to exec; no guard is on that path.",
        basis: null,
        duplicateOf: null,
        evidence: [],
      })),
    });
  }
  const data = () =>
    bodies.map((body) =>
      JSON.parse((body.messages as { content: { text: string }[] }[])[0]?.content[0]?.text ?? "{}"),
    );
  const staticOnly = (scan: SecurityScan) =>
    scan.findings.filter((item) => item.origin === "static");

  it.each(["batch", "explore"])(
    "validates static candidates after independent discovery in %s mode",
    async (reviewMode) => {
      await commandProject();
      const result = await finished(
        (await start((await repository()).id, { mode: reviewMode })).id,
      );
      expect(result.status, result.error ?? "").toBe("completed");
      expect(staticOnly(result)).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        validationStatus: "source-supported",
        status: "new",
        provenance: [
          { origin: "static", ruleId: "PLG801", review: { validation: "source-supported" } },
        ],
      });
      expect(result.findings[0]?.validation).toContain("No runtime validation");
      expect(result.reviews[0]?.findings).toEqual([]);
      expect(result.reviews[0]?.staticFindings?.[0]?.evidence.at(-1)?.snippet).toContain(
        "exec(req.query.command)",
      );
      expect(data()[0]).not.toHaveProperty("candidates");
      expect(JSON.stringify(data()[0])).not.toContain('"ruleId"');
      expect(data()[1].candidates[0].static.ruleId).toBe("PLG801");
      expect(result.modelCalls).toBe(2);
    },
  );

  it("saves an evidenced dismissal using a related control and keeps workflow triage separate", async () => {
    await commandProject(1, true);
    validationReply = (candidates) => ({
      status: "completed",
      reason: null,
      decisions: candidates.map((item) => ({
        id: item.id,
        verdict: "dismissed",
        basis: "control",
        duplicateOf: null,
        reason:
          "control.ts:2 rejects every command except the fixed uptime command before exec is called.",
        evidence: [
          {
            path: "control.ts",
            line: 2,
            endLine: 2,
            role: "guard",
            message: "Only the application's fixed command can reach exec.",
          },
        ],
      })),
    });
    const result = await finished((await start((await repository()).id)).id);
    const finding = staticOnly(result)[0];
    expect(finding).toMatchObject({
      validationStatus: "dismissed",
      status: "new",
      provenance: [
        {
          ruleId: "PLG801",
          review: {
            dismissal: {
              basis: "control",
              evidence: [
                { path: "control.ts", snippet: expect.stringContaining('command !== "uptime"') },
              ],
            },
          },
        },
      ],
    });
    expect(result.findingCount).toBe(0);
    expect(data()[1].related.some((file: { path: string }) => file.path === "control.ts")).toBe(
      true,
    );
    expect(
      (await workspace()).findings.find((item) => item.id === finding?.id)?.validationStatus,
    ).toBe("dismissed");
  });

  it("keeps insufficient context as needs-review and rejects unsupported source-supported decisions", async () => {
    await commandProject();
    validationReply = (candidates) => ({
      status: "completed",
      reason: null,
      decisions: candidates.map((item) => ({
        id: item.id,
        verdict: "needs-review",
        reason: "The router's authorization middleware is in an omitted deployment module.",
      })),
    });
    const repo = await repository();
    const first = await finished((await start(repo.id)).id);
    expect(first.findings[0]?.validationStatus).toBe("needs-review");
    expect(first.findings[0]?.validation).toContain("omitted deployment module");
    await commandProject(
      1,
      false,
      Array.from(
        { length: 2000 },
        (_, index) => `  const padding${index} = "${"x".repeat(40)}";`,
      ).join("\n"),
    );
    const second = await finished((await start(repo.id)).id, 5000);
    expect(second.status, second.error ?? "").toBe("completed");
    expect(second.findings[0]?.validationStatus).toBe("needs-review");
    expect(second.findings[0]?.validation).toContain("Essential static evidence was not supplied");
  });

  it.each(["discovery", "validation", "refusal", "invalid", "tokens"])(
    "retains static indications as unvalidated after %s failure or limit",
    async (failure) => {
      await commandProject(failure === "tokens" ? 7 : 1);
      if (failure === "discovery") mode = "error";
      if (failure === "validation") mode = "validation-error";
      if (failure === "refusal")
        validationReply = () => ({
          status: "refused",
          reason: "Declined validation",
          decisions: [],
        });
      if (failure === "invalid")
        validationReply = () => ({ status: "completed", reason: null, decisions: [] });
      const result = await finished(
        (
          await start(
            (
              await repository()
            ).id,
            failure === "tokens"
              ? {
                  depth: "full",
                  budget: { kind: "tokens", tokens: batchTokenBound(reviewBudget([])).total },
                }
              : {},
          )
        ).id,
      );
      expect(staticOnly(result)).toHaveLength(failure === "tokens" ? 7 : 1);
      const pending = result.findings.find((finding) => finding.validationStatus === "unvalidated");
      expect(pending).toMatchObject({ validationStatus: "unvalidated", status: "new" });
      expect(pending?.validation).not.toContain("source-supported:");
      expect(bodies).toHaveLength(failure === "discovery" ? 1 : 2);
      if (failure === "tokens") {
        expect(result.coverage?.stop).toBe("budget");
        const response = await dashboard.request(pathFor(API.continueSecurityScan, result.id), {
          budget: { kind: "tokens", tokens: batchTokenBound(reviewBudget([])).total },
        });
        expect(response.status).toBe(202);
        const continued = await finished(result.id);
        expect(continued.findings).toHaveLength(7);
        expect(
          continued.findings.every((finding) => finding.validationStatus === "source-supported"),
        ).toBe(true);
        expect(continued.modelCalls).toBe(4);
      }
    },
  );

  it("leaves excess Quick candidates unvalidated and drains the queue in bounded Full coverage rounds", async () => {
    await commandProject(7);
    const repo = await repository();
    const quick = await finished((await start(repo.id)).id);
    expect(
      quick.findings.filter((item) => item.validationStatus === "source-supported"),
    ).toHaveLength(6);
    expect(quick.findings.filter((item) => item.validationStatus === "unvalidated")).toHaveLength(
      1,
    );
    const full = await finished((await start(repo.id, { depth: "full" })).id);
    expect(full.findings).toHaveLength(7);
    expect(full.findings.every((item) => item.validationStatus === "source-supported")).toBe(true);
    expect(full.reviews.map((review) => review.staticFindings?.length)).toEqual([6, 1]);
    expect(full.modelCalls).toBe(4);
    expect(full.coverage?.stop).toBe("complete");
  });

  function discoverCommand(mismatchedPath = false) {
    if (!discoveryReply) throw new Error("No synthetic discovery.");
    const finding = reviewDiscovery().findings[0];
    if (!finding) throw new Error("No synthetic candidate.");
    discoveryReply.findings = [
      {
        ...finding,
        title: "Command injection in run handler",
        cwe: "CWE-78",
        description: "The request command reaches exec unchanged.",
        evidence: [
          {
            path: "server.ts",
            line: mismatchedPath ? 1 : 4,
            endLine: mismatchedPath ? 2 : 7,
            role: "source",
            message: "Request command",
          },
          {
            path: "server.ts",
            line: mismatchedPath ? 1 : 5,
            endLine: mismatchedPath ? 2 : 5,
            role: "sink",
            message: "Shell execution",
          },
        ],
      },
    ];
  }
  function duplicateReply(candidates: ValidationCandidate[]) {
    const target = candidates.find((item) => "static" in item);
    return {
      status: "completed",
      reason: null,
      decisions: candidates.map((item) =>
        "static" in item
          ? {
              id: item.id,
              verdict: "source-supported",
              reason: "server.ts:4-7 passes the caller's command to exec.",
            }
          : {
              id: item.id,
              verdict: "dismissed",
              reason: "The same request-to-exec path is reported by the static candidate.",
              basis: "duplicate",
              duplicateOf: target?.id,
              evidence: [],
            },
      ),
    };
  }

  it("merges an evidenced cross-origin duplicate and preserves both triage states and provenance through rescan and restart", async () => {
    await commandProject();
    discoverCommand();
    const repo = await repository();
    const first = await finished((await start(repo.id)).id);
    expect(first.findings).toHaveLength(2);
    const staticFinding = first.findings.find((item) => item.origin === "static");
    const aiFinding = first.findings.find((item) => item.origin === "ai");
    const updates: { updatedAt: string; status: string }[] = [];
    for (const [finding, status] of [
      [staticFinding, "triaged"],
      [aiFinding, "in-progress"],
    ] as const) {
      const response = await dashboard.request(pathFor(API.findingStatus, finding?.id ?? ""), {
        status,
      });
      expect(response.status).toBe(200);
      updates.push((await response.json()) as { updatedAt: string; status: string });
    }
    // Timestamp ties keep the canonical report's state; both originals remain saved.
    const expectedStatus = updates.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      ?.status;
    validationReply = duplicateReply;
    const merged = await finished((await start(repo.id)).id);
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0]).toMatchObject({
      id: staticFinding?.id,
      validationStatus: "source-supported",
      status: expectedStatus,
    });
    expect(merged.findings[0]?.provenance?.map((item) => item.origin).sort()).toEqual([
      "ai",
      "static",
    ]);
    expect(merged.findings[0]?.mergedTriage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: staticFinding?.id, status: "triaged" }),
        expect.objectContaining({ id: aiFinding?.id, status: "in-progress" }),
      ]),
    );
    expect((await workspace()).findings).toHaveLength(1);
    mode = "error";
    const failed = await finished((await start(repo.id)).id);
    expect(failed.findings[0]).toMatchObject({
      id: staticFinding?.id,
      validationStatus: "unvalidated",
      status: expectedStatus,
    });
    expect(failed.findings[0]?.provenance?.map((item) => item.origin).sort()).toEqual([
      "ai",
      "static",
    ]);
    await dashboard.close();
    dashboard = await startTestDashboard({ root, workspace: project });
    expect((await workspace()).findings).toEqual(failed.findings);
    const aliasUpdate = await dashboard.request(pathFor(API.findingStatus, aiFinding?.id ?? ""), {
      status: "triaged",
    });
    expect(aliasUpdate.status).toBe(200);
    expect((await workspace()).findings[0]).toMatchObject({
      id: staticFinding?.id,
      status: "triaged",
    });
  });

  it("does not merge a similar title or a model duplicate claim with different source anchors", async () => {
    await commandProject();
    discoverCommand(true);
    validationReply = duplicateReply;
    const result = await finished((await start((await repository()).id)).id);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.find((item) => item.origin === "ai")?.validationStatus).toBe(
      "needs-review",
    );
    expect(result.findings.find((item) => item.origin === "ai")?.validation).toContain(
      "could not match the duplicate",
    );
  });

  it("rejects the removed Static only and Continue with AI requests without model usage", async () => {
    await commandProject();
    const repo = await repository();
    for (const workflow of ["static", "all"]) {
      const response = await dashboard.request(API.securityScans, {
        repositoryId: repo.id,
        providerId: provider.id,
        depth: "quick",
        workflow,
      });
      expect(response.status).toBe(400);
    }
    expect(bodies).toHaveLength(0);
    const result = await finished((await start(repo.id)).id);
    expect(result.workflow).toBe("all");
    const continued = await dashboard.request(
      `/api/security/scans/${encodeURIComponent(result.id)}/ai`,
      { providerId: provider.id, depth: "quick" },
    );
    expect(continued.status).toBe(404);
    expect(bodies).toHaveLength(2);
    expect((await workspace()).scans).toHaveLength(1);
  });
});
