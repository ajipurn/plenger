/**
 * The report: a scan result with its findings reviewed against a baseline and
 * suppressions. Shared by every output format, the CLI, the GitHub action, the
 * dashboard and the red-team commands, so its shape is versioned (`schemaVersion`)
 * and described by report/schema.ts.
 */

import type { Inventory, Location, TraceGaps } from "../inventory/model.ts";
import { type Finding, RULES, type Rule, type Severity } from "../rules/index.ts";
import { SEVERITIES } from "../rules/model.ts";
import type { ScanResult } from "../scan.ts";
import { VERSION } from "../shared/runtime.ts";
import { redactReport } from "../shared/secrets.ts";
import { routeLabel } from "../shared/text.ts";
import { type Baseline, matchesSuppression, type Suppression } from "./policy.ts";

/** Tools and entry points whose handler trace stopped short, for every coverage section. */
export function incompleteTraces(
  inventory: Inventory,
): { name: string; location: Location; trace: TraceGaps }[] {
  return [
    ...inventory.tools.flatMap((tool) =>
      tool.trace ? [{ name: `tool ${tool.name}`, location: tool.location, trace: tool.trace }] : [],
    ),
    ...inventory.entryPoints.flatMap((entry) =>
      entry.trace
        ? [{ name: `route ${routeLabel(entry)}`, location: entry.location, trace: entry.trace }]
        : [],
    ),
  ];
}

export interface ReportFinding extends Finding {
  baselineState?: "new" | "unchanged";
  /** `inSource` for a `plenger-ignore` comment; absent for a suppression file entry. */
  suppression?: { reason: string; inSource?: true };
}

export interface Report extends Omit<ScanResult, "findings"> {
  schemaVersion: 1;
  tool: { name: "plenger"; version: string };
  findings: ReportFinding[];
  rules: Rule[];
  review: { active: number; suppressed: number; unchanged: number; new: number };
}

/** Reviews a scan result. A suppression file entry wins over a `plenger-ignore` comment. */
export function createReport(
  result: ScanResult,
  policy: { baseline?: Baseline; suppressions?: Suppression[] } = {},
): Report {
  const baseline = new Map(policy.baseline?.findings.map((item) => [item.fingerprint, item]));
  const findings: ReportFinding[] = result.findings.map((finding) => {
    const previous = baseline.get(finding.fingerprint);
    const unchanged = previous?.rule === finding.rule && previous.path === finding.location.path;
    const suppression = policy.suppressions?.find((item) => matchesSuppression(item, finding));
    const comment = finding.inline;
    return {
      ...finding,
      ...(policy.baseline ? ({ baselineState: unchanged ? "unchanged" : "new" } as const) : {}),
      ...(suppression
        ? { suppression: { reason: suppression.reason } }
        : comment
          ? {
              suppression: {
                reason: comment.reason || `plenger-ignore comment at line ${comment.line}`,
                inSource: true as const,
              },
            }
          : {}),
    };
  });
  const fired = new Set(findings.map((finding) => finding.rule));
  const report: Report = {
    schemaVersion: 1,
    tool: { name: "plenger", version: VERSION },
    ...result,
    findings,
    rules: RULES.filter((rule) => fired.has(rule.id)),
    review: {
      active: findings.filter((finding) => !finding.suppression).length,
      suppressed: findings.filter((finding) => finding.suppression).length,
      unchanged: findings.filter((finding) => finding.baselineState === "unchanged").length,
      new: findings.filter((finding) => finding.baselineState !== "unchanged").length,
    },
  };
  // Policy reasons are user-provided text and may contain credentials too.
  redactReport(report);
  return report;
}

export type FailOn = Severity | "none";

export function failsGate(report: Report, threshold: FailOn): boolean {
  if (threshold === "none") return false;
  const rank = SEVERITIES.indexOf(threshold);
  return report.findings.some(
    (finding) =>
      !finding.suppression &&
      finding.baselineState !== "unchanged" &&
      SEVERITIES.indexOf(finding.severity) <= rank,
  );
}

export function activeFindings(report: Report): ReportFinding[] {
  return report.findings.filter((finding) => !finding.suppression);
}

/**
 * The report without its suppressed findings, for tools that do not honour SARIF
 * suppressions (GitHub code scanning shows them as open alerts). `review` still counts
 * them, and `rules` keeps only the rules that have findings left.
 */
export function withoutSuppressed(report: Report): Report {
  const findings = activeFindings(report);
  const fired = new Set(findings.map((finding) => finding.rule));
  return { ...report, findings, rules: report.rules.filter((rule) => fired.has(rule.id)) };
}
