import type { SecurityReview } from "../assessment/review-model.ts";
import type { TokenUsage } from "../redteam/budget.ts";
import type { SecurityScan } from "./model.ts";

const total = (usage: TokenUsage) =>
  usage.inputTokens + usage.outputTokens + usage.additionalTokens;

/** Reported consumption only. Budget reservations never substitute for missing usage. */
export function reportedScanTokens(
  reviews: readonly Pick<SecurityReview, "request">[],
): { tokens: number; complete: boolean } | null {
  let tokens = 0,
    reported = false,
    complete = true;
  for (const review of reviews) {
    const request = review.request;
    if (!request.calls) continue;
    if (request.usage) {
      tokens += total(request.usage);
      reported = true;
    } else if (request.reportedUsage) {
      tokens += total(request.reportedUsage);
      complete &&= request.reportedUsage.complete;
      reported = true;
    } else {
      // Historical scans may retain billing details but no aggregate usage.
      const usage = [...(request.billing?.usage ?? []), ...(request.validatorBilling?.usage ?? [])];
      tokens += usage.reduce(
        (sum, item) =>
          sum +
          item.inputTokens +
          item.outputTokens +
          item.cacheReadTokens +
          item.cacheCreationTokens,
        0,
      );
      complete &&= usage.length === request.calls;
      reported ||= usage.length > 0;
    }
  }
  return reported ? { tokens, complete } : null;
}

/** Restore old display totals from saved observations without rewriting scan history. */
export function restoreReportedTokens(scan: SecurityScan): SecurityScan {
  if (scan.tokens !== null) return scan;
  const usage = reportedScanTokens(scan.reviews);
  return usage ? { ...scan, tokens: usage.tokens, tokensComplete: usage.complete } : scan;
}
