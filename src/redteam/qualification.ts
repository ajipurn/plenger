import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BudgetLimits, BudgetStoppedError } from "./budget.ts";
import {
  type BudgetQualificationReport,
  type BudgetScenario,
  QualificationBroker,
} from "./qualification-broker.ts";

/** Developer qualification of the bundled image, NOT an arbitrary-project runner. */
export interface QualificationReport {
  schemaVersion: 1;
  kind: "llmfy-runtime-qualification";
  provider: "synthetic";
  python: string;
  llmfy: string;
  os: string;
  arch: string;
  isolationChecks: string[];
  cases: {
    case: string;
    completed: boolean;
    cleanTaskPassed: boolean;
    outcome: "violation_observed" | "not_observed" | "inconclusive";
    modelCalls: number;
    events: { stage: string; tool?: string; order?: string; status?: string }[];
  }[];
  liveModelQualified: false;
}

/**
 * The caller supplies the immutable ID of the bundled qualification image.
 * No host mounts, model access, project imports on the host or automatic pulls.
 * Timeout/abort/output overflow kill the CLI AND explicitly remove the container.
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
      if (
        !(
          error instanceof QualificationInterruptedError &&
          broker.budget.snapshot().state === "stopped"
        )
      )
        throw error;
    }
    const report = broker.snapshot();
    if (!report.completed && report.budget.state !== "stopped")
      throw new Error("Qualification worker exited before completing its protocol.");
    return report;
  } finally {
    broker.budget.cancel();
  }
}

class QualificationInterruptedError extends Error {}

function validateLaunch(image: string, timeoutMs: number, signal?: AbortSignal): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Qualification requires a full sha256 image ID, not a mutable tag.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error("Qualification timeout must be an integer between 1 and 120000 ms.");
  if (signal?.aborted)
    throw new QualificationInterruptedError("Qualification cancelled before launch.");
}

async function runWorker(
  image: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    mode?: "suite" | "wait" | "flood" | "budget";
    scenario?: BudgetScenario;
    onMessage?: (message: unknown) => Promise<unknown | undefined>;
  },
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  validateLaunch(image, timeoutMs, options.signal);
  const directory = await mkdtemp(join(tmpdir(), "plenger-qualification-"));
  const name = `plenger-qualification-${randomUUID()}`;
  let attempted = false;
  let output: string | undefined;
  const errors: unknown[] = [];
  try {
    const hostMarker = join(directory, "host-only");
    await writeFile(hostMarker, "This file must not be visible inside the worker.", {
      mode: 0o600,
    });
    if (options.signal?.aborted)
      throw new QualificationInterruptedError("Qualification cancelled before launch.");
    attempted = true;
    output = await podman(
      [
        "run",
        "--rm",
        "--name",
        name,
        "--label",
        "org.plenger.purpose=qualification",
        "--pull=never",
        "--network=none",
        "--read-only",
        "--read-only-tmpfs=false",
        "--user=65532:65532",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--memory=256m",
        "--memory-swap=256m",
        "--cpus=1",
        // Daemon-side backstop if this host process disappears entirely.
        `--timeout=${Math.ceil(timeoutMs / 1000) + 10}`,
        "--restart=no",
        "--stop-timeout=0",
        "--no-healthcheck",
        "--image-volume=ignore",
        "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
        "--log-driver=none",
        "--http-proxy=false",
        "--interactive",
        "--entrypoint=python",
        image,
        "-I",
        "/opt/plenger/qualify.py",
      ],
      JSON.stringify({ hostMarker, mode: options.mode ?? "suite", scenario: options.scenario }),
      timeoutMs,
      options.signal,
      options.onMessage,
    );
  } catch (error) {
    errors.push(error);
  }
  try {
    // --rm alone is insufficient if the CLI connection dies while the worker runs.
    if (attempted) await podman(["rm", "--force", "--time=0", "--ignore", name], "", 10_000);
  } catch (error) {
    errors.push(
      new Error(`Qualification cleanup failed for ${name}; inspect this container.`, {
        cause: error,
      }),
    );
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      `Qualification failed; cleanup could not be confirmed for ${name}.`,
    );
  if (output === undefined) throw new Error("No qualification output.");
  return output;
}

function podman(
  args: string[],
  input: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onMessage?: (message: unknown) => Promise<unknown | undefined>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("podman", args, {
      stdio: ["pipe", "pipe", "pipe"],
      // Podman's CLI needs its host configuration. None of this env is passed to
      // the container; proxy propagation is explicitly disabled above.
      env: { ...process.env, PLENGER_HOST_SENTINEL: "host-only" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let pending = Buffer.alloc(0);
    let messages = 0;
    let processing = Promise.resolve();
    let protocolFailed = false;
    const recordFailure = (reason: Error) => {
      if (!failure) failure = reason;
      else if (
        failure instanceof QualificationInterruptedError &&
        !(reason instanceof QualificationInterruptedError)
      )
        failure = new AggregateError(
          [failure, reason],
          "Qualification interrupted with an additional failure.",
        );
    };
    const stop = (reason: Error) => {
      recordFailure(reason);
      if (!(reason instanceof QualificationInterruptedError)) protocolFailed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new Error("Qualification timed out.")), timeoutMs);
    const abort = () => {
      // Once the run budget has stopped this connection, its transport fallback
      // timer must not report the same deadline as a second, unrelated failure.
      clearTimeout(timer);
      stop(new QualificationInterruptedError("Qualification cancelled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const) {
      stream.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > 64 * 1024) {
          stop(new Error("Qualification output limit exceeded."));
          return;
        }
        if (!onMessage || stream === child.stderr) chunks.push(data);
        else {
          pending = Buffer.concat([pending, data]);
          let newline = pending.indexOf(10);
          while (newline !== -1) {
            const frame = pending.subarray(0, newline);
            pending = pending.subarray(newline + 1);
            if (++messages > 256) {
              stop(new Error("Qualification message limit exceeded."));
              return;
            }
            processing = processing.then(async () => {
              if (protocolFailed) return;
              try {
                const message: unknown = JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(frame),
                );
                const reply = await onMessage(message);
                if (reply !== undefined) child.stdin.write(`${JSON.stringify(reply)}\n`);
              } catch (error) {
                // The budget aborts this connection before its denied execute()
                // rejects. That expected rejection is not a protocol failure.
                if (
                  error instanceof BudgetStoppedError &&
                  signal?.aborted &&
                  failure instanceof QualificationInterruptedError
                )
                  return;
                stop(new Error("Qualification worker protocol failed."));
              }
            });
            newline = pending.indexOf(10);
          }
        }
      });
    }
    child.on("error", (error) => {
      recordFailure(error);
      protocolFailed = true;
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(new Error("Qualification input failed."));
    });
    child.on("close", async (code) => {
      await processing;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (onMessage && pending.length > 0)
        recordFailure(new Error("Truncated qualification worker frame."));
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(`Podman exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`),
        );
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
    if (onMessage) child.stdin.write(`${input}\n`);
    else child.stdin.end(input);
  });
}
