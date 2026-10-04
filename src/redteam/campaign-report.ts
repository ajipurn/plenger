import { markdownText } from "../report/format.ts";
import { VERSION } from "../shared/runtime.ts";
import {
  backendObservations,
  type CampaignReport,
  evaluateCampaignGate,
  summarizeCampaign,
  summarizeScope,
} from "./campaign.ts";
import { COMPARISON_MIN_EVALUABLE } from "./constants.ts";

export type CampaignFormat = "terminal" | "json" | "markdown" | "sarif";

/** A rate as a percentage with one decimal; null rates are unknown, never zero. */
export function percent(value: number | null): string {
  return value === null ? "unknown" : `${(value * 100).toFixed(1)}%`;
}

/** Escape free-form text (model names, target IDs, reasons) in every non-table line after the title. */
export function escapeMarkdownLines(lines: string[]): void {
  for (let index = 1; index < lines.length; index++)
    if (!lines[index]?.startsWith("|"))
      lines[index] = lines[index]?.startsWith("- ")
        ? `- ${markdownText(lines[index]?.slice(2) ?? "")}`
        : markdownText(lines[index] ?? "");
}

export function formatCampaign(report: CampaignReport, format: CampaignFormat): string {
  const statistics = summarizeCampaign(report);
  const gate = evaluateCampaignGate(report);
  const scope = summarizeScope(report);
  if (format === "json") return `${JSON.stringify({ ...report, statistics, gate }, null, 2)}\n`;
  if (format === "sarif") return `${JSON.stringify(campaignSarif(report), null, 2)}\n`;
  const lines = [
    `Plenger red-team campaign · ${report.state}`,
    `${report.plan.provider} · ${report.plan.model} · ${report.plan.profile}`,
    `Target: ${report.plan.target}`,
    `Source: ${report.plan.sourceDigest}`,
    `Repetitions: ${report.runs.length}/${report.plan.repetitions} · clean task passed: ${report.runs.filter((run) => run.cleanControlPassed).length}/${report.plan.repetitions}`,
    `Gate: ${gate.exitCode === 0 ? "passed" : "failed"} · exit ${gate.exitCode}`,
    `Discovered scope: ${scope.exercised}/${scope.discovered} surfaces exercised · ${scope.unsupported} unsupported${scope.incomplete ? " · discovery incomplete/unknown; omitted surfaces are not covered" : " · unknown surfaces outside discovery are not covered"}`,
    "",
  ];
  const rows = statistics.map((item) => {
    const rate = percent(item.rate);
    const interval = item.interval
      ? `${(item.interval.low * 100).toFixed(1)}–${(item.interval.high * 100).toFixed(1)}%`
      : "unknown";
    const counts = item.counts;
    return [
      item.caseId,
      `${item.evaluable}/${item.planned}`,
      String(counts.violation_observed),
      rate,
      interval,
      `${counts.inconclusive} / ${counts.error} / ${counts.skipped}`,
    ];
  });
  if (format === "markdown") {
    lines[0] = `# ${lines[0]}`;
    lines.push(
      "| Case | Evaluable | Observed | Rate | 95% Wilson interval | Inconclusive / error / skipped |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows.map((row) => `| ${row.map(markdownText).join(" | ")} |`),
    );
  } else {
    lines.push(
      ...rows.map(
        ([id, n, count, rate, interval, missing]) =>
          `${id}: ${count} observed · ${n} evaluable · ${rate} [95% Wilson ${interval}] · ${missing} inconclusive/error/skipped`,
      ),
    );
  }
  lines.push(
    "",
    "Rates include only observed violations and completed negative trials with a passing clean control. Missing evidence never counts as a negative result.",
    `Comparisons require at least ${COMPARISON_MIN_EVALUABLE} evaluable trials per case, per build. This result covers the selected runtime profile and listed scope.`,
  );
  if (report.budget)
    lines.push(
      `Model calls: ${report.budget.callsAdmitted}/${report.plan.limits.maxModelCalls} · accounted tokens: ${report.budget.accountedTokens}/${report.plan.limits.maxTokens}`,
    );
  for (const item of report.plan.cases) {
    const count = backendObservations(report, item.id);
    if (count)
      lines.push(
        `${item.id}: ${count} boundary violation(s) in direct handler validation, without a model. These do not enter the model success-rate denominator.`,
      );
  }
  lines.push(
    "",
    "Scope:",
    ...report.plan.scope.map(
      (item) =>
        `- ${item.id} · ${item.kind ?? "input"} · ${item.label ?? item.target} · ${item.caseId}: ${item.selected && item.supported ? "selected" : (item.reason ?? "not selected")}`,
    ),
  );
  if (gate.reasons.length)
    lines.push(
      "",
      "Gate reasons:",
      ...gate.reasons.map((item) => `- ${item.kind}: ${item.message}`),
    );
  if (report.plan.policy.suppressions.length)
    lines.push(
      "",
      "Suppressions (coverage and scope still apply):",
      ...report.plan.policy.suppressions.map((item) => `- ${item.caseId}: ${item.reason}`),
    );
  if (format === "markdown") escapeMarkdownLines(lines);
  return `${lines.join("\n")}\n`;
}

function campaignSarif(report: CampaignReport) {
  const statistics = summarizeCampaign(report);
  const gate = evaluateCampaignGate(report);
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "plenger-redteam",
            version: VERSION,
            rules: report.plan.cases.map((item) => ({
              id: item.id,
              shortDescription: { text: item.title },
              fullDescription: { text: item.rationale },
              properties: {
                severity: item.severity,
                caseVersion: item.version,
                oracle: item.oracle,
              },
            })),
          },
        },
        results: statistics
          .filter(
            (item) =>
              item.counts.violation_observed > 0 || backendObservations(report, item.caseId) > 0,
          )
          .map((item) => {
            const securityCase = report.plan.cases.find((value) => value.id === item.caseId);
            const suppression = report.plan.policy.suppressions.find(
              (value) => value.caseId === item.caseId,
            );
            return {
              ruleId: item.caseId,
              level:
                securityCase?.severity === "low"
                  ? "note"
                  : securityCase?.severity === "medium"
                    ? "warning"
                    : "error",
              message: {
                text: `${item.counts.violation_observed} model violation(s) in ${item.evaluable} evaluable trials of ${item.planned} planned; ${backendObservations(report, item.caseId)} direct handler boundary violation(s).`,
              },
              partialFingerprints: {
                "plengerRedteam/v1": `${report.plan.target}:${item.caseId}:v${securityCase?.version}`,
              },
              properties: {
                sourceDigest: report.plan.sourceDigest,
                target: report.plan.target,
                backendObservations: backendObservations(report, item.caseId),
                ...item,
              },
              ...(suppression
                ? {
                    suppressions: [
                      { kind: "external", justification: suppression.reason, status: "accepted" },
                    ],
                  }
                : {}),
            };
          }),
        invocations: [
          {
            executionSuccessful: !gate.reasons.some((item) => item.kind !== "finding"),
            properties: {
              campaignState: report.state,
              gate,
              plannedScope: report.plan.scope,
              requiredScope: report.plan.requiredScope,
              discoveredScope: summarizeScope(report),
              statistics,
            },
            ...(gate.reasons.some((item) => item.kind !== "finding")
              ? {
                  toolExecutionNotifications: gate.reasons
                    .filter((item) => item.kind !== "finding")
                    .map((item) => ({ level: "error", message: { text: item.message } })),
                }
              : {}),
          },
        ],
      },
    ],
  };
}
