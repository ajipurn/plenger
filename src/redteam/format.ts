import { VERSION } from "../shared/runtime.ts";
import type { DiscoveryReport } from "./discover.ts";
import type { ProjectPlan } from "./plan-model.ts";

/** Terminal rendering of an offline discovery report. */
export function formatDiscovery(report: DiscoveryReport): string {
  const lines = [
    `plenger ${VERSION} · offline red-team discovery`,
    report.root,
    "",
    "No project code was imported or executed. No model was contacted.",
    "Candidates require qualification; dynamic execution is not available yet.",
    "",
  ];
  if (report.targets.length === 0) lines.push("No llmfy targets discovered.");
  for (const target of report.targets) {
    lines.push(
      `${target.status}  ${target.kind}  ${target.symbol ?? "(unresolved)"}  ${target.location.path}:${target.location.line}`,
      `  ${target.id}`,
    );
    if (target.reasons.length) lines.push(`  ${target.reasons.join(", ")}`);
  }
  lines.push("", "Root dependency manifests (presence only):");
  for (const item of report.manifests) lines.push(`  ${item.path}: ${item.status}`);
  if (report.otherFrameworks.length)
    lines.push("", `Other detected frameworks: ${report.otherFrameworks.join(", ")}`);
  lines.push(
    "",
    `${report.scan.files} files scanned; ${report.scan.skipped.length} skipped; ${report.scan.syntaxErrors.length} with syntax errors.`,
  );
  if (report.scan.truncated)
    lines.push("Discovery is incomplete: the scan file limit was reached.");
  for (const item of report.scan.skipped) lines.push(`  skipped ${item.path}: ${item.reason}`);
  lines.push("", "Before execution:", ...report.requirements.map((item) => `  ${item}`));
  return `${lines.join("\n")}\n`;
}

/** Terminal rendering of an offline preparation plan. */
export function formatProjectPlan(plan: ProjectPlan): string {
  const lines = [
    `plenger ${VERSION} · offline project preparation plan`,
    plan.root,
    "",
    `Source preparation: ${plan.preparation.status}`,
    `Target selection: ${plan.selection}${plan.selectedTarget ? ` (${plan.selectedTarget})` : ""}`,
    `Captured runtime sources: ${plan.sources.files.length}; omitted source entries: ${plan.sources.omitted.length}`,
    `Source digest: ${plan.sourceDigest}`,
    "",
  ];
  for (const target of plan.targets)
    lines.push(
      `${target.id}  ${target.status}  ${target.kind}  ${target.symbol ?? "(unresolved)"}  ${target.location.path}:${target.location.line}`,
    );
  lines.push("", `Dependencies: ${plan.dependencies.status}; not resolved or installed.`);
  for (const item of plan.dependencies.packages)
    lines.push(
      `  ${item.name}${item.extras.length ? `[${item.extras.join(",")}]` : ""}${item.constraint} (${item.source})`,
    );
  for (const item of plan.dependencies.issues) lines.push(`  ${item.path}: ${item.reason}`);
  for (const item of plan.sources.omitted) lines.push(`  omitted ${item.path}: ${item.reason}`);
  if (plan.preparation.reasons.length)
    lines.push("", `Needs attention: ${plan.preparation.reasons.join(", ")}`);
  lines.push(
    "",
    "Execution is unavailable; no project code was imported and no model was contacted.",
    ...plan.pending.map((item) => `  ${item}`),
  );
  return `${lines.join("\n")}\n`;
}
