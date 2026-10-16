import { randomUUID } from "node:crypto";
import { SEVERITIES } from "../rules/model.ts";
import { sha256Hex } from "../shared/hash.ts";
import { type BudgetLimits, ModelBudget, validateBudgetLimits } from "./budget.ts";
import { evaluateCampaignGate, summarizeCampaign } from "./campaign-evidence.ts";
import {
  type CampaignPlan,
  type CampaignPolicy,
  type CampaignReport,
  type CampaignScope,
  managedCases,
  type SecurityCase,
} from "./campaign-model.ts";
import { MAX_PROFILE_CASES, MODEL_ID, type ProviderId, REPETITION_RANGE } from "./constants.ts";
import type { ProjectPlan } from "./plan-model.ts";
import type { RunProvider } from "./provider.ts";
import { isProviderId, type ProviderConfig, validateProviderConfig } from "./provider-config.ts";
import { executeRun, interruptRun, isRunActive, newRun, validateRunPlan } from "./run.ts";
import { recordRuntimeCleanupFailure } from "./run-lifecycle.ts";
import { type DisposableRuntime, prepareRunRuntime } from "./runtime.ts";

export {
  backendObservations,
  evaluateCampaignGate,
  summarizeCampaign,
  summarizeScope,
  wilson,
} from "./campaign-evidence.ts";
export type {
  CampaignGate,
  CampaignPlan,
  CampaignPolicy,
  CampaignReport,
  CampaignScope,
  CaseStatistics,
  SecurityCase,
  TrialResult,
} from "./campaign-model.ts";

export function scopeId(target: string, caseId: string): string {
  return `scope:${sha256Hex(JSON.stringify([target, caseId]), 24)}`;
}

const PLAN_KEYS = [
  "schemaVersion",
  "kind",
  "root",
  "target",
  "sourceDigest",
  "profile",
  "provider",
  "model",
  "providerConfig",
  "repetitions",
  "limits",
  "cases",
  "scope",
  "requiredScope",
  "policy",
  "build",
  "scopeIncomplete",
];
const POLICY_KEYS = ["failOn", "minCoverage", "minimumEvaluable", "suppressions"];
const SCOPE_KEYS = [
  "id",
  "target",
  "caseId",
  "supported",
  "selected",
  "reason",
  "kind",
  "label",
  "location",
];
const LOCATION_KEYS = ["path", "line", "column", "endLine", "endColumn"];
const LIMIT_KEYS: (keyof BudgetLimits)[] = ["maxModelCalls", "maxTokens", "timeoutMs"];

export interface CampaignSettings {
  provider: ProviderId;
  model: string;
  providerConfig?: ProviderConfig;
  limits: BudgetLimits;
  repetitions?: number;
  caseIds?: string[];
  policy?: Partial<CampaignPolicy>;
  requiredScope?: string[];
  build?: string;
}

/** A fixed campaign plan: the selected target's cases plus every discovered surface as scope. */
export function createCampaignPlan(project: ProjectPlan, settings: CampaignSettings): CampaignPlan {
  validateRunPlan(project);
  if (!project.selectedTarget) throw new Error("Select a test target.");
  const profile = project.nextProfile?.id ?? "llmfy-file-canary-v1";
  const available = managedCases(profile);
  const selected = settings.caseIds ?? available.map((item) => item.id);
  if (
    selected.some((id) => !available.some((item) => item.id === id)) ||
    new Set(selected).size !== selected.length
  )
    throw new Error("Select distinct cases supported by this runtime profile.");
  const scope: CampaignScope[] = project.targets.flatMap((target) =>
    available.map((item) => ({
      id: scopeId(target.id, item.id),
      target: target.id,
      caseId: item.id,
      supported: target.id === project.selectedTarget,
      selected: target.id === project.selectedTarget && selected.includes(item.id),
      reason:
        target.id === project.selectedTarget
          ? null
          : target.status === "unsupported"
            ? target.reasons.join(", ")
            : "Target has not been prepared for this profile.",
      kind: "input" as const,
      label: target.symbol ?? target.id,
      location: { ...target.location },
    })),
  );
  for (const surface of project.coverage?.surfaces ?? []) {
    // The prepared callable/route already has case-specific input entries above.
    if (
      surface.kind === "input" &&
      project.targets.some(
        (target) =>
          target.location.path === surface.location.path &&
          target.location.line === surface.location.line,
      )
    )
      continue;
    for (const caseId of surfaceScenarios(surface.kind))
      scope.push({
        id: scopeId(surface.id, caseId),
        target: surface.id,
        caseId,
        supported: false,
        selected: false,
        reason:
          "No qualified delivery and observation adapter for this surface/scenario in the selected profile.",
        kind: surface.kind,
        label: surface.label,
        location: { ...surface.location },
      });
  }
  const plan: CampaignPlan = {
    schemaVersion: 1,
    kind: "redteam-campaign-plan",
    root: project.root,
    target: project.selectedTarget,
    sourceDigest: project.sourceDigest,
    profile,
    provider: settings.provider,
    model: settings.model,
    ...(settings.providerConfig
      ? { providerConfig: structuredClone(settings.providerConfig) }
      : {}),
    limits: { ...settings.limits },
    repetitions: settings.repetitions ?? 1,
    cases: available.filter((item) => selected.includes(item.id)),
    scope,
    requiredScope:
      settings.requiredScope ?? scope.filter((item) => item.selected).map((item) => item.id),
    policy: {
      failOn: "high",
      minCoverage: 1,
      minimumEvaluable: 1,
      suppressions: [],
      ...settings.policy,
    },
    build: settings.build ?? null,
    scopeIncomplete: project.coverage?.incomplete ?? true,
  };
  validateCampaignPlan(plan);
  return plan;
}

/** Unsupported surfaces are recorded under the scenarios a future adapter would need. */
function surfaceScenarios(kind: CampaignScope["kind"]): string[] {
  switch (kind) {
    case "retrieval":
      return ["retrieval-context", "retrieval-index"];
    case "tool":
      return ["tool-boundary", "tool-output"];
    case "mcp":
      return ["mcp-contract", "mcp-content"];
    case "web":
      return ["web-content"];
    default:
      return ["direct-input"];
  }
}

/** Validate before any runtime preparation or model access. Built-in oracle metadata is immutable. */
export function validateCampaignPlan(plan: CampaignPlan): void {
  if (
    plan?.kind !== "redteam-campaign-plan" ||
    plan.schemaVersion !== 1 ||
    typeof plan.root !== "string" ||
    !plan.root ||
    typeof plan.target !== "string" ||
    !plan.target ||
    !/^[a-f0-9]{64}$/.test(plan.sourceDigest) ||
    !["llmfy-file-canary-v1", "vercel-booking-sqlite-v1"].includes(plan.profile) ||
    !isProviderId(plan.provider) ||
    typeof plan.model !== "string" ||
    !MODEL_ID.test(plan.model) ||
    plan.model.includes("://") ||
    !Number.isInteger(plan.repetitions) ||
    plan.repetitions < REPETITION_RANGE.min ||
    plan.repetitions > REPETITION_RANGE.max ||
    !Array.isArray(plan.cases) ||
    !plan.cases.length ||
    plan.cases.length > MAX_PROFILE_CASES
  )
    throw new Error("Invalid campaign target, model or case selection.");
  if (Object.keys(plan).some((key) => !PLAN_KEYS.includes(key)))
    throw new Error(
      "Campaign plan contains unsupported settings. Credentials must not be included.",
    );
  if (plan.providerConfig) validateProviderConfig(plan.providerConfig, plan.provider, plan.model);
  validateCases(plan);
  validatePolicy(plan);
  validateScope(plan);
  if (plan.build !== null && (typeof plan.build !== "string" || plan.build.length > 256))
    throw new Error("Invalid build identifier.");
  if (plan.scopeIncomplete !== undefined && typeof plan.scopeIncomplete !== "boolean")
    throw new Error("Invalid discovered scope completeness.");
  validateBudgetLimits(plan.limits);
  if (Object.keys(plan.limits).some((key) => !LIMIT_KEYS.includes(key as keyof BudgetLimits)))
    throw new Error("Campaign budget contains unsupported limits.");
}

function validateCases(plan: CampaignPlan): void {
  const available = managedCases(plan.profile);
  if (
    new Set(plan.cases.map((item) => item.id)).size !== plan.cases.length ||
    plan.cases.some((item) => {
      const known = available.find((candidate) => candidate.id === item.id);
      return (
        !known ||
        Object.keys(item).length !== Object.keys(known).length ||
        Object.keys(known).some(
          (key) => item[key as keyof SecurityCase] !== known[key as keyof SecurityCase],
        )
      );
    })
  )
    throw new Error("Campaign cases must match the versioned built-in pack.");
}

function validatePolicy(plan: CampaignPlan): void {
  const policy = plan.policy;
  if (
    !policy ||
    ![...SEVERITIES, "none"].includes(policy.failOn) ||
    !Number.isFinite(policy.minCoverage) ||
    policy.minCoverage <= 0 ||
    policy.minCoverage > 1 ||
    !Number.isInteger(policy.minimumEvaluable) ||
    policy.minimumEvaluable < 1 ||
    policy.minimumEvaluable > plan.repetitions ||
    !Array.isArray(policy.suppressions) ||
    policy.suppressions.some(
      (item) =>
        !item ||
        !plan.cases.some((c) => c.id === item.caseId) ||
        Object.keys(item).some((key) => key !== "caseId" && key !== "reason") ||
        typeof item.reason !== "string" ||
        !item.reason.trim() ||
        item.reason.length > 1000,
    ) ||
    Object.keys(policy).some((key) => !POLICY_KEYS.includes(key)) ||
    new Set(policy.suppressions.map((item) => item.caseId)).size !== policy.suppressions.length
  )
    throw new Error("Invalid campaign severity, coverage, minimum count or suppression policy.");
}

function validateScope(plan: CampaignPlan): void {
  if (
    !Array.isArray(plan.scope) ||
    !Array.isArray(plan.requiredScope) ||
    plan.scope.length > 10000 ||
    new Set(plan.scope.map((item) => item.id)).size !== plan.scope.length ||
    new Set(plan.requiredScope).size !== plan.requiredScope.length ||
    plan.requiredScope.some((id) => typeof id !== "string" || !/^scope:[a-f0-9]{24}$/.test(id)) ||
    plan.scope.some(
      (item) =>
        !item ||
        typeof item.target !== "string" ||
        typeof item.caseId !== "string" ||
        item.id !== scopeId(item.target, item.caseId) ||
        typeof item.supported !== "boolean" ||
        typeof item.selected !== "boolean" ||
        Object.keys(item).some((key) => !SCOPE_KEYS.includes(key)) ||
        (item.kind !== undefined &&
          !["input", "tool", "mcp", "web", "retrieval"].includes(item.kind)) ||
        (item.label !== undefined &&
          (typeof item.label !== "string" || item.label.length > 1000)) ||
        (item.location !== undefined &&
          (typeof item.location.path !== "string" ||
            Object.keys(item.location).some((key) => !LOCATION_KEYS.includes(key)) ||
            ![
              item.location.line,
              item.location.column,
              item.location.endLine,
              item.location.endColumn,
            ].every((value) => Number.isSafeInteger(value) && value > 0))) ||
        (item.reason !== null && typeof item.reason !== "string"),
    ) ||
    plan.cases.some(
      (item) =>
        !plan.scope.some(
          (surface) =>
            surface.target === plan.target &&
            surface.caseId === item.id &&
            surface.selected &&
            surface.supported,
        ),
    )
  )
    throw new Error("Invalid campaign scope. Required surfaces must not be silently removed.");
}

/** Recompute the derived statistics and gate from the campaign's runs. */
export function refreshCampaignDerived(report: CampaignReport): void {
  report.statistics = summarizeCampaign(report);
  report.gate = evaluateCampaignGate(report);
}

/**
 * Close a campaign whose executor cannot continue, together with every run still in
 * flight, then refresh its statistics and gate so recorded violations keep counting.
 */
export function interruptCampaign(
  report: CampaignReport,
  reason: string,
  options: { state?: "stopped" | "failed" } = {},
): void {
  const state = options.state ?? "stopped";
  const finishedAt = new Date().toISOString();
  report.state = state;
  report.finishedAt = finishedAt;
  for (const run of report.runs)
    if (isRunActive(run)) interruptRun(run, reason, { state, finishedAt });
  refreshCampaignDerived(report);
}

export function newCampaign(plan: CampaignPlan): CampaignReport {
  validateCampaignPlan(plan);
  const report: CampaignReport = {
    schemaVersion: 1,
    kind: "redteam-campaign",
    id: randomUUID(),
    plan: structuredClone(plan),
    createdAt: new Date().toISOString(),
    finishedAt: null,
    state: "preparing",
    runs: [],
    budget: null,
    statistics: [],
    gate: { exitCode: 1, reasons: [] },
  };
  refreshCampaignDerived(report);
  return report;
}

/** Fixed repetitions, fresh workers/resources, one ledger across controls, probes and repeats. */
export async function executeCampaign(
  report: CampaignReport,
  provider: RunProvider,
  options: {
    signal?: AbortSignal;
    onUpdate?: (report: CampaignReport) => void;
    execute?: typeof executeRun;
  } = {},
): Promise<CampaignReport> {
  validateCampaignPlan(report.plan);
  if (
    provider.name !== report.plan.provider ||
    provider.model !== report.plan.model ||
    report.runs.length
  )
    throw new Error("Campaign provider must match its plan; start a new campaign for a rerun.");
  const budget = new ModelBudget(
    report.plan.limits,
    options.signal ? { signal: options.signal } : {},
  );
  const update = () => {
    report.budget = budget.snapshot();
    refreshCampaignDerived(report);
    options.onUpdate?.(structuredClone(report));
  };
  // Repetitions share one image; workers and trial data are still fresh every time.
  let runtime: DisposableRuntime | undefined;
  const prepare = async (signal: AbortSignal) => {
    runtime ??= await prepareRunRuntime(
      report.plan.profile === "vercel-booking-sqlite-v1" ? "vercel" : "llmfy",
      signal,
    );
    return runtime.image;
  };
  try {
    report.state = "running";
    update();
    for (let repetition = 0; repetition < report.plan.repetitions; repetition++) {
      if (budget.signal.aborted) break;
      const runOptions = {
        target: report.plan.target,
        sourceDigest: report.plan.sourceDigest,
        profile: report.plan.profile,
        provider,
        limits: report.plan.limits,
        signal: budget.signal,
        sharedBudget: budget,
        caseIds: report.plan.cases.map((item) => item.id),
        onUpdate: () => update(),
      };
      const run = newRun(report.plan.root, runOptions);
      if (report.plan.providerConfig) run.providerConfig = { ...report.plan.providerConfig };
      report.runs.push(run);
      if (options.execute) await options.execute(run, runOptions);
      else await executeRun(run, runOptions, { prepare });
      if (run.state !== "completed" || !run.cleanupConfirmed) break;
    }
    report.state = budget.signal.aborted
      ? "stopped"
      : report.runs.length === report.plan.repetitions &&
          report.runs.every((run) => run.state === "completed" && run.cleanupConfirmed)
        ? "completed"
        : "failed";
  } catch {
    report.state = budget.signal.aborted ? "stopped" : "failed";
  } finally {
    budget.finish();
    if (runtime) {
      try {
        await runtime.dispose();
      } catch (error) {
        const run = report.runs.at(-1);
        if (run) recordRuntimeCleanupFailure(run, error);
        if (report.state !== "stopped") report.state = "failed";
      }
    }
    report.finishedAt = new Date().toISOString();
    update();
  }
  return report;
}
