import { json } from "../shared/json.ts";
import type { AssessmentEvidence, AssessmentReport } from "./model.ts";

/** Model text is escaped before Markdown rendering. JSON preserves the report data. */
export function formatAssessment(report: AssessmentReport, format: "json" | "markdown"): string {
  if (format === "json") return json(report);
  const lines = [
    "# Security assessment",
    "",
    `${escapeMarkdown(report.provider.model)} · ${report.status} · read-only`,
    "",
    escapeMarkdown(report.summary),
    "",
    `Scope: ${report.scope.files.length} of ${report.scope.scannedFiles} scanned files submitted; ${report.scope.omittedFiles} omitted; ${report.scope.skippedFiles} skipped.`,
    `Context: ${report.scope.contextDigest}`,
    "",
  ];
  if (report.scope.partial) lines.push("Coverage is partial.", "");
  if (report.reason) lines.push(escapeMarkdown(report.reason), "");
  for (const [heading, entities] of [
    ["Assets", report.assets],
    ["Trust boundaries", report.trustBoundaries],
  ] as const) {
    lines.push(`## ${heading}`, "");
    for (const item of entities)
      lines.push(
        `- **${escapeMarkdown(item.name)}**: ${escapeMarkdown(item.description)} (${evidence(item.evidence)})`,
      );
    if (!entities.length) lines.push("None reported.");
    lines.push("");
  }
  lines.push("## STRIDE threats", "");
  for (const threat of report.threats)
    lines.push(
      `### ${escapeMarkdown(threat.title)}`,
      "",
      `${threat.severity} · ${threat.category}`,
      "",
      `Impact: ${escapeMarkdown(threat.impact)}`,
      "",
      `Evidence: ${evidence(threat.evidence)}`,
      "",
      `Mitigation: ${escapeMarkdown(threat.mitigation)}`,
      "",
    );
  if (!report.threats.length) lines.push("None reported.", "");
  lines.push(
    "## Limitations",
    "",
    ...report.limitations.map((item) => `- ${escapeMarkdown(item)}`),
    "",
    `Model calls: ${report.request.calls}. Accounted tokens: ${report.request.accountedTokens}.`,
    "",
  );
  return lines.join("\n");
}

function evidence(items: AssessmentEvidence[]): string {
  return items.map((item) => `${escapeMarkdown(item.path)}:${item.line}`).join(", ");
}
function escapeMarkdown(text: string): string {
  return text
    .replace(/\p{Cc}/gu, " ")
    .replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] as string)
    .replace(/([\\`*_{}[\]()#!|])/g, "\\$1");
}
