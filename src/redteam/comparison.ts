import { compareStrings } from "../shared/compare.ts";
import { redact, redactReport } from "../shared/secrets.ts";
import { evaluateCampaignGate, summarizeCampaign } from "./campaign-evidence.ts";
import type { CampaignGate, CampaignReport, CaseStatistics } from "./campaign-model.ts";
import { COMPARISON_MIN_EVALUABLE } from "./constants.ts";

export interface TaskCompletion {
  planned: number;
  passed: number;
  failed: number;
  missing: number;
  /** Verified task completion / planned tasks; missing evidence remains visible. */
  rate: number;
}
export interface CampaignComparison {
  schemaVersion: 1;
  kind: "redteam-comparison";
  before: { id: string; sourceDigest: string; build: string | null };
  after: { id: string; sourceDigest: string; build: string | null };
  change: string;
  compatible: boolean;
  eligible: boolean;
  reasons: string[];
  changes: string[];
  assumptions: string[];
  cases: {
    caseId: string;
    before: CaseStatistics | null;
    after: CaseStatistics | null;
    eligible: boolean;
    /** Descriptive difference; not a significance test. Null when comparison is invalid. */
    rateChange: number | null;
  }[];
  taskCompletion: { before: TaskCompletion; after: TaskCompletion; change: number | null };
  afterGate: CampaignGate;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const ordered = (values: string[]) => [...values].sort();

/** Verified normal-task completions across runs; missing evidence stays visible. */
function taskCompletion(report: CampaignReport): TaskCompletion {
  let passed = 0;
  let failed = 0;
  for (const run of report.runs) {
    const control = run.trials.filter((trial) => trial.purpose === "control");
    if (control.length !== 1 || !control[0]?.started || !control[0].completed) continue;
    if (run.cleanControlPassed && control[0].outcome === "not_observed") passed++;
    else failed++;
  }
  return {
    planned: report.plan.repetitions,
    passed,
    failed,
    missing: report.plan.repetitions - passed - failed,
    rate: passed / report.plan.repetitions,
  };
}

function generation(report: CampaignReport) {
  const config = report.plan.providerConfig;
  return config
    ? {
        baseUrl: config.baseUrl,
        temperature: config.temperature,
        maxOutputTokens: config.maxOutputTokens,
      }
    : null;
}

function runtimes(report: CampaignReport) {
  return ordered([...new Set(report.runs.map((run) => canonical(run.runtime ?? null)))]);
}

function fixedScope(report: CampaignReport) {
  return ordered(
    report.plan.scope
      .filter((item) => item.selected)
      .map((item) => JSON.stringify([item.id, item.target, item.caseId, item.supported])),
  );
}

/** Compare fixed campaigns without pooling variants or trusting stored summary totals. */
export function compareCampaigns(
  before: CampaignReport,
  after: CampaignReport,
  change: string,
): CampaignComparison {
  if (
    !change.trim() ||
    change.length > 1000 ||
    Array.from(change).some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("Describe the intended mitigation or build change (1–1000 characters).");
  const reasons: string[] = [];
  const changes: string[] = [];
  if (before.id === after.id) reasons.push("Choose two different campaigns.");
  if (before.plan.profile !== after.plan.profile || before.plan.target !== after.plan.target)
    reasons.push("Runtime profile or target changed.");
  if (before.plan.provider !== after.plan.provider || before.plan.model !== after.plan.model)
    reasons.push("Provider or model changed; a model change is not a mitigation comparison.");
  if (!generation(before) || !generation(after))
    reasons.push("Saved generation settings are unavailable in one or both campaigns.");
  else if (!same(generation(before), generation(after)))
    reasons.push("Provider endpoint, temperature or output allowance changed.");
  const cases = (report: CampaignReport) =>
    [...report.plan.cases].sort((a, b) => compareStrings(a.id, b.id));
  if (!same(cases(before), cases(after)))
    reasons.push("Selected cases, versions, boundaries or oracles changed.");
  if (
    !same(fixedScope(before), fixedScope(after)) ||
    !same(ordered(before.plan.requiredScope), ordered(after.plan.requiredScope))
  )
    reasons.push("Selected or required test scope changed.");
  if (before.plan.scopeIncomplete !== after.plan.scopeIncomplete)
    changes.push(
      "Discovery completeness changed; unknown surfaces are not represented in the denominator.",
    );
  if (!same(before.plan.limits, after.plan.limits))
    reasons.push("Call, token or deadline limits changed.");
  if (
    before.runs.some((run) => !run.runtime) ||
    after.runs.some((run) => !run.runtime) ||
    !before.runs.length ||
    !after.runs.length
  )
    reasons.push("Verified runtime provenance is unavailable in one or both campaigns.");
  else if (!same(runtimes(before), runtimes(after)) || runtimes(before).length !== 1)
    reasons.push("Runtime image or adapter versions changed or varied within a campaign.");
  if (before.plan.sourceDigest !== after.plan.sourceDigest)
    changes.push("Source snapshot changed.");
  if (before.plan.build !== after.plan.build) changes.push("Build identifier changed.");
  if (before.plan.repetitions !== after.plan.repetitions)
    changes.push("Planned sample counts differ; each build must still meet the minimum.");
  if (!same(before.plan.policy, after.plan.policy))
    changes.push("CI gate or suppression policy changed; it does not change attack evidence.");
  const compatible = reasons.length === 0;
  for (const [label, report] of [
    ["Before", before],
    ["After", after],
  ] as const) {
    if (
      report.state !== "completed" ||
      report.runs.length !== report.plan.repetitions ||
      report.runs.some((run) => !run.cleanupConfirmed || run.state !== "completed")
    )
      reasons.push(`${label}: campaign completion and cleanup were not established.`);
    const workers = report.runs.flatMap((run) =>
      run.trials.filter((trial) => trial.started).map((trial) => trial.workerName),
    );
    if (workers.some((name) => !name) || new Set(workers).size !== workers.length)
      reasons.push(`${label}: independent fresh workers were not established.`);
    if (taskCompletion(report).passed < COMPARISON_MIN_EVALUABLE)
      reasons.push(
        `${label}: at least ${COMPARISON_MIN_EVALUABLE} successful normal tasks are required for a comparison.`,
      );
  }
  const allWorkers = [before, after]
    .flatMap((report) =>
      report.runs.flatMap((run) =>
        run.trials.filter((trial) => trial.started).map((trial) => trial.workerName),
      ),
    )
    .filter((name) => !!name);
  if (new Set(allWorkers).size !== allWorkers.length)
    reasons.push(
      "Worker identities overlap within or between campaigns; trial independence is unverified.",
    );
  const left = summarizeCampaign(before),
    right = summarizeCampaign(after);
  const caseIds = ordered([...new Set([...left, ...right].map((item) => item.caseId))]);
  const complete = reasons.length === 0;
  const comparisons = caseIds.map((caseId) => {
    const a = left.find((item) => item.caseId === caseId) ?? null;
    const b = right.find((item) => item.caseId === caseId) ?? null;
    const eligible = complete && !!a?.comparisonEligible && !!b?.comparisonEligible;
    if (!a?.comparisonEligible || !b?.comparisonEligible)
      reasons.push(
        `${caseId}: at least ${COMPARISON_MIN_EVALUABLE} usable trials are required in each build.`,
      );
    return {
      caseId,
      before: a,
      after: b,
      eligible,
      rateChange:
        eligible && a?.rate !== null && b?.rate !== null ? (b?.rate ?? 0) - (a?.rate ?? 0) : null,
    };
  });
  const beforeTask = taskCompletion(before),
    afterTask = taskCompletion(after);
  const comparison: CampaignComparison = {
    schemaVersion: 1,
    kind: "redteam-comparison",
    before: { id: before.id, sourceDigest: before.plan.sourceDigest, build: before.plan.build },
    after: { id: after.id, sourceDigest: after.plan.sourceDigest, build: after.plan.build },
    change: redact(change.trim()),
    compatible,
    eligible: reasons.length === 0,
    reasons,
    changes,
    assumptions: [
      "Fresh sessions and disposable resources are assumed to produce independent trials.",
      "A model identifier does not pin hosted weights or a provider revision; model drift is not measured.",
      "Exported evidence is not a signed attestation.",
    ],
    cases: comparisons,
    taskCompletion: {
      before: beforeTask,
      after: afterTask,
      change: compatible ? afterTask.rate - beforeTask.rate : null,
    },
    afterGate: evaluateCampaignGate(after),
  };
  redactReport(comparison);
  return comparison;
}
