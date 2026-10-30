import { createServer } from "node:http";
import { join } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";
import {
  API,
  type LocalRepository,
  type ModelPricingResult,
  type SecurityScan,
  type SecurityWorkspace,
} from "../src/dashboard/contract.ts";
import { parseModelPricing } from "../src/redteam/models-dev-pricing.ts";
import type { SavedProvider } from "../src/redteam/provider-config.ts";
import { startTestDashboard } from "./support/dashboard.ts";
import { reviewDecision, reviewDiscovery, writeReviewProject } from "./support/security-review.ts";
import { temporaryDir } from "./support/tmp.ts";

describe("OpenAI scan billing", () => {
  it("fetches prices at scan start, prices both passes and preserves historical snapshots", async () => {
    const root = await temporaryDir("plenger-openai-billing-");
    const project = await writeReviewProject(join(root, "project"));
    let inputPrice = 2;
    let pricingCalls = 0;
    let mode = "stop";
    let pauseValidation = true;
    let validating = false;
    let releaseValidation = () => {};
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const requests: string[] = [];
    const upstream = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe("Bearer synthetic-openai-key");
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      requests.push(body.model);
      const data = JSON.parse(body.messages[1].content);
      if (data.candidates && pauseValidation) {
        validating = true;
        await validationGate;
      }
      const content = data.candidates
        ? reviewDecision(data.candidates.map((item: { id: string }) => item.id))
        : reviewDiscovery();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ finish_reason: mode, message: { content: JSON.stringify(content) } }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            total_tokens: 1100,
            prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
            completion_tokens_details: { reasoning_tokens: 70 },
          },
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No model server.");
    const dashboard = await startTestDashboard({
      root,
      workspace: project,
      pricingLoader: async (model, _signal, _dispatch, provider) => {
        expect(provider).toBe("openai");
        pricingCalls++;
        return parseModelPricing(
          model,
          parse(
            `schema = 2\n[cost.text.input]\nprice = ${inputPrice}\ncache = { read = 0.2, write = 2.5 }\n[cost.text.output]\nprice = 10`,
          ),
          "openai",
        );
      },
    });
    try {
      const provider = (await (
        await dashboard.request(API.providers, {
          name: "OpenAI",
          provider: "openai",
          model: "gpt-test",
          apiKey: "synthetic-openai-key",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          temperature: null,
          maxOutputTokens: null,
        })
      ).json()) as SavedProvider;
      const repo = (await (
        await dashboard.request(API.repositories, { path: project, name: "Invoices" })
      ).json()) as LocalRepository;
      async function scan() {
        const started = await dashboard.request(API.securityScans, {
          repositoryId: repo.id,
          providerId: provider.id,
          depth: "quick",
        });
        expect(started.status, await started.clone().text()).toBe(202);
        const job = (await started.json()) as SecurityScan;
        if (pauseValidation) {
          try {
            await vi.waitFor(() => expect(validating).toBe(true));
            const pending = (await (
              await dashboard.request(API.securityScan.replace(":id", job.id))
            ).json()) as SecurityScan;
            expect(pending.status).toBe("running");
            expect(pending.reviews).toHaveLength(0);
            expect(pending.tokens).toBe(1100);
            expect(pending.tokensComplete).toBe(false);
            expect(pending.modelCalls).toBe(2);
            expect(pending.cost?.complete).toBe(false);
            expect(pending.cost?.totalUsd).toBeCloseTo(0.00197, 12);
            const workspace = (await (
              await dashboard.request(API.securityWorkspace)
            ).json()) as SecurityWorkspace;
            expect(workspace.scans.find((item) => item.id === job.id)?.tokens).toBe(1100);
          } finally {
            pauseValidation = false;
            releaseValidation();
          }
        }
        let result = job;
        await vi.waitFor(
          async () => {
            result = (await (
              await dashboard.request(API.securityScan.replace(":id", job.id))
            ).json()) as SecurityScan;
            expect(result.status).not.toBe("running");
          },
          { timeout: 5000 },
        );
        return result;
      }
      const first = await scan();
      expect(first.status, first.error ?? "").toBe("completed");
      expect(first.tokens).toBe(2200);
      expect(first.cost).toMatchObject({ complete: true });
      expect(first.cost?.totalUsd).toBeCloseTo(0.00394, 12);
      expect(first.reviews[0]?.request.billing).toMatchObject({
        pricing: { source: { name: "models.dev" } },
        usage: [
          { inputTokens: 300, cacheReadTokens: 600, cacheWriteTokens: 100 },
          { outputTokens: 100 },
        ],
      });
      expect(pricingCalls).toBe(1);
      expect(requests).toEqual(["gpt-test", "gpt-test"]);
      inputPrice = 4;
      const prices = (await (
        await dashboard.request(API.modelPricing, {
          provider: "openai",
          model: "gpt-test",
          refresh: true,
        })
      ).json()) as ModelPricingResult;
      expect(prices.pricing.rates.input).toBe(4);
      const second = await scan();
      expect(second.cost?.totalUsd).toBeCloseTo(0.00514, 12);
      const saved = (await (
        await dashboard.request(API.securityScan.replace(":id", first.id))
      ).json()) as SecurityScan;
      expect(saved.cost).toEqual(first.cost);
      const workspace = (await (
        await dashboard.request(API.securityWorkspace)
      ).json()) as SecurityWorkspace;
      expect(workspace.scans.find((item) => item.id === first.id)?.cost).toEqual(first.cost);
      mode = "length";
      const failed = await scan();
      expect(failed.status).toBe("failed");
      expect(failed.cost?.totalUsd).toBeCloseTo(0.00257, 12);
      expect(failed.cost?.complete).toBe(true);
    } finally {
      releaseValidation();
      await dashboard.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
