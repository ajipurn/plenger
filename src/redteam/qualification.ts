import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  if (!/^sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Qualification requires a full sha256 image ID, not a mutable tag.");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error("Qualification timeout must be an integer between 1 and 120000 ms.");
  if (options.signal?.aborted) throw new Error("Qualification cancelled before launch.");
  const directory = await mkdtemp(join(tmpdir(), "plenger-qualification-"));
  const name = `plenger-qualification-${randomUUID()}`;
  let attempted = false;
  let report: QualificationReport | undefined;
  const errors: unknown[] = [];
  try {
    const hostMarker = join(directory, "host-only");
    await writeFile(hostMarker, "This file must not be visible inside the worker.", {
      mode: 0o600,
    });
    if (options.signal?.aborted) throw new Error("Qualification cancelled before launch.");
    attempted = true;
    const output = await podman(
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
      JSON.stringify({ hostMarker, mode: options.mode ?? "suite" }),
      timeoutMs,
      options.signal,
    );
    report = JSON.parse(output) as QualificationReport;
    if (
      report.kind !== "llmfy-runtime-qualification" ||
      report.schemaVersion !== 1 ||
      report.provider !== "synthetic" ||
      report.liveModelQualified !== false ||
      !Array.isArray(report.isolationChecks) ||
      !Array.isArray(report.cases)
    )
      throw new Error("Invalid qualification report.");
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
  if (!report) throw new Error("No qualification report.");
  return report;
}

function podman(
  args: string[],
  input: string,
  timeoutMs: number,
  signal?: AbortSignal,
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
    const stop = (reason: string) => {
      failure ??= new Error(reason);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("Qualification timed out."), timeoutMs);
    const abort = () => stop("Qualification cancelled.");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const) {
      stream.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > 64 * 1024) stop("Qualification output limit exceeded.");
        else chunks.push(data);
      });
    }
    child.on("error", (error) => {
      failure ??= error;
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop("Qualification input failed.");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(`Podman exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`),
        );
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(input);
  });
}
