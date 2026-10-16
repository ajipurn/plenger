import type { FixPromptContext } from "../remediation/fix-prompt.ts";
import type { SecurityReview } from "./review-model.ts";

/** A host-resolved model finding can use the same prompt writer as an offline finding. */
export function reviewRemediationContext(
  review: SecurityReview,
  id: string,
): Pick<FixPromptContext, "finding" | "rule" | "origin"> | null {
  const finding = review.findings.find((item) => item.id === id && item.validation !== "dismissed");
  const primary = finding?.evidence[0];
  if (review.status !== "completed" || !finding || !primary || finding.validation === "dismissed")
    return null;
  return {
    finding,
    rule: null,
    origin: {
      kind: "ai-security-review",
      reviewId: review.id,
      sourceCapturedAt: review.scope.capturedAt,
      validation: finding.validation,
      validationReason: finding.validationReason,
      architecture: review.architecture,
      impact: finding.impact,
      preconditions: finding.preconditions,
    },
  };
}
