import type { BudgetLimits } from "./budget.ts";
import {
  type BudgetQualificationReport,
  type BudgetScenario,
  QualificationBroker,
  type QualificationReport,
} from "./qualification-broker.ts";
import { runWorker, validateLaunch, WorkerError, WorkerInterruptedError } from "./worker.ts";

export { cleanupConfirmedFrom, runLlmfyWorker, runVercelWorker, WorkerError } from "./worker.ts";
export type { QualificationReport };

/**
 * The caller supplies the immutable ID of the bundled qualification image.
 * No host mounts, model access, project imports on the host or automatic pulls.
 */
export async function qualifyLlmfy(
  image: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Failure-injection modes for lifecycle qualification. */
    mode?: "suite" | "wait" | "flood";
  } = {},
): Promise<QualificationReport> {
  const output = await runWorker(image, options);
  const report = JSON.parse(output) as QualificationReport;
  if (
    report.kind !== "llmfy-runtime-qualification" ||
    report.schemaVersion !== 1 ||
    report.provider !== "synthetic" ||
    report.liveModelQualified !== false ||
    !Array.isArray(report.isolationChecks) ||
    !Array.isArray(report.cases)
  )
    throw new Error("Invalid qualification report.");
  return report;
}

/** Host-brokered synthetic calls from the same isolated llmfy fixture. */
export async function qualifyLlmfyBudget(
  image: string,
  options: { limits: BudgetLimits; scenario?: BudgetScenario; signal?: AbortSignal },
): Promise<BudgetQualificationReport> {
  validateLaunch(image, options.limits.timeoutMs, options.signal);
  const broker = new QualificationBroker(
    options.limits,
    options.scenario ?? "suite",
    options.signal,
  );
  try {
    try {
      await runWorker(image, {
        mode: "budget",
        scenario: options.scenario ?? "suite",
        timeoutMs: options.limits.timeoutMs,
        signal: broker.budget.signal,
        onMessage: (message) => broker.receive(message),
      });
    } catch (error) {
      // Cleanup errors and unrelated protocol/worker failures must still surface.
      const interrupted =
        error instanceof WorkerInterruptedError ||
        (error instanceof WorkerError && error.interrupted);
      if (!(interrupted && broker.budget.snapshot().state === "stopped")) throw error;
    }
    const report = broker.snapshot();
    if (!report.completed && report.budget.state !== "stopped")
      throw new Error("Qualification worker exited before completing its protocol.");
    return report;
  } finally {
    broker.budget.cancel();
  }
}
