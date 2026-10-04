import { markdownText } from "../report/format.ts";
import { escapeMarkdownLines, percent } from "./campaign-report.ts";
import type { CampaignComparison } from "./comparison.ts";

export type ComparisonFormat = "terminal" | "json" | "markdown";

const delta = (value: number | null) =>
  value === null ? "not qualified" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)} pp`;

/** Render a campaign comparison; descriptive rates are never presented as significance. */
export function formatComparison(report: CampaignComparison, format: ComparisonFormat): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  const lines = [
    "Plenger red-team comparison",
    `Intended change: ${report.change}`,
    `Before: ${report.before.id} · ${report.before.build ?? report.before.sourceDigest}`,
    `After: ${report.after.id} · ${report.after.build ?? report.after.sourceDigest}`,
    `Comparison: ${report.eligible ? "eligible" : "not qualified"} · after gate exit ${report.afterGate.exitCode}`,
    "",
  ];
  const rows = report.cases.map((item) => [
    item.caseId,
    `${percent(item.before?.rate ?? null)} (${item.before?.evaluable ?? 0} usable)`,
    `${percent(item.after?.rate ?? null)} (${item.after?.evaluable ?? 0} usable)`,
    delta(item.rateChange),
  ]);
  if (format === "markdown") {
    lines[0] = `# ${lines[0]}`;
    lines.push(
      "| Case | Before | After | Descriptive change |",
      "| --- | --- | --- | --- |",
      ...rows.map((row) => `| ${row.map(markdownText).join(" | ")} |`),
    );
  } else
    lines.push(
      ...rows.map(([id, before, after, change]) => `${id}: ${before} → ${after}; ${change}`),
    );
  for (const [label, task] of [
    ["Before", report.taskCompletion.before],
    ["After", report.taskCompletion.after],
  ] as const)
    lines.push(
      `${label} normal task: ${task.passed}/${task.planned} verified complete · ${task.failed} failed · ${task.missing} missing evidence.`,
    );
  lines.push(
    `Verified task completion change: ${delta(report.taskCompletion.change)}`,
    "",
    "Descriptive rates and Wilson intervals do not establish statistical significance. A lower violation rate does not prove safety; review task completion and missing evidence.",
  );
  lines.push(
    ...report.changes.map((message) => `Change: ${message}`),
    ...report.assumptions.map((message) => `Assumption: ${message}`),
    ...report.reasons.map((message) => `Not qualified: ${message}`),
    ...report.afterGate.reasons.map((item) => `After gate ${item.kind}: ${item.message}`),
  );
  if (format === "markdown") escapeMarkdownLines(lines);
  return `${lines.join("\n")}\n`;
}
