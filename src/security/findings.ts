import { createHash } from "node:crypto";
import type { SecurityReview } from "../assessment/review-model.ts";
import type { Rule } from "../rules/model.ts";
import type { ScanResult } from "../scan.ts";
import type { SecurityFinding, SecurityScan } from "./model.ts";

/**
 * The findings of one scan. `previous` holds the project's saved findings: an AI finding
 * reported again under a different model-written title keeps its saved identity, and
 * so its triage status, when it has the same STRIDE category and overlapping evidence.
 */
export function scanFindings(
  job: SecurityScan,
  result: ScanResult,
  rules: Rule[],
  reviews: SecurityReview[],
  previous: readonly SecurityFinding[] = [],
): SecurityFinding[] {
  if (!job.sourceScanId) return [];
  const common = {
    repositoryId: job.repositoryId,
    scanId: job.id,
    sourceScanId: job.sourceScanId,
    status: "new" as const,
    detectedAt: job.startedAt,
    updatedAt: job.startedAt,
  };
  const id = (value: string) =>
    createHash("sha256").update(`${job.repositoryId}:${value}`).digest("hex");
  const findings: SecurityFinding[] = result.findings.map((finding) => {
    const rule = rules.find((item) => item.id === finding.rule);
    const evidence = finding.evidence.length
      ? finding.evidence
      : [{ location: finding.location, message: finding.title, snippet: finding.snippet }];
    return {
      ...common,
      id: id(`static:${finding.fingerprint}`),
      fingerprint: finding.fingerprint,
      reviewId: null,
      sourceFindingId: finding.fingerprint,
      origin: "static",
      title: finding.title,
      severity: finding.severity,
      summary: rule?.description ?? finding.title,
      rootCause: finding.notes.join("\n") || rule?.description || finding.title,
      attackPath: evidence
        .map((item) => `${item.location.path}:${item.location.line}: ${item.message}`)
        .join("\n"),
      validation:
        "Static rule indication. Review the cited source; no runtime validation was performed.",
      remediation:
        rule?.remediation ??
        "Inspect the source and confirm the root cause before applying a focused fix.",
      evidence: evidence.slice(0, 8).map((item) => ({
        path: item.location.path,
        line: item.location.line,
        endLine: item.location.endLine,
        message: item.message,
        snippet: item.snippet ?? "",
      })),
    };
  });
  const earlier = previous.filter(
    (item) => item.origin === "ai" && item.repositoryId === job.repositoryId,
  );
  const claimed = new Set<string>();
  for (const review of reviews) {
    if (review.status !== "completed") continue;
    for (const finding of review.findings) {
      if (finding.validation === "dismissed") continue;
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            finding.category,
            finding.title.toLowerCase().trim(),
            [...new Set(finding.evidence.map((item) => item.path))].sort(),
          ]),
        )
        .digest("hex");
      const exact = id(`ai:${fingerprint}`);
      const match =
        earlier.find((item) => item.id === exact && !claimed.has(item.id)) ??
        earlier.find(
          (item) =>
            !claimed.has(item.id) &&
            item.category === finding.category &&
            item.evidence.some((saved) =>
              finding.evidence.some(
                (cite) =>
                  cite.path === saved.path &&
                  cite.line <= saved.endLine &&
                  saved.line <= cite.endLine,
              ),
            ),
        );
      const identity = match ? match.id : exact;
      claimed.add(identity);
      findings.push({
        ...common,
        id: identity,
        fingerprint: match ? match.fingerprint : fingerprint,
        reviewId: review.id,
        sourceFindingId: finding.id,
        origin: "ai",
        category: finding.category,
        title: finding.title,
        severity: finding.severity,
        summary: finding.impact,
        rootCause: finding.description,
        attackPath: [
          ...finding.evidence.map((cite) => `${cite.path}:${cite.line}: ${cite.message}`),
          ...finding.preconditions.map((item) => `Precondition: ${item}`),
        ].join("\n"),
        validation: `${finding.validation}: ${finding.validationReason}\nSource analysis only. No runtime validation was performed.`,
        remediation: finding.mitigation,
        evidence: finding.evidence.map((cite) => ({
          path: cite.path,
          line: cite.line,
          endLine: cite.endLine,
          message: cite.message,
          snippet: cite.snippet,
        })),
      });
    }
  }
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()];
}

/**
 * Saved static findings that a later complete static scan no longer reports. Static rules
 * are deterministic, so their absence means the code changed. A truncated or empty scan,
 * or a finding in a file the scan skipped, proves nothing. AI findings are never resolved
 * by absence: a review covers one source batch and can miss an issue it reported before.
 */
export function vanishedStaticFindings(
  previous: readonly SecurityFinding[],
  current: readonly SecurityFinding[],
  result: ScanResult,
): string[] {
  if (result.truncated || !result.files.length) return [];
  const present = new Set(current.map((finding) => finding.id));
  const skipped = new Set(result.skipped.map((file) => file.path));
  return previous
    .filter(
      (finding) =>
        finding.origin === "static" &&
        !present.has(finding.id) &&
        !finding.evidence.some((cite) => skipped.has(cite.path)),
    )
    .map((finding) => finding.id);
}
