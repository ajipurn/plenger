import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportedReaEvidence } from "../src/dashboard/contract.ts";
import {
  API,
  type DashboardScan,
  type FixPromptResult,
  TOKEN_HEADER,
} from "../src/dashboard/contract.ts";
import type { ProviderInput, SavedProvider } from "../src/redteam/provider-config.ts";
import { required, startTestDashboard, type TestDashboard } from "./support/dashboard.ts";
import { fixturePath } from "./support/fixtures.ts";
import { reaEvidence } from "./support/rea.ts";
import { temporaryDir } from "./support/tmp.ts";

const fixture = fixturePath("risks");
const key = "local-fix-prompt-test-key";
let dashboard: TestDashboard;
let modelServer: Server;
let provider: SavedProvider;
let report: DashboardScan;
let bodies: Record<string, unknown>[];
let modelStatus: number;
let modelContent: string;
let stopReason: string;
let release: (() => void) | undefined;
let waitForModel: (() => Promise<void>) | undefined;
const runExecutor = vi.fn(async () => {
  throw new Error("No dynamic execution permitted.");
});

beforeEach(async () => {
  bodies = [];
  modelStatus = 200;
  modelContent = JSON.stringify({
    status: "generated",
    prompt:
      "Inspect the selected source trace, confirm the unsafe boundary and implement a focused fix with regression coverage.",
  });
  stopReason = "end_turn";
  release = undefined;
  waitForModel = undefined;
  runExecutor.mockClear();
  modelServer = createServer(async (request, response) => {
    let content = "";
    for await (const part of request) content += part;
    expect(request.url).toBe("/v1/messages");
    expect(request.headers["x-api-key"]).toBe(key);
    bodies.push(JSON.parse(content));
    await waitForModel?.();
    response.writeHead(modelStatus, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        modelStatus === 200
          ? {
              type: "message",
              role: "assistant",
              stop_reason: stopReason,
              content: [{ type: "text", text: modelContent }],
              usage: { input_tokens: 100, output_tokens: 100 },
            }
          : { error: `Sensitive provider error ${key}` },
      ),
    );
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  if (!address || typeof address === "string") throw new Error("Model server did not bind.");
  dashboard = await startTestDashboard({
    root: await temporaryDir("plenger-fix-prompt-"),
    workspace: fixture,
    runExecutor,
  });
  const settings: ProviderInput = {
    name: "Claude fixes",
    provider: "anthropic",
    model: "claude-test",
    apiKey: key,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    maxOutputTokens: 4096,
    temperature: null,
  };
  const saved = await dashboard.request(API.providers, settings);
  expect(saved.status, await saved.clone().text()).toBe(200);
  provider = (await saved.json()) as SavedProvider;
  report = (await (await dashboard.request(API.scan, { path: fixture })).json()) as DashboardScan;
});

afterEach(async () => {
  release?.();
  await dashboard.close();
  modelServer.closeAllConnections();
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
});

function input() {
  return {
    scanId: report.id,
    fingerprint: required(report.scan.findings[0], "finding").fingerprint,
    providerId: provider.id,
  };
}

describe("dashboard fix prompts from saved findings", () => {
  it("sends imported REA facts only after selection and rejects evidence from another scan", async () => {
    const upload = await dashboard.request(API.reaEvidence, {
      scanId: report.id,
      filename: "rea.json",
      evidence: reaEvidence(),
    });
    expect(upload.status).toBe(200);
    const imported = (await upload.json()) as ImportedReaEvidence;
    expect((await dashboard.request(API.generateFixPrompt, input())).status).toBe(200);
    let encoded = JSON.stringify(bodies[0]);
    expect(encoded).not.toContain(imported.id);
    expect(encoded).not.toContain("user-imported-rea");
    const selected = await dashboard.request(API.generateFixPrompt, {
      ...input(),
      reaEvidenceId: imported.id,
    });
    expect(selected.status, await selected.clone().text()).toBe(200);
    expect(await selected.json()).toMatchObject({
      status: "generated",
      reaEvidenceId: imported.id,
    });
    encoded = JSON.stringify(bodies[1]);
    expect(encoded).toContain(imported.id);
    expect(encoded).toContain("user-imported-rea");
    expect(encoded).toContain("unverified");
    const other = (await (
      await dashboard.request(API.scan, { path: fixture })
    ).json()) as DashboardScan;
    expect(
      (
        await dashboard.request(API.generateFixPrompt, {
          ...input(),
          scanId: other.id,
          reaEvidenceId: imported.id,
        })
      ).status,
    ).toBe(404);
    await dashboard.request(API.deleteReaEvidence, { scanId: report.id, id: imported.id });
    expect(
      (await dashboard.request(API.generateFixPrompt, { ...input(), reaEvidenceId: imported.id }))
        .status,
    ).toBe(404);
    expect(bodies).toHaveLength(2);
  });
  it("resolves one saved finding and provider without editing scans or starting an agent", async () => {
    const before = await dashboard.state();
    expect(bodies).toHaveLength(0);
    const response = await dashboard.request(API.generateFixPrompt, input());
    expect(response.status).toBe(200);
    const result = (await response.json()) as FixPromptResult;
    expect(result).toMatchObject({
      status: "generated",
      scanId: report.id,
      fingerprint: input().fingerprint,
      provider: { id: provider.id, name: provider.name, model: provider.model },
    });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(bodies).toHaveLength(1);
    const body = required(bodies[0], "request body");
    expect(body.tools).toBeUndefined();
    expect(body.max_tokens).toBe(8192);
    expect(JSON.stringify(body)).not.toContain(fixture);
    expect(JSON.stringify(body)).not.toContain(key);
    const messages = body.messages as { content: { text: string }[] }[];
    const evidence = JSON.parse(required(required(messages[0], "message").content[0], "text").text);
    expect(evidence.finding).toEqual(report.scan.findings[0]);
    expect(evidence.rule.id).toBe(report.scan.findings[0]?.rule);
    expect(evidence.scan.id).toBe(report.id);
    expect(evidence.findings).toBeUndefined();
    expect(await dashboard.state()).toEqual(before);
    expect(runExecutor).not.toHaveBeenCalled();
  });

  it("rejects authentication, unknown selections and client-supplied source or access before calling the model", async () => {
    expect(
      (await dashboard.request(API.generateFixPrompt, input(), { [TOKEN_HEADER]: "" })).status,
    ).toBe(403);
    expect(
      (
        await dashboard.request(API.generateFixPrompt, input(), {
          Origin: "https://untrusted.example",
        })
      ).status,
    ).toBe(403);
    for (const patch of [
      { scanId: "missing" },
      { fingerprint: "missing" },
      { providerId: "missing" },
      { providerId: "" },
      { finding: report.scan.findings[0] },
      { path: fixture },
      { baseUrl: "https://untrusted.example" },
      { apiKey: "untrusted-key" },
    ]) {
      const response = await dashboard.request(API.generateFixPrompt, { ...input(), ...patch });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    await dashboard.request(API.deleteProvider, { id: provider.id });
    expect((await dashboard.request(API.generateFixPrompt, input())).status).toBe(400);
    expect(bodies).toHaveLength(0);
    expect(runExecutor).not.toHaveBeenCalled();
  });

  it("keeps history and project selection unchanged when generating from an older scan", async () => {
    const original = input();
    await dashboard.request(API.scan, { path: fixture });
    const before = await dashboard.state();
    expect(before.report?.id).not.toBe(original.scanId);
    const response = await dashboard.request(API.generateFixPrompt, original);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "generated", scanId: original.scanId });
    expect(await dashboard.state()).toEqual(before);
    await dashboard.request(API.clear, {});
    expect((await dashboard.request(API.generateFixPrompt, original)).status).toBe(404);
    expect(bodies).toHaveLength(1);
  });

  it("returns a refusal once and never leaks a provider error body", async () => {
    stopReason = "refusal";
    modelContent = `Declined ${key}`;
    const refused = await dashboard.request(API.generateFixPrompt, input());
    expect(refused.status).toBe(200);
    const result = (await refused.json()) as FixPromptResult;
    expect(result.status).toBe("refused");
    expect(result).not.toHaveProperty("prompt");
    expect(JSON.stringify(result)).not.toContain(key);
    expect(bodies).toHaveLength(1);
    modelStatus = 429;
    const failed = await dashboard.request(API.generateFixPrompt, input());
    expect(failed.status).toBe(400);
    const message = await failed.text();
    expect(message).toContain("HTTP 429");
    expect(message).not.toContain(key);
    expect(message).not.toContain("Sensitive");
    expect(bodies).toHaveLength(2);
  });

  it("rejects concurrent generation and releases the project lock when the request finishes", async () => {
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    waitForModel = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        started?.();
      });
    const first = dashboard.request(API.generateFixPrompt, input());
    await entered;
    expect((await dashboard.request(API.generateFixPrompt, input())).status).toBe(409);
    expect(bodies).toHaveLength(1);
    release?.();
    expect((await first).status).toBe(200);
    waitForModel = undefined;
    expect((await dashboard.request(API.scan, { path: fixture })).status).toBe(200);
  });
});
