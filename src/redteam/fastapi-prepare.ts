import { randomUUID } from "node:crypto";
import { redactReport } from "../shared/secrets.ts";
import {
  FASTAPI_ISOLATION_CHECKS,
  FASTAPI_PLACEHOLDER_SETTINGS,
  FASTAPI_PROFILE,
  FASTAPI_RUNTIME,
  FASTAPI_WORKER,
  type FastapiService,
  SOURCE_BYTE_CAP,
} from "./constants.ts";
import { withPreparedProject } from "./plan.ts";
import { PreparationError, type ProjectPlan } from "./plan-model.ts";
import { decodeSource, readProjectFile } from "./project-files.ts";
import { record } from "./provider.ts";
import { assertReadyFrame, readWorkspaceSources } from "./run-lifecycle.ts";
import { type FastapiRuntime, prepareFastapiRuntime } from "./runtime.ts";
import {
  type DisposableServices,
  type ServiceLauncher,
  startDisposableServices,
} from "./services.ts";
import { cleanupConfirmedFrom, type FastapiWorkerLauncher, runFastapiWorker } from "./worker.ts";

/** What the FastAPI profile establishes before any case pack exists: the application imports and serves. */
export interface FastapiPreparation {
  schemaVersion: 1;
  kind: "redteam-fastapi-preparation";
  id: string;
  root: string;
  target: string;
  sourceDigest: string;
  profile: typeof FASTAPI_PROFILE;
  createdAt: string;
  finishedAt: string | null;
  state: "preparing" | "completed" | "failed" | "stopped";
  /** The last stage that started. */
  stage: "plan" | "build" | "services" | "worker" | "done";
  runtime: { image: string; platform: string; python: string; llmfy: string } | null;
  /** Every package installed in the image, as the build resolved it. */
  packages: { name: string; version: string }[];
  services: { name: FastapiService; image: string; host: string; port: number; ready: boolean }[];
  /** Names only: the application settings the worker received and where each came from. */
  settings: { supplied: string[]; placeholders: string[]; services: string[] };
  isolationChecks: string[];
  adapter: { llmfy: string; patched: string[] } | null;
  imported: {
    durationMs: number;
    application: string;
    routes: { methods: string[]; path: string }[];
  } | null;
  probe: { method: string; path: string; status: number | null; bytes: number } | null;
  /** Tool handlers observed entering or returning while importing or probing. */
  toolEvents: number;
  /** Preparation never serves a model request; one arriving is a failure. */
  modelCalls: 0;
  failure: { stage: string; error: { type: string; message: string } } | null;
  cleanupConfirmed: boolean;
  error: string | null;
}

export interface FastapiPrepareOptions {
  target?: string;
  expectedDigest?: string;
  signal?: AbortSignal;
  onUpdate?: (report: FastapiPreparation) => void;
  /**
   * Application settings the user supplies for the import, as environment variables.
   * Service settings always win over them; values never appear in the report.
   */
  settings?: Record<string, string>;
}

const SETTING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SETTING_LIMIT = 200;

/** Reject names that are not identifiers, oversized maps and attempts to override the host marker. */
export function validateSettings(settings: Record<string, string>): void {
  const entries = Object.entries(settings);
  if (entries.length > SETTING_LIMIT) throw new PreparationError("Too many settings.");
  for (const [name, value] of entries) {
    if (!SETTING_NAME.test(name) || name.startsWith("PLENGER_"))
      throw new PreparationError(`Invalid setting name: ${name}`);
    if (typeof value !== "string" || value.length > 4096 || /[\r\n\0]/.test(value))
      throw new PreparationError(`Invalid value for setting ${name}.`);
  }
}

/** Substitutes for the build, the services and the worker, used by offline tests. */
export interface FastapiDependencies {
  prepare?: (requirements: string, signal: AbortSignal) => Promise<FastapiRuntime>;
  services?: ServiceLauncher;
  worker?: FastapiWorkerLauncher;
}

const FAILURE_MESSAGE =
  "FastAPI preparation did not complete. Review the stage, the build output and the application's import error.";
const PACKAGE_LIMIT = 2000;

/**
 * Build the project's image, start disposable services, import the application in a
 * worker and probe one route. No model is contacted. The report is redacted on every
 * update and services are removed whatever happens.
 */
export async function prepareFastapiProject(
  root: string,
  options: FastapiPrepareOptions = {},
  dependencies: FastapiDependencies = {},
): Promise<FastapiPreparation> {
  const report: FastapiPreparation = {
    schemaVersion: 1,
    kind: "redteam-fastapi-preparation",
    id: randomUUID(),
    root,
    target: options.target ?? "",
    sourceDigest: "",
    profile: FASTAPI_PROFILE,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    state: "preparing",
    stage: "plan",
    runtime: null,
    packages: [],
    services: [],
    settings: { supplied: [], placeholders: [], services: [] },
    isolationChecks: [],
    adapter: null,
    imported: null,
    probe: null,
    toolEvents: 0,
    modelCalls: 0,
    failure: null,
    cleanupConfirmed: true,
    error: null,
  };
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, FASTAPI_WORKER.buildTimeoutMs + FASTAPI_WORKER.timeoutMs);
  const update = () => {
    redactReport(report);
    options.onUpdate?.(structuredClone(report));
  };
  let services: DisposableServices | undefined;
  try {
    validateSettings(options.settings ?? {});
    update();
    await withPreparedProject(
      root,
      {
        ...(options.target ? { target: options.target } : {}),
        ...(options.expectedDigest ? { expectedDigest: options.expectedDigest } : {}),
        maxTotalBytes: SOURCE_BYTE_CAP,
      },
      async (workspace, plan) => {
        const profile = plan.fastapiProfile;
        if (!profile || !plan.selectedTarget)
          throw new PreparationError(
            "This project does not use the FastAPI profile. Review the plan for the profile it prepared.",
          );
        if (profile.llmfy.adapter !== "available" || profile.llmfy.version === null)
          throw new PreparationError(
            `llmfy ${profile.llmfy.version} has no FastAPI profile adapter.`,
          );
        report.target = plan.selectedTarget;
        report.sourceDigest = plan.sourceDigest;
        const requirements = await requirementsFor(root, plan);
        const sources = await readWorkspaceSources(workspace, plan);
        report.stage = "build";
        update();
        const runtime = await (dependencies.prepare ?? prepareFastapiRuntime)(requirements, signal);
        report.runtime = {
          image: runtime.image,
          platform: runtime.platform,
          python: "",
          llmfy: "",
        };
        report.stage = "services";
        update();
        const started = await (dependencies.services ?? startDisposableServices)(
          runtime.engine,
          profile.services,
          signal,
          { timeoutMs: FASTAPI_WORKER.timeoutMs },
        );
        services = started;
        report.services = started.services.map((service) => ({ ...service }));
        const supplied = options.settings ?? {};
        const env = { ...FASTAPI_PLACEHOLDER_SETTINGS, ...supplied, ...started.env };
        report.settings = {
          supplied: Object.keys(supplied).sort(),
          placeholders: Object.keys(FASTAPI_PLACEHOLDER_SETTINGS)
            .filter((name) => !(name in supplied) && !(name in started.env))
            .sort(),
          services: Object.keys(started.env).sort(),
        };
        report.stage = "worker";
        update();
        const state = { ready: false, finished: false };
        const llmfyVersion = profile.llmfy.version;
        try {
          await (dependencies.worker ?? runFastapiWorker)(
            runtime.image,
            {
              sources,
              app: { module: profile.app.module, attribute: profile.app.attribute },
              llmfy: llmfyVersion,
              env,
              probe: { method: "GET", path: "/" },
              policy: null,
            },
            signal,
            async (message) => handleFrame(report, llmfyVersion, state, record(message), update),
            {
              network: started.network,
              env,
              ...(runtime.platform === "native" ? {} : { platform: runtime.platform }),
            },
          );
          report.cleanupConfirmed = true;
        } catch (error) {
          report.cleanupConfirmed = cleanupConfirmedFrom(error);
          throw error;
        }
        if (!state.ready || !state.finished)
          throw new Error("The worker exited before completing its protocol.");
        if (report.failure) throw new Error(report.failure.error.message);
        report.stage = "done";
      },
    );
    report.state = signal.aborted ? "stopped" : "completed";
  } catch (error) {
    if (error instanceof PreparationError) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      throw error;
    }
    report.state = signal.aborted ? "stopped" : "failed";
    report.error =
      report.state === "stopped"
        ? "Preparation stopped by its deadline or cancellation."
        : (report.failure?.error.message ??
          (error instanceof Error ? error.message : FAILURE_MESSAGE));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (services) {
      const removed = await services.dispose();
      report.cleanupConfirmed &&= removed;
    }
    report.finishedAt = new Date().toISOString();
    update();
  }
  return report;
}

/** The manifest the build installs from; its bytes must still match the reviewed digest. */
async function requirementsFor(root: string, plan: ProjectPlan): Promise<string> {
  const reviewed = plan.dependencies.manifests.find((item) => item.path === "requirements.txt");
  if (!reviewed || reviewed.sha256 === null)
    throw new PreparationError("The FastAPI profile installs dependencies from requirements.txt.");
  const bytes = await readProjectFile(root, "requirements.txt", 256 * 1024);
  const { sha256Hex } = await import("../shared/hash.ts");
  if (sha256Hex(bytes) !== reviewed.sha256)
    throw new PreparationError("requirements.txt changed since planning; create a new plan.");
  return decodeSource(bytes);
}

async function handleFrame(
  report: FastapiPreparation,
  llmfyVersion: string,
  state: { ready: boolean; finished: boolean },
  frame: Record<string, unknown>,
  update: () => void,
): Promise<unknown> {
  if (frame.type === "ready") {
    if (state.ready) throw new Error("Runtime isolation could not be verified.");
    assertReadyFrame(frame, {
      versions: { ...FASTAPI_RUNTIME, llmfy: llmfyVersion },
      checks: FASTAPI_ISOLATION_CHECKS,
    });
    if (!Array.isArray(frame.packages) || frame.packages.length > PACKAGE_LIMIT)
      throw new Error("Invalid package list.");
    report.packages = frame.packages.map((value) => {
      const item = record(value);
      if (typeof item.name !== "string" || typeof item.version !== "string")
        throw new Error("Invalid package list.");
      return { name: item.name, version: item.version };
    });
    report.isolationChecks = [...(frame.isolationChecks as string[])];
    if (report.runtime)
      report.runtime = { ...report.runtime, python: FASTAPI_RUNTIME.python, llmfy: llmfyVersion };
    state.ready = true;
    update();
    return undefined;
  }
  if (!state.ready || state.finished) throw new Error("Invalid worker event sequence.");
  switch (frame.type) {
    case "adapter": {
      if (!Array.isArray(frame.patched) || frame.patched.some((item) => typeof item !== "string"))
        throw new Error("Invalid adapter report.");
      report.adapter = { llmfy: llmfyVersion, patched: frame.patched as string[] };
      break;
    }
    case "imported": {
      if (
        !Number.isSafeInteger(frame.durationMs) ||
        typeof frame.application !== "string" ||
        !Array.isArray(frame.routes) ||
        frame.routes.length > 200
      )
        throw new Error("Invalid import report.");
      report.imported = {
        durationMs: frame.durationMs as number,
        application: frame.application,
        routes: frame.routes.map((value) => {
          const route = record(value);
          if (
            !Array.isArray(route.methods) ||
            route.methods.some((method) => typeof method !== "string") ||
            typeof route.path !== "string"
          )
            throw new Error("Invalid route description.");
          return { methods: route.methods as string[], path: route.path };
        }),
      };
      break;
    }
    case "probe": {
      if (
        typeof frame.method !== "string" ||
        typeof frame.path !== "string" ||
        (frame.status !== null && !Number.isSafeInteger(frame.status)) ||
        !Number.isSafeInteger(frame.bytes)
      )
        throw new Error("Invalid probe report.");
      report.probe = {
        method: frame.method,
        path: frame.path,
        status: frame.status as number | null,
        bytes: frame.bytes as number,
      };
      break;
    }
    case "event": {
      if (typeof frame.stage !== "string") throw new Error("Invalid tool observation.");
      report.toolEvents += 1;
      break;
    }
    case "failure": {
      const error = record(frame.error);
      if (typeof frame.stage !== "string" || typeof error.type !== "string")
        throw new Error("Invalid failure report.");
      report.failure = {
        stage: frame.stage,
        error: {
          type: error.type.slice(0, 120),
          message: typeof error.message === "string" ? error.message.slice(0, 400) : "",
        },
      };
      break;
    }
    case "model_request":
      report.failure = {
        stage: "model-call",
        error: {
          type: "ModelRequest",
          message: "The application requested a model during preparation; no model is served here.",
        },
      };
      throw new Error(report.failure.error.message);
    case "finished": {
      if (typeof frame.completed !== "boolean") throw new Error("Invalid completion event.");
      state.finished = true;
      if (!frame.completed && !report.failure)
        report.failure = {
          stage: "worker",
          error: { type: "Incomplete", message: "The worker did not complete the preparation." },
        };
      break;
    }
    default:
      throw new Error("Unknown worker event.");
  }
  update();
  return undefined;
}
