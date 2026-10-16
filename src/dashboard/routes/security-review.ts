import { reviewProject } from "../../assessment/security-review.ts";
import { StoreValidationError } from "../../storage/store.ts";
import { API, WORKSPACE_LIMITS } from "../contract.ts";
import { expectKeys, HttpError, jsonRequest, requireString } from "../http.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";

export function securityReviewRoutes({ store, supervisor }: Services): Route[] {
  return [
    {
      method: "GET",
      path: API.securityReviews,
      handler: ({ url }) => {
        const scanId = requireString(url.searchParams.get("scanId"), "Choose a saved scan.", {
          min: 1,
          max: WORKSPACE_LIMITS.recordIdCharacters,
        });
        if (!store.scans.readScan(scanId)) throw new HttpError(404, "Scan not found.");
        return { status: 200, body: store.reviews.list(scanId) };
      },
    },
    {
      method: "POST",
      path: API.securityReviews,
      handler: async ({ request, response }) => {
        const body = await jsonRequest(request);
        const message = "Choose a saved scan and provider to review source code.";
        expectKeys(body, ["scanId", "providerId"], message);
        const scanId = requireString(body.scanId, message, {
          min: 1,
          max: WORKSPACE_LIMITS.recordIdCharacters,
        });
        const providerId = requireString(body.providerId, message, {
          min: 1,
          max: WORKSPACE_LIMITS.recordIdCharacters,
        });
        return supervisor.exclusive(async () => {
          const report = store.scans.readScan(scanId);
          if (!report)
            throw new HttpError(404, "Scan not found. Scan a project before starting AI review.");
          let provider: ReturnType<typeof store.resolveProvider>;
          try {
            store.reviews.assertCapacity(scanId);
            provider = store.resolveProvider(providerId);
          } catch (error) {
            if (error instanceof StoreValidationError)
              throw new HttpError(400, error.message, { cause: error });
            throw error;
          }
          if (response.destroyed) return undefined;
          const controller = new AbortController();
          const cancel = () => controller.abort();
          response.once("close", cancel);
          const pricing = provider.saved.modelPricing?.find(
            (pricing) => pricing.model === provider.saved.model,
          );
          try {
            const review = await reviewProject(report.scan, {
              scanId,
              access: provider.access,
              ...(pricing ? { pricing: structuredClone(pricing) } : {}),
              signal: controller.signal,
              inputTokens: store.providers.modelInputTokens(
                provider.saved,
                provider.access.apiKey,
                provider.saved.model,
              ),
              provider: {
                id: provider.saved.id,
                name: provider.saved.name,
                model: provider.saved.model,
              },
            });
            store.reviews.save(review);
            return { status: 200, body: review };
          } finally {
            response.off("close", cancel);
          }
        });
      },
    },
  ];
}
