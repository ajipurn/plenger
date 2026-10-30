import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API,
  type LocalRepository,
  type ScanBudget,
  type SecurityScan,
  type SecurityWorkspace,
} from "../src/dashboard/contract.ts";
import { CHATGPT } from "../src/redteam/constants.ts";
import type { ModelPricing } from "../src/redteam/model-pricing.ts";
import { PROVIDER_URLS } from "../src/redteam/provider-config.ts";
import { ProviderRepository } from "../src/storage/provider-repository.ts";
import { DashboardStore } from "../src/storage/store.ts";
import { startTestDashboard } from "./support/dashboard.ts";
import { reviewDecision, reviewDiscovery, writeReviewProject } from "./support/security-review.ts";
import { temporaryDir } from "./support/tmp.ts";

const actualFetch = globalThis.fetch;
afterEach(() => vi.unstubAllGlobals());

describe("ChatGPT API-equivalent scan estimates", () => {
  it("uses observed cached tokens, snapshots API rates and labels mixed or incomplete estimates", async () => {
    const root = await temporaryDir("plenger-chatgpt-pricing-");
    const project = await writeReviewProject(join(root, "project"));
    const store = await ProviderRepository.open(join(root, "data"));
    const subscription = store.providers.saveProvider({
      name: "Subscription",
      provider: "chatgpt",
      model: "gpt-test",
      baseUrl: PROVIDER_URLS.chatgpt,
      temperature: null,
      maxOutputTokens: null,
    });
    store.providers.saveChatgptSession(
      subscription.id,
      {
        clientId: "synthetic-client",
        subject: "synthetic-user",
        credentials: {
          accessToken: "synthetic-subscription-token",
          refreshToken: "synthetic-refresh",
          idToken: "synthetic-id",
          expiresAt: Date.now() + 3600_000,
          scopes: CHATGPT.scope.split(" "),
        },
      },
      null,
    );
    const api = store.providers.saveProvider({
      name: "API",
      provider: "openai",
      model: "gpt-test",
      baseUrl: PROVIDER_URLS.openai,
      apiKey: "synthetic-api-key",
      temperature: null,
      maxOutputTokens: null,
    });
    store.close();
    let mode = "complete";
    let inputPrice = 2;
    let pricingCalls = 0;
    let pauseValidation = true;
    let validating = false;
    let releaseValidation = () => {};
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return actualFetch(input, init);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("gpt-test");
      const chatgpt = url === `${CHATGPT.resource}/responses`;
      expect(chatgpt || url === `${PROVIDER_URLS.openai}/chat/completions`).toBe(true);
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        chatgpt ? "Bearer synthetic-subscription-token" : "Bearer synthetic-api-key",
      );
      const data = JSON.parse(chatgpt ? body.input[1].content : body.messages[1].content);
      if (data.candidates && pauseValidation) {
        validating = true;
        await validationGate;
      }
      const content = data.candidates
        ? reviewDecision(data.candidates.map((item: { id: string }) => item.id))
        : reviewDiscovery();
      const details =
        mode === "missing-all" || (mode === "missing-validation" && data.candidates)
          ? {}
          : { input_tokens_details: { cached_tokens: 600 } };
      const usage = {
        input_tokens: 1000,
        output_tokens: 100,
        total_tokens: 1100,
        ...details,
        output_tokens_details: { reasoning_tokens: 70 },
      };
      if (!chatgpt)
        return Response.json({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            total_tokens: 1100,
            prompt_tokens_details: { cached_tokens: 600 },
            completion_tokens_details: { reasoning_tokens: 70 },
          },
        });
      expect(body).not.toHaveProperty("max_output_tokens");
      const response =
        mode === "cut"
          ? {
              type: "response.incomplete",
              response: { incomplete_details: { reason: "max_output_tokens" }, usage },
            }
          : {
              type: "response.completed",
              response: {
                status: "completed",
                usage,
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: JSON.stringify(content) }],
                  },
                ],
              },
            };
      return new Response(`data: ${JSON.stringify(response)}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const dashboard = await startTestDashboard({
      root,
      workspace: project,
      pricingLoader: async (model, _signal, _dispatch, provider): Promise<ModelPricing> => {
        expect(provider).toBe("openai");
        if (model === "gpt-no-price") throw new Error("No model prices");
        pricingCalls++;
        return {
          model,
          rates: {
            input: inputPrice,
            output: 10,
            cacheRead: 0.2,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
          },
          longContext: {
            threshold: 900,
            rates: {
              input: inputPrice * 2,
              output: 15,
              cacheRead: 0.4,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
            },
          },
          source: { name: "models.dev", fetchedAt: new Date().toISOString() },
        };
      },
    });
    try {
      const repo = (await (
        await dashboard.request(API.repositories, { path: project, name: "Invoices" })
      ).json()) as LocalRepository;
      async function scan(validatorProviderId?: string, budget?: ScanBudget) {
        const started = await dashboard.request(API.securityScans, {
          repositoryId: repo.id,
          providerId: subscription.id,
          depth: budget ? "full" : "quick",
          ...(budget ? { budget } : {}),
          ...(validatorProviderId ? { validatorProviderId } : {}),
        });
        expect(started.status, await started.clone().text()).toBe(202);
        let result = (await started.json()) as SecurityScan;
        if (pauseValidation) {
          try {
            await vi.waitFor(() => expect(validating).toBe(true));
            const pending = (await (
              await dashboard.request(API.securityScan.replace(":id", result.id))
            ).json()) as SecurityScan;
            expect(pending.status).toBe("running");
            expect(pending.reviews).toHaveLength(0);
            expect(pending.tokens).toBe(1100);
            expect(pending.tokensComplete).toBe(false);
            expect(pending.modelCalls).toBe(2);
            expect(pending.cost?.complete).toBe(false);
            expect(pending.cost?.totalUsd).toBeCloseTo(0.00334, 12);
            const workspace = (await (
              await dashboard.request(API.securityWorkspace)
            ).json()) as SecurityWorkspace;
            expect(workspace.scans.find((item) => item.id === result.id)?.tokens).toBe(1100);
          } finally {
            pauseValidation = false;
            releaseValidation();
          }
        }
        await vi.waitFor(
          async () => {
            result = (await (
              await dashboard.request(API.securityScan.replace(":id", result.id))
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
      expect(first.cost).toMatchObject({ basis: "api-equivalent", complete: true });
      expect(first.cost?.totalUsd).toBeCloseTo(0.00668, 12);
      expect(first.reviews[0]?.request.billing).toMatchObject({
        basis: "api-equivalent",
        usage: [
          { inputTokens: 400, cacheReadTokens: 600, outputTokens: 100 },
          { outputTokens: 100 },
        ],
      });
      expect(first.reviews[0]?.request.charged?.usd).toBeCloseTo(0.00668, 12);
      expect(pricingCalls).toBe(1);
      // Older scans can retain a billable response even when the complete token ledger was lost.
      const legacy = structuredClone(first);
      legacy.id = `legacy-${first.id}`;
      legacy.tokens = null;
      const legacyReview = legacy.reviews[0];
      if (!legacyReview?.request.billing || !first.cost) throw new Error("Missing review billing");
      legacyReview.request.usage = null;
      Reflect.deleteProperty(legacyReview.request, "reportedUsage");
      legacyReview.request.billing.usage = legacyReview.request.billing.usage.slice(0, 1);
      legacyReview.request.billing.cost = { ...first.cost, complete: false };
      const storage = await DashboardStore.open(join(root, "data"));
      try {
        storage.security.saveScan(legacy);
      } finally {
        storage.close();
      }
      const recovered = (await (
        await dashboard.request(API.securityScan.replace(":id", legacy.id))
      ).json()) as SecurityScan;
      expect(recovered.tokens).toBe(1100);
      expect(recovered.tokensComplete).toBe(false);
      const recoveredWorkspace = (await (
        await dashboard.request(API.securityWorkspace)
      ).json()) as SecurityWorkspace;
      expect(recoveredWorkspace.scans.find((item) => item.id === legacy.id)?.tokens).toBe(1100);
      inputPrice = 4;
      expect(
        (
          await dashboard.request(API.modelPricing, {
            provider: "openai",
            model: "gpt-test",
            refresh: true,
          })
        ).status,
      ).toBe(200);
      const next = await scan();
      expect(next.cost?.totalUsd).toBeCloseTo(0.00988, 12);
      const saved = (await (
        await dashboard.request(API.securityScan.replace(":id", first.id))
      ).json()) as SecurityScan;
      expect(saved.cost).toEqual(first.cost);
      expect(saved.reviews[0]?.request.billing?.pricing?.longContext?.rates.input).toBe(4);
      const mixed = await scan(api.id);
      expect(mixed.status, mixed.error ?? "").toBe("completed");
      expect(mixed.cost).toMatchObject({ basis: "mixed", complete: true });
      expect(mixed.cost?.totalUsd).toBeCloseTo(0.00988, 12);
      expect(mixed.reviews[0]?.request.validatorBilling).not.toHaveProperty("basis");
      mode = "missing-validation";
      const partial = await scan();
      expect(partial.status).toBe("completed");
      expect(partial.cost).toMatchObject({ basis: "api-equivalent", complete: false });
      expect(partial.cost?.totalUsd).toBeCloseTo(0.00494, 12);
      mode = "missing-all";
      const unknown = await scan();
      expect(unknown.status).toBe("completed");
      expect(unknown.tokens).toBe(2200);
      expect(unknown.cost).toBeNull();
      expect(unknown.reviews[0]?.request.billing?.basis).toBe("api-equivalent");
      mode = "cut";
      const failed = await scan();
      expect(failed.status).toBe("failed");
      expect(failed.tokens).toBe(1100);
      expect(failed.cost).toMatchObject({ basis: "api-equivalent", complete: true });
      expect(failed.cost?.totalUsd).toBeCloseTo(0.00494, 12);
      mode = "complete";
      const capped = await scan(undefined, { kind: "usd", usd: 100 });
      expect(capped.status, capped.error ?? "").toBe("completed");
      expect(capped.budget).toEqual({ kind: "usd", usd: 100 });
      expect(capped.coverage?.charged.usd).toBeCloseTo(0.00988, 12);
      const mixedCapped = await scan(api.id, { kind: "usd", usd: 100 });
      expect(mixedCapped.status, mixedCapped.error ?? "").toBe("completed");
      expect(mixedCapped.coverage?.charged.usd).toBeCloseTo(0.00988, 12);
      const unpriced = await dashboard.request(API.securityScans, {
        repositoryId: repo.id,
        providerId: subscription.id,
        model: "gpt-no-price",
        depth: "full",
        budget: { kind: "usd", usd: 100 },
      });
      expect(unpriced.status).toBe(400);
      const workspace = (await (
        await dashboard.request(API.securityWorkspace)
      ).json()) as SecurityWorkspace;
      expect(workspace.scans.find((scan) => scan.id === first.id)?.cost).toEqual(first.cost);
      expect(JSON.stringify(workspace)).not.toContain("synthetic-subscription-token");
    } finally {
      releaseValidation();
      await dashboard.close();
    }
  });
});
