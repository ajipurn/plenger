import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "../shared/guards.ts";
import { BudgetStoppedError } from "./budget.ts";
import { IMAGE_ID, WORKER_PROTOCOL_VERSION, WORKER_TIMEOUT_MS } from "./constants.ts";
import type { BudgetScenario } from "./qualification-broker.ts";

/**
 * Every worker container is labelled with the time after which only a host that died
 * could have left it running: a live host stops its worker at the transport deadline.
 */
export const EXPIRES_LABEL = "org.plenger.expires";
/** Margin past the deadline for the expiry label and the Podman daemon backstop. */
const BACKSTOP_GRACE_MS = 10_000;

/** Receives one worker frame and may return a reply frame to write back. */
export type WorkerHandler = (message: unknown) => Promise<unknown | undefined>;
/** Launch a managed project worker; executors accept a substitute for offline tests. */
export type WorkerLauncher = (
  image: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
  onMessage: WorkerHandler,
  onLaunch?: (name: string) => void,
) => Promise<void>;

/** The worker transport was stopped because its signal aborted, not because it failed. */
export class WorkerInterruptedError extends Error {}

/**
 * Any failure of a managed worker: launch, transport, protocol or cleanup.
 * `cleanupConfirmed` records whether the container is known to be gone, so a run can
 * keep its evidence trustworthy even when the worker did not finish.
 */
export class WorkerError extends Error {
  readonly cleanupConfirmed: boolean;
  /** The underlying failures in the order they were observed. */
  readonly errors: readonly unknown[];
  constructor(
    message: string,
    options: { cleanupConfirmed: boolean; errors?: unknown[]; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.cleanupConfirmed = options.cleanupConfirmed;
    this.errors = options.errors ?? (options.cause === undefined ? [] : [options.cause]);
  }
  /** True when the only failure was the worker's own cancellation. */
  get interrupted(): boolean {
    return this.errors.length === 1 && this.errors[0] instanceof WorkerInterruptedError;
  }
}

/** Whether a failed worker launch still confirmed its container was removed. */
export function cleanupConfirmedFrom(error: unknown): boolean {
  return error instanceof WorkerError && error.cleanupConfirmed;
}

/** Refuse mutable tags, unbounded deadlines and already-cancelled launches before spawning. */
export function validateLaunch(image: string, timeoutMs: number, signal?: AbortSignal): void {
  if (!IMAGE_ID.test(image))
    throw new Error("Worker launch requires a full sha256 image ID, not a mutable tag.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WORKER_TIMEOUT_MS)
    throw new Error(`Worker timeout must be an integer between 1 and ${WORKER_TIMEOUT_MS} ms.`);
  if (signal?.aborted) throw new WorkerInterruptedError("Worker cancelled before launch.");
}

export interface WorkerLaunch {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Qualification modes of the bundled llmfy fixture. */
  mode?: "suite" | "wait" | "flood" | "budget";
  scenario?: BudgetScenario;
  onMessage?: WorkerHandler;
  /** A managed project run instead of fixture qualification. */
  projectRequest?: Record<string, unknown>;
  runtime?: "llmfy" | "vercel";
  onLaunch?: (name: string) => void;
}

/**
 * Launch the pinned image once with every isolation control, stream its frames and
 * always remove the container. The caller never mounts host paths or opens a network.
 * Timeout/abort/output overflow kill the CLI AND explicitly remove the container.
 */
export async function runWorker(image: string, options: WorkerLaunch): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const engine = image.startsWith("docker:") ? "docker" : "podman";
  if (engine === "docker") image = image.slice(7);
  validateLaunch(image, timeoutMs, options.signal);
  const directory = await mkdtemp(join(tmpdir(), "plenger-qualification-"));
  const name = `${options.projectRequest ? "plenger-run" : "plenger-qualification"}-${randomUUID()}`;
  let attempted = false;
  let output: string | undefined;
  const errors: unknown[] = [];
  let cleanupConfirmed = false;
  try {
    const hostMarker = join(directory, "host-only");
    await writeFile(hostMarker, "This file must not be visible inside the worker.", {
      mode: 0o600,
    });
    if (options.signal?.aborted)
      throw new WorkerInterruptedError("Worker cancelled before launch.");
    attempted = true;
    options.onLaunch?.(name);
    output = await runContainer({
      engine,
      args: containerArguments(engine, image, name, timeoutMs, options),
      input: JSON.stringify(
        options.projectRequest
          ? { ...options.projectRequest, protocolVersion: WORKER_PROTOCOL_VERSION, hostMarker }
          : {
              protocolVersion: WORKER_PROTOCOL_VERSION,
              hostMarker,
              mode: options.mode ?? "suite",
              scenario: options.scenario,
            },
      ),
      timeoutMs,
      maxOutputBytes: options.runtime === "vercel" ? 512 * 1024 : 64 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onMessage ? { onMessage: options.onMessage } : {}),
    });
  } catch (error) {
    errors.push(error);
  }
  try {
    // --rm alone is insufficient if the CLI connection dies while the worker runs.
    if (attempted) await removeContainer(engine, name);
    cleanupConfirmed = true;
  } catch (error) {
    errors.push(
      new Error(`Worker cleanup failed for ${name}; inspect this container.`, { cause: error }),
    );
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw workerError(errors, cleanupConfirmed, name);
  if (output === undefined) throw new Error("No worker output.");
  return output;
}

/** Flatten transport aggregates so `errors` lists every distinct failure once. */
function workerError(errors: unknown[], cleanupConfirmed: boolean, name: string): WorkerError {
  const flat = errors.flatMap((error) =>
    error instanceof AggregateError && !(error instanceof WorkerError) ? error.errors : [error],
  );
  const [first] = flat;
  return new WorkerError(
    flat.length === 1
      ? errorMessage(first)
      : cleanupConfirmed
        ? `Worker failed with ${flat.length} errors for ${name}.`
        : `Worker failed; cleanup could not be confirmed for ${name}.`,
    { cleanupConfirmed, errors: flat, cause: first },
  );
}

/** @internal Exported for tests; the flag list is the isolation contract of every worker. */
export function containerArguments(
  engine: "docker" | "podman",
  image: string,
  name: string,
  timeoutMs: number,
  options: WorkerLaunch,
): string[] {
  const vercel = options.runtime === "vercel";
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--label",
    `org.plenger.purpose=${options.projectRequest ? "redteam-run" : "qualification"}`,
    "--label",
    `${EXPIRES_LABEL}=${Date.now() + timeoutMs + BACKSTOP_GRACE_MS}`,
    "--pull=never",
    "--network=none",
    "--read-only",
    ...(engine === "podman" ? ["--read-only-tmpfs=false"] : []),
    "--user=65532:65532",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=64",
    "--memory=256m",
    "--memory-swap=256m",
    "--cpus=1",
    // Daemon-side backstop if this host process disappears entirely.
    ...(engine === "podman"
      ? [`--timeout=${Math.ceil((timeoutMs + BACKSTOP_GRACE_MS) / 1000)}`]
      : []),
    "--restart=no",
    "--stop-timeout=0",
    "--no-healthcheck",
    ...(engine === "podman" ? ["--image-volume=ignore"] : []),
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
    "--log-driver=none",
    ...(engine === "podman"
      ? ["--http-proxy=false"]
      : [
          "--env=HTTP_PROXY=",
          "--env=HTTPS_PROXY=",
          "--env=ALL_PROXY=",
          "--env=NO_PROXY=",
          "--env=http_proxy=",
          "--env=https_proxy=",
          "--env=all_proxy=",
          "--env=no_proxy=",
        ]),
    "--interactive",
    vercel ? "--entrypoint=node" : "--entrypoint=python",
    image,
    ...(vercel
      ? ["/opt/plenger/worker.mjs"]
      : ["-I", options.projectRequest ? "/opt/plenger/worker.py" : "/opt/plenger/qualify.py"]),
  ];
}

/** Remove only this container and its anonymous volumes; confirm absence on Docker. */
export async function removeContainer(engine: "docker" | "podman", name: string): Promise<void> {
  if (engine === "podman") {
    await runContainer({
      engine,
      args: ["rm", "--force", "--time=0", "--ignore", "--volumes", name],
      input: "",
      timeoutMs: 10_000,
    });
    return;
  }
  const list = (timeoutMs: number) =>
    runContainer({
      engine,
      args: ["ps", "--all", "--quiet", "--filter", `name=^/${name}$`],
      input: "",
      timeoutMs,
      maxOutputBytes: 65536,
    });
  if ((await list(10_000)).trim()) {
    try {
      await runContainer({
        engine,
        args: ["rm", "--force", "--volumes", name],
        input: "",
        timeoutMs: 10_000,
        maxOutputBytes: 65536,
      });
    } catch {
      /* --rm may already be removing it; confirm absence below. */
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!(await list(1000)).trim()) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if ((await list(10_000)).trim()) throw new Error("Worker remains active.");
}

/**
 * Remove worker containers left behind by a host process that died. Containers of live
 * runs, including other plenger processes, have not expired yet. Best effort: a failure
 * leaves the container for the next sweep. Returns the number removed.
 */
export async function removeExpiredWorkers(
  engine: "docker" | "podman",
  now = Date.now(),
): Promise<number> {
  const command = (args: string[]) =>
    runContainer({ engine, args, input: "", timeoutMs: 10_000, maxOutputBytes: 65536 });
  let ids: string[];
  try {
    ids = (await command(["ps", "--all", "--quiet", "--filter", `label=${EXPIRES_LABEL}`]))
      .split("\n")
      .map((id) => id.trim())
      .filter(Boolean);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const id of ids) {
    try {
      const label = (
        await command(["inspect", "--format", `{{index .Config.Labels "${EXPIRES_LABEL}"}}`, id])
      ).trim();
      if (!/^\d{1,16}$/.test(label) || Number(label) >= now) continue;
      await command(["rm", "--force", "--volumes", id]);
      removed++;
    } catch {
      // Already removed by --rm, or refused by the engine; the next sweep retries.
    }
  }
  return removed;
}

/** Shared lifecycle and isolation controls for the managed llmfy project worker. */
export async function runLlmfyWorker(
  image: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
  onMessage: WorkerHandler,
  onLaunch?: (name: string) => void,
): Promise<void> {
  await runWorker(image, {
    projectRequest: request,
    runtime: "llmfy",
    signal,
    timeoutMs: WORKER_TIMEOUT_MS,
    onMessage,
    ...(onLaunch ? { onLaunch } : {}),
  });
}

/** The same controls for the managed Vercel route worker. */
export async function runVercelWorker(
  image: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
  onMessage: WorkerHandler,
  onLaunch?: (name: string) => void,
): Promise<void> {
  await runWorker(image, {
    projectRequest: request,
    runtime: "vercel",
    signal,
    timeoutMs: WORKER_TIMEOUT_MS,
    onMessage,
    ...(onLaunch ? { onLaunch } : {}),
  });
}

export interface ContainerCommand {
  engine: "docker" | "podman";
  args: string[];
  /** Written to stdin: as a whole when no handler is set, otherwise as the first frame. */
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Enables newline-delimited JSON framing with replies written back to the worker. */
  onMessage?: WorkerHandler;
  maxOutputBytes?: number;
}

/** Run one engine command with a hard deadline, output cap and optional frame protocol. */
export function runContainer(command: ContainerCommand): Promise<string> {
  const { engine, args, input, timeoutMs, signal, onMessage } = command;
  const maxOutputBytes = command.maxOutputBytes ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(engine, args, {
      stdio: ["pipe", "pipe", "pipe"],
      // The engine CLI needs its host configuration. None of this env is passed to
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
        failure instanceof WorkerInterruptedError &&
        !(reason instanceof WorkerInterruptedError)
      )
        failure = new AggregateError(
          [failure, reason],
          "Worker interrupted with an additional failure.",
        );
    };
    const stop = (reason: Error) => {
      recordFailure(reason);
      if (!(reason instanceof WorkerInterruptedError)) protocolFailed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new Error("Worker timed out.")), timeoutMs);
    const abort = () => {
      // Once the run budget has stopped this connection, its transport fallback
      // timer must not report the same deadline as a second, unrelated failure.
      clearTimeout(timer);
      stop(new WorkerInterruptedError("Worker cancelled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const) {
      stream.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > maxOutputBytes) {
          stop(new Error("Worker output limit exceeded."));
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
              stop(new Error("Worker message limit exceeded."));
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
                  failure instanceof WorkerInterruptedError
                )
                  return;
                stop(new Error("Worker protocol failed."));
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
      if (error.code !== "EPIPE") stop(new Error("Worker input failed."));
    });
    child.on("close", async (code) => {
      await processing;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (onMessage && pending.length > 0) recordFailure(new Error("Truncated worker frame."));
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(`${engine} exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`),
        );
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
    if (onMessage) child.stdin.write(`${input}\n`);
    else child.stdin.end(input);
  });
}
