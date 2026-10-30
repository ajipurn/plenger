import { RULE_BY_ID } from "../rules/catalog.ts";
import type { ScanResult } from "../scan.ts";
import {
  SECURITY_REVIEW_LIMITS as LIMITS,
  type ReviewCandidate,
  type ReviewCitation,
  type StaticReviewCandidate,
} from "./review-model.ts";

/** Static indications are hypotheses for validation, never inputs to discovery. */
export function staticReviewCandidates(snapshot: ScanResult): StaticReviewCandidate[] {
  return snapshot.findings.map((finding) => {
    const rule = RULE_BY_ID.get(finding.rule);
    const evidence = finding.evidence.length
      ? finding.evidence
      : [{ location: finding.location, message: finding.title }];
    return {
      static: { fingerprint: finding.fingerprint, ruleId: finding.rule },
      title: finding.title.slice(0, LIMITS.text),
      severity: finding.severity,
      confidence: finding.confidence,
      cwe: rule?.cwe[0] ? `CWE-${rule.cwe[0]}` : null,
      description: [rule?.description, ...finding.notes]
        .filter(Boolean)
        .join("\n")
        .slice(0, LIMITS.text),
      impact: finding.title.slice(0, LIMITS.text),
      preconditions: [],
      mitigation: (rule?.remediation ?? "Inspect the source before applying a fix.").slice(
        0,
        LIMITS.text,
      ),
      evidence: (evidence.length > LIMITS.evidence
        ? [...evidence.slice(0, LIMITS.evidence - 1), ...evidence.slice(-1)]
        : evidence
      ).map((item, index, items) => ({
        path: item.location.path,
        line: item.location.line,
        endLine: item.location.endLine,
        role: index === items.length - 1 ? ("sink" as const) : ("source" as const),
        message: item.message.slice(0, LIMITS.text),
      })),
    };
  });
}

function overlaps(a: ReviewCitation, b: ReviewCitation): boolean {
  return a.path === b.path && a.line <= b.endLine && b.line <= a.endLine;
}

/** A model's duplicate claim also needs the same weakness and both path anchors. */
export function sameCandidatePath(
  a: Pick<ReviewCandidate, "cwe" | "evidence">,
  b: Pick<ReviewCandidate, "cwe" | "evidence">,
): boolean {
  if (!a.cwe || a.cwe !== b.cwe || !a.evidence.length || !b.evidence.length) return false;
  const first = a.evidence[0];
  const otherFirst = b.evidence[0];
  const sink = a.evidence.at(-1);
  const otherSink = b.evidence.at(-1);
  return Boolean(
    first &&
      otherFirst &&
      sink &&
      otherSink &&
      overlaps(first, otherFirst) &&
      overlaps(sink, otherSink),
  );
}
