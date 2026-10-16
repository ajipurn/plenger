import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { redactReport } from "../shared/secrets.ts";
import { describeBudgetStop, ModelBudget } from "./budget.ts";
import { WORKER_PROTOCOL_VERSION } from "./constants.ts";
import type { ProjectPlan } from "./plan-model.ts";
import {
  ModelProviderHttpError,
  type ModelReply,
  type ModelRequest,
  type RunProvider,
} from "./provider.ts";
import type { RedteamRun, RunOptions, RunTrial } from "./run-model.ts";
import { type DisposableRuntime, RuntimeCleanupError } from "./runtime.ts";
import type { WorkerLauncher } from "./worker.ts";

/** Substitutes for the managed image build and worker launch, used by offline tests. */
export interface RunDependencies {
  prepare?: (signal: AbortSignal) => Promise<string | DisposableRuntime>;
  worker?: WorkerLauncher;
}

/** What an executor body receives: the run ledger and a redacting snapshot publisher. */
export interface RunContext {
  budget: ModelBudget;
  /** Refresh `report.budget`, redact and publish a snapshot to `onUpdate`. */
  update: () => void;
  /** Register an owned runtime before launching workers; injected fixture images stay reusable. */
  useRuntime: (runtime: string | DisposableRuntime) => string;
}

/**
 * The lifecycle every executor shares: one budget (the campaign's shared ledger or a
 * fresh one), redacted progress snapshots, and the final state/error/finishedAt
 * bookkeeping whether the body completes, is stopped by its budget, or fails.
 */
export async function withRunLifecycle(
  report: RedteamRun,
  options: RunOptions,
  failureMessage: string,
  body: (context: RunContext) => Promise<void>,
): Promise<RedteamRun> {
  const budget =
    options.sharedBudget ??
    new ModelBudget(options.limits, options.signal ? { signal: options.signal } : {});
  const update = () => {
    report.budget = budget.snapshot();
    redactReport(report);
    options.onUpdate?.(structuredClone(report));
  };
  let runtime: DisposableRuntime | undefined;
  try {
    update();
    await body({
      budget,
      update,
      useRuntime: (prepared) => {
        if (typeof prepared === "string") return prepared;
        runtime = prepared;
        return prepared.image;
      },
    });
    report.state = budget.signal.aborted ? "stopped" : "completed";
  } catch (error) {
    report.state = budget.signal.aborted ? "stopped" : "failed";
    // The first stop reason is the cause; later ones (a cancel after the cap) follow from it.
    const { stopReasons, limits } = budget.snapshot();
    const reason = stopReasons[0];
    report.error =
      report.state === "stopped"
        ? reason
          ? describeBudgetStop(reason, limits)
          : "Run stopped by its budget, deadline or cancellation."
        : (report.error ?? failureMessage);
    if (error instanceof RuntimeCleanupError) recordRuntimeCleanupFailure(report, error);
  } finally {
    if (!options.sharedBudget) budget.finish();
    if (runtime) {
      try {
        await runtime.dispose();
      } catch (error) {
        recordRuntimeCleanupFailure(report, error);
      }
    }
    report.finishedAt = new Date().toISOString();
    update();
  }
  return report;
}

/** Keep observed evidence and the original error when final resource cleanup fails. */
export function recordRuntimeCleanupFailure(report: RedteamRun, error: unknown): void {
  report.cleanupConfirmed = false;
  if (report.state !== "stopped") report.state = "failed";
  const message =
    error instanceof RuntimeCleanupError ? error.message : "Runtime image cleanup failed.";
  report.error = report.error ? `${report.error} ${message}` : message;
}

/** The captured source files of a prepared snapshot, as the worker receives them. */
export async function readWorkspaceSources(
  workspace: string,
  plan: ProjectPlan,
): Promise<{ path: string; content: string }[]> {
  return Promise.all(
    plan.sources.files.map(async (file) => ({
      path: file.path,
      content: await readFile(join(workspace, file.path), "utf8"),
    })),
  );
}

/** A worker's `model_request` frame, checked for sequence and shape. */
export function modelRequestFrom(frame: Record<string, unknown>, expectedId: number): ModelRequest {
  if (
    frame.id !== expectedId ||
    !Array.isArray(frame.messages) ||
    frame.messages.length === 0 ||
    (frame.tools !== null && !Array.isArray(frame.tools))
  )
    throw new Error("Invalid model request.");
  return { messages: frame.messages, tools: frame.tools as unknown[] | null };
}

/**
 * Admit one model call through the budget and record it on the trial. A provider
 * HTTP status becomes the run's error so it survives the worker's cleanup.
 */
export async function dispatchModelCall(
  context: RunContext,
  provider: RunProvider,
  report: RedteamRun,
  trial: RunTrial,
  request: ModelRequest,
): Promise<ModelReply> {
  const reply = await context.budget.execute(
    provider.reservation(request, trial.purpose),
    async (allowance) => {
      trial.modelCalls += 1;
      context.update();
      try {
        return await provider.generate(request, allowance);
      } catch (error) {
        if (error instanceof ModelProviderHttpError)
          report.error = `Model provider returned HTTP ${error.status}. Check model availability and access in Providers.`;
        throw error;
      }
    },
  );
  if (reply.refusal) {
    report.error = `Model provider refused the request: ${reply.refusal}`;
    throw new Error(report.error);
  }
  return reply;
}

/** The pinned versions and isolation checks a worker's `ready` frame must report. */
export interface RuntimeSpec {
  versions: Record<string, string>;
  checks: readonly string[];
}

/** Reject a worker whose `ready` frame does not prove the pinned, isolated runtime. */
export function assertReadyFrame(frame: Record<string, unknown>, spec: RuntimeSpec): void {
  if (
    frame.protocolVersion !== WORKER_PROTOCOL_VERSION ||
    Object.entries(spec.versions).some(([key, value]) => frame[key] !== value) ||
    !Array.isArray(frame.isolationChecks) ||
    !spec.checks.every((check) => (frame.isolationChecks as unknown[]).includes(check))
  )
    throw new Error("Runtime isolation could not be verified.");
}
