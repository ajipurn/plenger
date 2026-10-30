import { createHash } from "node:crypto";
import type { SecurityReview } from "../assessment/review-model.ts";
import { sameCandidatePath } from "../assessment/review-static.ts";
import type { Rule } from "../rules/model.ts";
import type { ScanResult } from "../scan.ts";
import type { FindingProvenance, SecurityFinding, SecurityScan } from "./model.ts";

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
  const staticReviews = reviews.flatMap((review) =>
    (review.staticFindings ?? []).map((finding) => ({ review, finding })),
  );
  const nodes = new Map<string, SecurityFinding>();
  const findings: SecurityFinding[] = result.findings.map((finding) => {
    const rule = rules.find((item) => item.id === finding.rule);
    const evidence = finding.evidence.length
      ? finding.evidence
      : [{ location: finding.location, message: finding.title, snippet: finding.snippet }];
    const checked = staticReviews.findLast(
      (item) => item.finding.static.fingerprint === finding.fingerprint,
    );
    const verdict = checked?.finding.validation ?? "unvalidated";
    const reason =
      checked?.finding.validationReason ??
      (job.workflow === "static"
        ? "AI discovery and validation have not been run."
        : job.error
          ? `AI review did not complete. ${job.error}`
          : "This static candidate was not validated within this scan's source, candidate or spending limits.");
    const identity = id(`static:${finding.fingerprint}`);
    const saved = previous.find(
      (item) =>
        item.id === identity ||
        item.aliases?.includes(identity) ||
        item.provenance?.some(
          (entry) => entry.origin === "static" && entry.sourceFindingId === finding.fingerprint,
        ),
    );
    const normalized: SecurityFinding = {
      ...common,
      id: saved?.id ?? identity,
      fingerprint: finding.fingerprint,
      reviewId: null,
      sourceFindingId: finding.fingerprint,
      origin: "static",
      ...(rule?.cwe[0] === undefined ? {} : { cwe: `CWE-${rule.cwe[0]}` }),
      title: finding.title,
      severity: finding.severity,
      summary: rule?.description ?? finding.title,
      rootCause: finding.notes.join("\n") || rule?.description || finding.title,
      attackPath: evidence
        .map((item) => `${item.location.path}:${item.location.line}: ${item.message}`)
        .join("\n"),
      validationStatus: verdict,
      validation: `${verdict}: ${reason}\nSource analysis only. No runtime validation was performed.`,
      remediation:
        rule?.remediation ??
        "Inspect the source and confirm the root cause before applying a focused fix.",
      evidence: evidence.map((item) => ({
        path: item.location.path,
        line: item.location.line,
        endLine: item.location.endLine,
        message: item.message,
        snippet: item.snippet ?? "",
      })),
    };
    normalized.provenance = [
      {
        origin: "static",
        sourceScanId: common.sourceScanId,
        sourceFindingId: finding.fingerprint,
        ruleId: finding.rule,
        reviewId: checked?.review.id ?? null,
        evidence: normalized.evidence,
        ...(checked ? { review: reviewRecord(checked.finding) } : {}),
      },
    ];
    if (saved) inherit(normalized, saved);
    if (checked) nodes.set(checked.finding.id, normalized);
    return normalized;
  });
  const earlier = previous.filter(
    (item) =>
      (item.origin === "ai" || item.provenance?.some((entry) => entry.origin === "ai")) &&
      item.repositoryId === job.repositoryId,
  );
  const claimed = new Set(findings.map((finding) => finding.id));
  for (const review of reviews) {
    if (review.status !== "completed") continue;
    for (const finding of review.findings) {
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
      const normalized: SecurityFinding = {
        ...common,
        id: identity,
        fingerprint: match ? match.fingerprint : fingerprint,
        reviewId: review.id,
        sourceFindingId: finding.id,
        origin: "ai",
        category: finding.category,
        // Reviews saved before the CWE field have none.
        ...(finding.cwe ? { cwe: finding.cwe } : {}),
        title: finding.title,
        severity: finding.severity,
        summary: finding.impact,
        rootCause: finding.description,
        attackPath: [
          ...finding.evidence.map((cite) => `${cite.path}:${cite.line}: ${cite.message}`),
          ...finding.preconditions.map((item) => `Precondition: ${item}`),
        ].join("\n"),
        validationStatus: finding.validation,
        validation: `${finding.validation}: ${finding.validationReason}\nSource analysis only. No runtime validation was performed.`,
        remediation: finding.mitigation,
        evidence: finding.evidence.map((cite) => ({
          path: cite.path,
          line: cite.line,
          endLine: cite.endLine,
          message: cite.message,
          snippet: cite.snippet,
        })),
      };
      normalized.provenance = [
        {
          origin: "ai",
          sourceScanId: common.sourceScanId,
          sourceFindingId: finding.id,
          reviewId: review.id,
          evidence: normalized.evidence,
          review: reviewRecord(finding),
        },
      ];
      if (match) inherit(normalized, match);
      nodes.set(finding.id, normalized);
      findings.push(normalized);
    }
  }
  const removed = new Set<SecurityFinding>();
  for (const review of reviews) {
    const candidates = [...review.findings, ...(review.staticFindings ?? [])];
    for (const candidate of candidates) {
      const target = candidates.find((item) => item.id === candidate.dismissal?.duplicateOf);
      if (
        !target ||
        !("static" in candidate || "static" in target) ||
        candidate.validation !== "dismissed" ||
        !sameCandidatePath(candidate, target)
      )
        continue;
      const duplicate = nodes.get(candidate.id);
      const kept = nodes.get(target.id);
      if (!duplicate || !kept || duplicate === kept || removed.has(duplicate) || removed.has(kept))
        continue;
      const canonical = duplicate.origin === "static" ? duplicate : kept;
      const other = canonical === duplicate ? kept : duplicate;
      if (other.category && !canonical.category) canonical.category = other.category;
      canonical.validationStatus = kept.validationStatus ?? "unvalidated";
      canonical.validation = kept.validation;
      const provenance = [...(canonical.provenance ?? []), ...(other.provenance ?? [])];
      canonical.provenance = mergeProvenance(
        provenance.filter((entry) => entry.sourceScanId === common.sourceScanId),
        provenance.filter((entry) => entry.sourceScanId !== common.sourceScanId),
      );
      if (other.mergedTriage)
        canonical.mergedTriage = [...(canonical.mergedTriage ?? []), ...other.mergedTriage];
      canonical.aliases = [
        ...new Set([...(canonical.aliases ?? []), other.id, ...(other.aliases ?? [])]),
      ].filter((alias) => alias !== canonical.id);
      canonical.evidence = [
        ...new Map(
          [...canonical.evidence, ...other.evidence].map((cite) => [JSON.stringify(cite), cite]),
        ).values(),
      ];
      removed.add(other);
    }
  }
  return [
    ...new Map(
      findings
        .filter(
          (finding) =>
            !removed.has(finding) &&
            (finding.origin === "static" || finding.validationStatus !== "dismissed"),
        )
        .map((finding) => [finding.id, finding]),
    ).values(),
  ];
}

function reviewRecord(
  finding: NonNullable<FindingProvenance["review"]>,
): NonNullable<FindingProvenance["review"]> {
  return {
    id: finding.id,
    validation: finding.validation,
    validationReason: finding.validationReason,
    ...(finding.dismissal ? { dismissal: finding.dismissal } : {}),
  };
}
function mergeProvenance(
  current: FindingProvenance[],
  previous: FindingProvenance[],
): FindingProvenance[] {
  return [
    ...current,
    ...previous.filter(
      (entry) =>
        !current.some((item) => item.origin === entry.origin && item.ruleId === entry.ruleId),
    ),
  ];
}
function inherit(current: SecurityFinding, saved: SecurityFinding): void {
  current.aliases = [...new Set([...(current.aliases ?? []), ...(saved.aliases ?? [])])];
  if (saved.mergedTriage) current.mergedTriage = saved.mergedTriage;
  current.provenance = mergeProvenance(current.provenance ?? [], saved.provenance ?? []);
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
        !finding.provenance?.some((item) => item.origin === "ai") &&
        !present.has(finding.id) &&
        !finding.evidence.some((cite) => skipped.has(cite.path)),
    )
    .map((finding) => finding.id);
}
