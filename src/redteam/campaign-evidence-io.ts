import { isRecord } from "../shared/guards.ts";
import { validateCampaignPlan } from "./campaign.ts";
import type { CampaignReport } from "./campaign-model.ts";
import {
  CONTROL_TRIAL_ID,
  DATABASE_OBSERVER,
  EVIDENCE_EVENT_LIMIT,
  IMAGE_ID,
  OUTCOMES,
  RUN_STATES,
} from "./constants.ts";

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid campaign evidence.");
  return value;
}
const states: readonly string[] = RUN_STATES;
const outcomes: readonly string[] = OUTCOMES;

/** Structural/coherence validation; exported files are evidence, not signed attestations. */
export function readCampaignEvidence(value: unknown): CampaignReport {
  const report = object(value);
  if (
    report.kind !== "redteam-campaign" ||
    report.schemaVersion !== 1 ||
    typeof report.id !== "string" ||
    !/^[\w-]{1,128}$/.test(report.id) ||
    !states.includes(String(report.state)) ||
    !Array.isArray(report.runs) ||
    typeof report.createdAt !== "string" ||
    !Number.isFinite(Date.parse(report.createdAt)) ||
    (report.finishedAt !== null &&
      (typeof report.finishedAt !== "string" || !Number.isFinite(Date.parse(report.finishedAt))))
  )
    throw new Error(
      "Expected a version 1 exported red-team campaign, not a single-run or static scan.",
    );
  const evidence = report as unknown as CampaignReport;
  validateCampaignPlan(evidence.plan);
  if (
    evidence.runs.length > evidence.plan.repetitions ||
    new Set(evidence.runs.map((run) => run.id)).size !== evidence.runs.length
  )
    throw new Error("Campaign contains excess or duplicate repetitions.");
  for (const raw of evidence.runs) validateRunEvidence(object(raw), evidence);
  return evidence;
}

function validateRunEvidence(run: Record<string, unknown>, evidence: CampaignReport): void {
  if (
    run.kind !== "redteam-run" ||
    run.schemaVersion !== 1 ||
    typeof run.id !== "string" ||
    !states.includes(String(run.state)) ||
    run.target !== evidence.plan.target ||
    run.sourceDigest !== evidence.plan.sourceDigest ||
    run.profile !== evidence.plan.profile ||
    run.provider !== evidence.plan.provider ||
    run.model !== evidence.plan.model ||
    typeof run.cleanControlPassed !== "boolean" ||
    typeof run.cleanupConfirmed !== "boolean" ||
    !Array.isArray(run.trials) ||
    run.trials.length !== evidence.plan.cases.length + 1
  )
    throw new Error("Repetition does not match its campaign plan.");
  const ids = new Set<string>();
  for (const rawTrial of run.trials) {
    const trial = object(rawTrial);
    const id = String(trial.id);
    if (
      ids.has(id) ||
      (id !== CONTROL_TRIAL_ID && !evidence.plan.cases.some((item) => item.id === id)) ||
      trial.purpose !== (id === CONTROL_TRIAL_ID ? "control" : "probe") ||
      typeof trial.started !== "boolean" ||
      typeof trial.completed !== "boolean" ||
      !outcomes.includes(String(trial.outcome)) ||
      !Array.isArray(trial.events) ||
      trial.events.length > EVIDENCE_EVENT_LIMIT ||
      !Number.isSafeInteger(trial.modelCalls) ||
      (trial.modelCalls as number) < 0 ||
      (trial.workerName !== null && typeof trial.workerName !== "string") ||
      (trial.completed && !trial.started) ||
      (!trial.started && trial.outcome !== "inconclusive")
    )
      throw new Error("Invalid or duplicated trial evidence.");
    ids.add(id);
  }
  if (
    run.backendChecks !== undefined &&
    (!Array.isArray(run.backendChecks) ||
      run.backendChecks.length > 2 ||
      run.backendChecks.some((item: unknown) => !outcomes.includes(String(object(item).outcome))))
  )
    throw new Error("Invalid direct handler evidence.");
  if (run.runtime !== undefined) {
    const runtime = object(run.runtime);
    if (
      typeof runtime.image !== "string" ||
      !IMAGE_ID.test(runtime.image) ||
      (!(typeof runtime.python === "string" && typeof runtime.llmfy === "string") &&
        !(
          typeof runtime.node === "string" &&
          typeof runtime.ai === "string" &&
          runtime.databaseObserver === DATABASE_OBSERVER
        ))
    )
      throw new Error("Invalid runtime provenance.");
  }
}
