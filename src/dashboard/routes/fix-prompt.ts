import { reviewRemediationContext } from "../../assessment/review-remediation.ts";
import { ReaImportError, reaPromptContext } from "../../evidence/import-rea.ts";
import { FixPromptError, generateFixPrompt } from "../../remediation/fix-prompt.ts";
import { StoreValidationError } from "../../storage/store.ts";
import { API, type FixPromptRequest, type FixPromptResult, WORKSPACE_LIMITS } from "../contract.ts";
import { expectKeys, HttpError, jsonRequest, requireString } from "../http.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";

/** Resolve evidence and credentials on the host, never from a client-supplied finding. */
export function fixPromptRoutes({ store, supervisor }: Services): Route[] {
  return [
    {
      method: "POST",
      path: API.generateFixPrompt,
      handler: async ({ request, response }) => {
        const body = await jsonRequest(request);
        const message = "Choose a saved scan, finding and provider.";
        expectKeys(
          body,
          ["scanId", "fingerprint", "providerId", "reaEvidenceId", "reviewId"],
          message,
        );
        const input: FixPromptRequest = {
          scanId: requireString(body.scanId, message, {
            min: 1,
            max: WORKSPACE_LIMITS.recordIdCharacters,
          }),
          fingerprint: requireString(body.fingerprint, message, {
            min: 1,
            max: WORKSPACE_LIMITS.recordIdCharacters,
          }),
          providerId: requireString(body.providerId, message, {
            min: 1,
            max: WORKSPACE_LIMITS.recordIdCharacters,
          }),
          ...(body.reviewId === undefined
            ? {}
            : {
                reviewId: requireString(body.reviewId, message, {
                  min: 1,
                  max: WORKSPACE_LIMITS.recordIdCharacters,
                }),
              }),
          ...(body.reaEvidenceId === undefined
            ? {}
            : {
                reaEvidenceId: requireString(
                  body.reaEvidenceId,
                  "Choose imported evidence from this scan.",
                  { min: 1, max: WORKSPACE_LIMITS.recordIdCharacters },
                ),
              }),
        };
        return supervisor.exclusive(async () => {
          const report = store.scans.readScan(input.scanId);
          if (!report) throw new HttpError(404, "Scan not found. Run a scan and choose a finding.");
          const finding = report.scan.findings.find(
            (item) => item.fingerprint === input.fingerprint,
          );
          const review = input.reviewId ? store.reviews.read(report.id, input.reviewId) : null;
          const aiContext = review ? reviewRemediationContext(review, input.fingerprint) : null;
          const findingContext = input.reviewId
            ? aiContext
            : finding
              ? {
                  finding,
                  rule: report.rules.find((item) => item.id === finding.rule) ?? null,
                }
              : null;
          if (!findingContext)
            throw new HttpError(404, "This finding is not in the selected scan or review.");
          const imported = input.reaEvidenceId
            ? store.evidence.read(report.id, input.reaEvidenceId)
            : null;
          if (input.reaEvidenceId && !imported)
            throw new HttpError(404, "Imported evidence not found in this scan.");
          let resolved: ReturnType<typeof store.resolveProvider>;
          try {
            resolved = store.resolveProvider(input.providerId);
          } catch (error) {
            if (error instanceof StoreValidationError)
              throw new HttpError(400, error.message, { cause: error });
            throw error;
          }
          if (response.destroyed) return undefined;
          const controller = new AbortController();
          const cancel = () => controller.abort();
          response.once("close", cancel);
          try {
            const draft = await generateFixPrompt(
              {
                scan: { id: report.id, createdAt: report.createdAt },
                ...findingContext,
                ...(imported ? { externalEvidence: reaPromptContext(imported) } : {}),
              },
              resolved.access,
              { signal: controller.signal },
            );
            const result: FixPromptResult = {
              ...draft,
              scanId: report.id,
              fingerprint: input.fingerprint,
              provider: {
                id: resolved.saved.id,
                name: resolved.saved.name,
                model: resolved.saved.model,
              },
              createdAt: new Date().toISOString(),
              ...(imported ? { reaEvidenceId: imported.id } : {}),
              ...(review ? { reviewId: review.id } : {}),
            };
            return { status: 200, body: result };
          } catch (error) {
            if (error instanceof FixPromptError || error instanceof ReaImportError)
              throw new HttpError(400, error.message, { cause: error });
            throw error;
          } finally {
            response.off("close", cancel);
          }
        });
      },
    },
  ];
}
