import { RULE_BY_ID } from "../rules/catalog.ts";
import type { ScanResult } from "../scan.ts";
import {
  SECURITY_REVIEW_LIMITS as LIMITS,
  type ReviewCandidate,
  type ReviewCitation,
  type StaticReviewCandidate,
} from "./review-model.ts";
import { sameWeakness } from "./weaknesses.ts";

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

/** The citations a candidate marks as its effect, or its last citation when it marks none. */
function sinks(candidate: Pick<ReviewCandidate, "evidence">): ReviewCitation[] {
  const marked = candidate.evidence.filter((cite) => cite.role === "sink");
  return marked.length ? marked : candidate.evidence.slice(-1);
}

/** A candidate's sinks and the flow steps that lead to them. */
function path(candidate: Pick<ReviewCandidate, "evidence">): ReviewCitation[] {
  return [...sinks(candidate), ...candidate.evidence.filter((cite) => cite.role === "flow")];
}

/**
 * A model's duplicate claim across origins also needs a weakness of the same family and a
 * sink of one candidate on the other's sink or flow: a rule may name the prompt text as its
 * sink where the model names the call that sends it. Sources are not compared: a
 * configuration rule cites only its sink, and a rule and the model often cite different
 * lines of the same input.
 */
export function sameCandidatePath(
  a: Pick<ReviewCandidate, "cwe" | "evidence">,
  b: Pick<ReviewCandidate, "cwe" | "evidence">,
): boolean {
  if (!sameWeakness(a.cwe, b.cwe)) return false;
  const reaches = (from: typeof a, to: typeof b) =>
    sinks(from).some((sink) => path(to).some((cite) => overlaps(sink, cite)));
  return reaches(a, b) || reaches(b, a);
}
