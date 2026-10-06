import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256Hex } from "../shared/hash.ts";
import { embeddedAsset } from "../shared/runtime.ts";
import { FASTAPI_WORKER } from "./constants.ts";
import { removeExpiredNetworks } from "./services.ts";
import { removeExpiredWorkers } from "./worker.ts";

const execute = promisify(execFile);

/** Every file of each managed runtime recipe; the binary build embeds exactly these. */
export const RUNTIME_FILES = {
  llmfy: ["Dockerfile", "requirements.txt", "qualify.py", "worker.py", "project/agent.py"],
  fastapi: ["Dockerfile", "preflight.py", "worker.py", "adapters/llmfy_0_6_0.py"],
  vercel: [
    "Dockerfile",
    "package.json",
    "package-lock.json",
    "worker.mjs",
    "bridge.mjs",
    "ai.mjs",
    "google.mjs",
    "sqlite.mjs",
  ],
} as const;
type RuntimeProfile = keyof typeof RUNTIME_FILES;

/** Build only the bundled, pinned recipe. Never run a project's Dockerfile/scripts. */
export async function prepareLlmfyRuntime(signal: AbortSignal): Promise<string> {
  return prepareRuntime("llmfy", signal);
}

/** The managed Next.js route image; the same recipe policy as the llmfy image. */
export async function prepareVercelRuntime(signal: AbortSignal): Promise<string> {
  return prepareRuntime("vercel", signal);
}

/** @deprecated Renamed to `prepareVercelRuntime`. */
export const prepareNextRuntime = prepareVercelRuntime;

/** A built FastAPI image: the project's dependencies on the pinned base, for one platform. */
export interface FastapiRuntime {
  image: string;
  /** `native`, or `linux/amd64` when a wheel exists only for that platform. */
  platform: "native" | "linux/amd64";
  engine: "docker" | "podman";
}

/** A build that ran and failed, with the engine's last lines for the user. */
export class RuntimeBuildError extends Error {
  readonly output: string;
  constructor(message: string, output: string, cause: unknown) {
    super(message, { cause });
    this.output = output;
  }
}

/**
 * Build the FastAPI image for one project: the bundled recipe plus the project's
 * `requirements.txt`, wheels only. Native first; on an arm64 host a missing wheel is
 * retried for linux/amd64, since many Linux-only wheels are published for x86-64 alone.
 */
export async function prepareFastapiRuntime(
  requirements: string,
  signal: AbortSignal,
): Promise<FastapiRuntime> {
  const engine = await availableEngine(signal);
  await removeExpiredWorkers(engine);
  await removeExpiredNetworks(engine);
  const extraFiles = [{ path: "project-requirements.txt", content: Buffer.from(requirements) }];
  const prefixed = (image: string) => (engine === "docker" ? `docker:${image}` : image);
  // A project that already needed the amd64 retry keeps using that image; a native
  // attempt would fail again at the same wheel after resolving everything else.
  const amd64 = await prepareManagedRuntime("fastapi", RUNTIME_FILES.fastapi, signal, engine, {
    extraFiles,
    platform: "linux/amd64",
    inspectOnly: true,
  });
  if (amd64) return { image: prefixed(amd64), platform: "linux/amd64", engine };
  try {
    const image = await prepareManagedRuntime("fastapi", RUNTIME_FILES.fastapi, signal, engine, {
      extraFiles,
      timeoutMs: FASTAPI_WORKER.buildTimeoutMs,
    });
    return { image: prefixed(image), platform: "native", engine };
  } catch (error) {
    if (
      !(error instanceof RuntimeBuildError) ||
      process.arch !== "arm64" ||
      !/No matching distribution/.test(error.output)
    )
      throw error;
    signal.throwIfAborted();
  }
  const image = await prepareManagedRuntime("fastapi", RUNTIME_FILES.fastapi, signal, engine, {
    extraFiles,
    platform: "linux/amd64",
    timeoutMs: FASTAPI_WORKER.buildTimeoutMs,
  });
  return { image: prefixed(image as string), platform: "linux/amd64", engine };
}

async function prepareRuntime(profile: RuntimeProfile, signal: AbortSignal): Promise<string> {
  const engine = await availableEngine(signal);
  // A host that died during an earlier run may have left its worker running.
  await removeExpiredWorkers(engine);
  const image = await prepareManagedRuntime(profile, RUNTIME_FILES[profile], signal, engine);
  return engine === "docker" ? `docker:${image}` : image;
}

async function availableEngine(signal: AbortSignal): Promise<"docker" | "podman"> {
  let engine: "docker" | "podman" = "podman";
  try {
    await execute("docker", ["info", "--format", "{{.ServerVersion}}"], {
      signal,
      timeout: 10_000,
      maxBuffer: 65536,
    });
    engine = "docker";
  } catch {
    signal.throwIfAborted();
  }
  return engine;
}

interface BuildOptions {
  /** Per-project files written into the build context beside the recipe. */
  extraFiles?: { path: string; content: Buffer }[];
  platform?: string;
  timeoutMs?: number;
  /** Only report an image built earlier for this recipe; never build. */
  inspectOnly?: boolean;
}

async function prepareManagedRuntime(
  profile: RuntimeProfile,
  files: readonly string[],
  signal: AbortSignal,
  engine?: "docker" | "podman",
  options?: BuildOptions & { inspectOnly?: false },
): Promise<string>;
async function prepareManagedRuntime(
  profile: RuntimeProfile,
  files: readonly string[],
  signal: AbortSignal,
  engine: "docker" | "podman",
  options: BuildOptions & { inspectOnly: true },
): Promise<string | null>;
async function prepareManagedRuntime(
  profile: RuntimeProfile,
  files: readonly string[],
  signal: AbortSignal,
  engine: "docker" | "podman" = "podman",
  options: BuildOptions = {},
): Promise<string | null> {
  signal.throwIfAborted();
  const recipe = [
    ...(await Promise.all(
      files.map(async (path) => ({
        path,
        content:
          embeddedAsset(`runtimes/${profile}/${path}`) ??
          (await readFile(
            fileURLToPath(new URL(`../../runtimes/${profile}/${path}`, import.meta.url)),
          )),
      })),
    )),
    ...(options.extraFiles ?? []),
  ];
  const digest = sha256Hex(
    Buffer.concat([
      ...recipe.map((file) => Buffer.concat([Buffer.from(file.path), file.content])),
      Buffer.from(options.platform ?? ""),
    ]),
  );
  const tag = `localhost/plenger-${profile}:${digest.slice(0, 20)}`;
  const inspect = async () => {
    const result = await execute(engine, ["image", "inspect", "--format", "{{.Id}}", tag], {
      signal,
      timeout: 10_000,
      maxBuffer: 65536,
    });
    const rawId = result.stdout.trim();
    const id = /^[a-f0-9]{64}$/.test(rawId) ? `sha256:${rawId}` : rawId;
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("Invalid managed runtime image.");
    return id;
  };
  try {
    return await inspect();
  } catch {
    signal.throwIfAborted();
  }
  if (options.inspectOnly) return null;
  const directory = await mkdtemp(join(tmpdir(), "plenger-runtime-"));
  try {
    for (const file of recipe) {
      await mkdir(join(directory, file.path, ".."), { recursive: true });
      await writeFile(join(directory, file.path), file.content, { mode: 0o600 });
    }
    await execute(
      engine,
      [
        "build",
        ...(options.platform ? ["--platform", options.platform] : []),
        "--tag",
        tag,
        directory,
      ],
      {
        signal,
        timeout: options.timeoutMs ?? (profile === "vercel" ? 600_000 : 120_000),
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return await inspect();
  } catch (cause) {
    const stderr =
      cause && typeof cause === "object" && "stderr" in cause ? String(cause.stderr) : "";
    throw new RuntimeBuildError(
      `Managed runtime preparation failed. Install/start ${engine} and retry; no project code was executed.`,
      stderr.slice(-4000),
      cause,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
