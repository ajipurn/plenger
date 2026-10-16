import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API,
  type DashboardScan,
  type FixPromptResult,
  type SecurityReview,
  TOKEN_HEADER,
} from "../src/dashboard/contract.ts";
import type { SavedProvider } from "../src/redteam/provider-config.ts";
import { required, startTestDashboard, type TestDashboard } from "./support/dashboard.ts";
import {
  nativeReviewReply,
  reviewDecision,
  reviewDiscovery,
  writeReviewProject,
} from "./support/security-review.ts";
import { temporaryDir } from "./support/tmp.ts";

let dashboard: TestDashboard;
let model: Server;
let root: string;
let project: string;
let provider: SavedProvider;
let report: DashboardScan;
let bodies: Record<string, unknown>[];
let mode: "normal" | "refused" | "error" | "invalid";
let hold: (() => Promise<void>) | undefined;
let release: (() => void) | undefined;
const key = "local-source-review-key";
const runExecutor = vi.fn(async () => {
  throw new Error("No execution allowed.");
});

beforeEach(async () => {
  root = await temporaryDir("plenger-review-dashboard-");
  project = await writeReviewProject(join(root, "project"));
  bodies = [];
  mode = "normal";
  hold = undefined;
  release = undefined;
  runExecutor.mockClear();
  model = createServer(async (request, response) => {
    let encoded = "";
    for await (const part of request) encoded += part;
    expect(request.url).toBe("/v1/messages");
    const body = JSON.parse(encoded);
    bodies.push(body);
    await hold?.();
    if (mode === "error") {
      response.writeHead(429);
      response.end(JSON.stringify({ error: `Private upstream error ${key}` }));
      return;
    }
    const user = JSON.parse(body.messages[0].content[0].text);
    const invalid = reviewDiscovery();
    required(required(invalid.findings[0], "finding").evidence[0], "citation").path =
      `../${key}.ts`;
    const content =
      mode === "refused"
        ? `Declined ${key}`
        : mode === "invalid"
          ? invalid
          : JSON.stringify(body.system).includes("Write a prompt")
            ? {
                status: "generated",
                prompt:
                  "Verify the tenant boundary and add the tenant predicate in store.ts with cross-tenant regression coverage.",
              }
            : user.candidates
              ? reviewDecision(user.candidates.map((item: { id: string }) => item.id))
              : reviewDiscovery();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(nativeReviewReply(content, mode === "refused" ? "refusal" : "end_turn")),
    );
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const address = model.address();
  if (!address || typeof address === "string") throw new Error("No model server.");
  dashboard = await startTestDashboard({ root, workspace: project, runExecutor });
  provider = (await (
    await dashboard.request(API.providers, {
      name: "Claude source review",
      provider: "anthropic",
      model: "claude-test",
      apiKey: key,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      maxOutputTokens: 8192,
      temperature: null,
    })
  ).json()) as SavedProvider;
  report = (await (await dashboard.request(API.scan, { path: project })).json()) as DashboardScan;
});
afterEach(async () => {
  release?.();
  await dashboard.close();
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
});
const input = () => ({ scanId: report.id, providerId: provider.id });

describe("dashboard AI security reviews", () => {
  it("persists independent findings, architecture and source traces and can generate a fix prompt for the AI finding", async () => {
    expect(report.scan.findings).toEqual([]);
    expect(
      await (await dashboard.request(`${API.securityReviews}?scanId=${report.id}`)).json(),
    ).toEqual([]);
    expect(bodies).toHaveLength(0);
    const before = await dashboard.state();
    const response = await dashboard.request(API.securityReviews, input());
    expect(response.status, await response.clone().text()).toBe(200);
    const review = (await response.json()) as SecurityReview;
    expect(review.status).toBe("completed");
    expect(review.findings).toHaveLength(1);
    expect(review.scope.files).toHaveLength(2);
    expect(review.findings[0]?.evidence[0]?.snippet).toContain("request.params.id");
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies)).not.toContain(key);
    expect(await dashboard.state()).toEqual(before);
    await dashboard.close();
    dashboard = await startTestDashboard({ root, workspace: project, runExecutor });
    expect(
      await (await dashboard.request(`${API.securityReviews}?scanId=${report.id}`)).json(),
    ).toEqual([review]);
    const prompt = await dashboard.request(API.generateFixPrompt, {
      ...input(),
      reviewId: review.id,
      fingerprint: review.findings[0]?.id,
    });
    expect(prompt.status, await prompt.clone().text()).toBe(200);
    const result = (await prompt.json()) as FixPromptResult;
    expect(result).toMatchObject({ status: "generated", reviewId: review.id });
    if (result.status === "generated") {
      expect(result.prompt).toContain("ai-security-review");
      expect(result.prompt).toContain("source-supported");
      expect(result.prompt).toContain("store.ts");
    }
    expect(bodies).toHaveLength(3);
    expect(runExecutor).not.toHaveBeenCalled();
  });

  it("authenticates review starts and rejects client-supplied paths, source, credentials, or unknown snapshots before model access", async () => {
    expect(
      (await dashboard.request(API.securityReviews, input(), { [TOKEN_HEADER]: "" })).status,
    ).toBe(403);
    expect(
      (
        await dashboard.request(API.securityReviews, input(), {
          Origin: "https://untrusted.example",
        })
      ).status,
    ).toBe(403);
    for (const patch of [
      { scanId: "missing" },
      { providerId: "missing" },
      { path: "/" },
      { source: "untrusted" },
      { apiKey: "untrusted" },
      { baseUrl: "https://untrusted.example" },
    ]) {
      const response = await dashboard.request(API.securityReviews, { ...input(), ...patch });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(bodies).toEqual([]);
    expect(runExecutor).not.toHaveBeenCalled();
  });

  it("binds review findings to their scan and removes them when scan history is cleared", async () => {
    const review = (await (
      await dashboard.request(API.securityReviews, input())
    ).json()) as SecurityReview;
    const other = (await (
      await dashboard.request(API.scan, { path: project })
    ).json()) as DashboardScan;
    const prompt = await dashboard.request(API.generateFixPrompt, {
      scanId: other.id,
      providerId: provider.id,
      reviewId: review.id,
      fingerprint: review.findings[0]?.id,
    });
    expect(prompt.status).toBe(404);
    expect(
      await (await dashboard.request(`${API.securityReviews}?scanId=${other.id}`)).json(),
    ).toEqual([]);
    expect((await dashboard.state()).report?.id).toBe(other.id);
    await dashboard.request(API.clear, {});
    expect((await dashboard.request(`${API.securityReviews}?scanId=${report.id}`)).status).toBe(
      404,
    );
    expect(bodies).toHaveLength(2);
  });

  it("persists refusal and safe failure status without retries or raw provider errors", async () => {
    mode = "refused";
    const refusal = (await (
      await dashboard.request(API.securityReviews, input())
    ).json()) as SecurityReview;
    expect(refusal.status).toBe("refused");
    expect(refusal.findings).toEqual([]);
    expect(JSON.stringify(refusal)).not.toContain(key);
    expect(bodies).toHaveLength(1);
    mode = "error";
    const failure = (await (
      await dashboard.request(API.securityReviews, input())
    ).json()) as SecurityReview;
    expect(failure.status).toBe("failed");
    expect(failure.reason).toContain("HTTP 429");
    expect(JSON.stringify(failure)).not.toContain("Private upstream");
    expect(JSON.stringify(failure)).not.toContain(key);
    expect(bodies).toHaveLength(2);
    const history = (await (
      await dashboard.request(`${API.securityReviews}?scanId=${report.id}`)
    ).json()) as SecurityReview[];
    expect(history.map((item) => item.status)).toEqual(["failed", "refused"]);
  });

  it("persists the specific rejected response field without leaking model values or retrying", async () => {
    mode = "invalid";
    const failure = (await (
      await dashboard.request(API.securityReviews, input())
    ).json()) as SecurityReview;
    expect(failure.status).toBe("failed");
    expect(failure.reason).toContain("Discovery response");
    expect(failure.reason).toContain("findings[0].evidence[0].path");
    expect(JSON.stringify(failure)).not.toContain(key);
    expect(bodies).toHaveLength(1);
    await dashboard.close();
    dashboard = await startTestDashboard({ root, workspace: project, runExecutor });
    const history = await (
      await dashboard.request(`${API.securityReviews}?scanId=${report.id}`)
    ).json();
    expect(history).toEqual([failure]);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(1);
  });

  it("serializes the review with other project operations and cancels when its client disconnects", async () => {
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    hold = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        entered?.();
      });
    const controller = new AbortController();
    const request = fetch(`${dashboard.url}${API.securityReviews}`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: dashboard.session.token, "Content-Type": "application/json" },
      body: JSON.stringify(input()),
      signal: controller.signal,
    });
    await started;
    expect((await dashboard.request(API.scan, { path: project })).status).toBe(409);
    expect((await dashboard.request(API.securityReviews, input())).status).toBe(409);
    controller.abort();
    await expect(request).rejects.toThrow();
    await vi.waitFor(async () => {
      const history = (await (
        await dashboard.request(`${API.securityReviews}?scanId=${report.id}`)
      ).json()) as SecurityReview[];
      expect(history[0]?.status).toBe("cancelled");
    });
    release?.();
    hold = undefined;
    expect((await dashboard.request(API.scan, { path: project })).status).toBe(200);
    expect(bodies).toHaveLength(1);
  });
});
