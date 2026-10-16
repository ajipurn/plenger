import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256Hex } from "../shared/hash.ts";
import { embeddedAsset } from "../shared/runtime.ts";
import {
  BUILDKIT_IMAGE,
  DISPOSABLE_RUNTIME_TTL,
  FASTAPI_WORKER,
  RUNTIME_BUILD_TIMEOUT_MS,
} from "./constants.ts";
import { removeExpiredNetworks } from "./services.ts";
import { EXPIRES_LABEL, removeExpiredWorkers } from "./worker.ts";

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

/** A run owns its image tag. Removing it never forces removal of another run's image. */
export interface DisposableRuntime {
  image: string;
  dispose: () => Promise<void>;
}

/** A runtime's image, build cache or temporary context could not be removed. */
export class RuntimeCleanupError extends Error {}

/** Managed runs use disposable images; qualification keeps its reusable fixture images. */
export async function prepareRunRuntime(
  profile: "llmfy" | "vercel",
  signal: AbortSignal,
): Promise<DisposableRuntime> {
  const engine = await availableEngine(signal);
  await removeExpiredWorkers(engine);
  await removeExpiredRuntimes(engine);
  const runtime = await prepareManagedRuntime(profile, RUNTIME_FILES[profile], signal, engine, {
    disposable: true,
  });
  return { ...runtime, image: engine === "docker" ? `docker:${runtime.image}` : runtime.image };
}

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
export interface FastapiRuntime extends DisposableRuntime {
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
  await removeExpiredRuntimes(engine);
  const extraFiles = [{ path: "project-requirements.txt", content: Buffer.from(requirements) }];
  const prefixed = (image: string) => (engine === "docker" ? `docker:${image}` : image);
  try {
    const runtime = await prepareManagedRuntime("fastapi", RUNTIME_FILES.fastapi, signal, engine, {
      extraFiles,
      timeoutMs: FASTAPI_WORKER.buildTimeoutMs,
      disposable: true,
    });
    return { ...runtime, image: prefixed(runtime.image), platform: "native", engine };
  } catch (error) {
    if (
      !(error instanceof RuntimeBuildError) ||
      process.arch !== "arm64" ||
      !/No matching distribution/.test(error.output)
    )
      throw error;
    signal.throwIfAborted();
  }
  const runtime = await prepareManagedRuntime("fastapi", RUNTIME_FILES.fastapi, signal, engine, {
    extraFiles,
    platform: "linux/amd64",
    timeoutMs: FASTAPI_WORKER.buildTimeoutMs,
    disposable: true,
  });
  return { ...runtime, image: prefixed(runtime.image), platform: "linux/amd64", engine };
}

async function prepareRuntime(profile: RuntimeProfile, signal: AbortSignal): Promise<string> {
  const engine = await availableEngine(signal);
  // A host that died during an earlier run may have left its worker running.
  await removeExpiredWorkers(engine);
  const runtime = await prepareManagedRuntime(profile, RUNTIME_FILES[profile], signal, engine);
  return engine === "docker" ? `docker:${runtime.image}` : runtime.image;
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
  /** Separate image ownership and build cache for a run or preparation. */
  disposable?: boolean;
}

async function prepareManagedRuntime(
  profile: RuntimeProfile,
  files: readonly string[],
  signal: AbortSignal,
  engine: "docker" | "podman" = "podman",
  options: BuildOptions = {},
): Promise<DisposableRuntime> {
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
  const id = randomUUID();
  const tag = `localhost/plenger-${profile}:${options.disposable ? id : digest.slice(0, 20)}`;
  const dispose = () => removeRuntimeImage(engine, tag);
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
  if (!options.disposable) {
    try {
      return { image: await inspect(), dispose };
    } catch {
      signal.throwIfAborted();
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "plenger-runtime-"));
  const builder = options.disposable && engine === "docker" ? `plenger-${id}` : null;
  let image: string | undefined;
  let failure: unknown;
  try {
    for (const file of recipe) {
      await mkdir(join(directory, file.path, ".."), { recursive: true });
      await writeFile(join(directory, file.path), file.content, { mode: 0o600 });
    }
    if (builder)
      await execute(
        engine,
        [
          "buildx",
          "create",
          "--name",
          builder,
          "--driver",
          "docker-container",
          "--driver-opt",
          `image=${BUILDKIT_IMAGE}`,
        ],
        {
          signal,
          timeout: 30_000,
          maxBuffer: 65536,
        },
      );
    await execute(
      engine,
      [
        ...(builder ? ["buildx", "build", "--builder", builder, "--load"] : ["build"]),
        ...(options.disposable && engine === "podman"
          ? ["--layers=false", "--no-cache", "--force-rm"]
          : []),
        ...(options.platform ? ["--platform", options.platform] : []),
        // A host that dies before disposing leaves this label for the next sweep.
        ...(options.disposable
          ? ["--label", `${EXPIRES_LABEL}=${Date.now() + DISPOSABLE_RUNTIME_TTL.imageMs}`]
          : []),
        "--tag",
        tag,
        directory,
      ],
      {
        signal,
        timeout:
          options.timeoutMs ??
          (options.disposable || profile === "vercel" ? RUNTIME_BUILD_TIMEOUT_MS : 120_000),
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    image = await inspect();
  } catch (cause) {
    const stderr =
      cause && typeof cause === "object" && "stderr" in cause ? String(cause.stderr) : "";
    failure = new RuntimeBuildError(
      `Managed runtime preparation failed. Install/start ${engine}${builder ? " with Buildx" : ""} and retry; no project code was executed.`,
      stderr.slice(-4000),
      cause,
    );
  }
  // Cleanup has its own deadlines, independent of the cancelled run/build signal.
  const cleanup = await Promise.allSettled([
    rm(directory, { recursive: true, force: true }),
    ...(builder ? [removeBuilder(engine, builder)] : []),
  ]);
  const errors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failure || errors.length) {
    if (options.disposable) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new RuntimeCleanupError(
        `Runtime cleanup failed for ${tag}; inspect its image and builder.`,
        { cause: new AggregateError([...(failure ? [failure] : []), ...errors]) },
      );
    throw failure;
  }
  if (!image) throw new Error("No managed runtime image.");
  return { image, dispose };
}

async function removeRuntimeImage(engine: "docker" | "podman", tag: string): Promise<void> {
  const present = await execute(engine, ["image", "ls", "--quiet", tag], {
    timeout: 10_000,
    maxBuffer: 65536,
  });
  if (!present.stdout.trim()) return;
  try {
    await execute(engine, ["image", "rm", tag], { timeout: 30_000, maxBuffer: 65536 });
  } catch (cause) {
    throw new RuntimeCleanupError(`Runtime image cleanup failed for ${tag}; inspect this image.`, {
      cause,
    });
  }
}

/** Remove a dedicated builder and its cache volume. A builder that was never created is gone. */
async function removeBuilder(engine: "docker" | "podman", builder: string): Promise<void> {
  try {
    await execute(engine, ["buildx", "rm", "--force", builder], {
      timeout: 30_000,
      maxBuffer: 65536,
    });
  } catch (error) {
    // `buildx create` may have failed (no Buildx, no daemon); then nothing exists to remove.
    const present = await execute(engine, ["buildx", "inspect", builder], {
      timeout: 10_000,
      maxBuffer: 65536,
    }).then(
      () => true,
      () => false,
    );
    if (present) throw error;
  }
}

const DISPOSABLE_TAG = /^localhost\/plenger-(?:llmfy|vercel|fastapi):[a-f0-9-]{36}$/;
const BUILDER_CONTAINER = /^buildx_buildkit_(plenger-[a-f0-9-]{36})\d+$/;

/**
 * Remove disposable run images and dedicated Docker builders left by a host that died.
 * Live runtimes have not reached their expiry. Best effort: a failure leaves the
 * resource for the next sweep. Returns the number removed.
 */
export async function removeExpiredRuntimes(
  engine: "docker" | "podman",
  now = Date.now(),
): Promise<number> {
  const command = async (args: string[]) =>
    (await execute(engine, args, { timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout;
  const lines = async (args: string[]) => {
    try {
      return (await command(args)).split("\n").map((line) => line.trim());
    } catch {
      return [];
    }
  };
  let removed = 0;
  // Tags, not image ids: two runs may own tags of one image.
  const tags = await lines([
    "image",
    "ls",
    "--filter",
    `label=${EXPIRES_LABEL}`,
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ]);
  for (const tag of tags.filter((item) => DISPOSABLE_TAG.test(item))) {
    try {
      const label = (
        await command([
          "image",
          "inspect",
          "--format",
          `{{index .Config.Labels "${EXPIRES_LABEL}"}}`,
          tag,
        ])
      ).trim();
      if (!/^\d{1,16}$/.test(label) || Number(label) >= now) continue;
      await execute(engine, ["image", "rm", tag], { timeout: 30_000, maxBuffer: 65536 });
      removed++;
    } catch {
      // In use by a container or already removed; the next sweep retries.
    }
  }
  if (engine !== "docker") return removed;
  const containers = await lines([
    "ps",
    "--all",
    "--filter",
    "name=buildx_buildkit_plenger-",
    "--format",
    "{{.Names}}",
  ]);
  for (const container of containers) {
    const builder = BUILDER_CONTAINER.exec(container)?.[1];
    if (!builder) continue;
    try {
      const created = Date.parse(
        (await command(["inspect", "--format", "{{.Created}}", container])).trim(),
      );
      if (!Number.isFinite(created) || created + DISPOSABLE_RUNTIME_TTL.builderMs >= now) continue;
      try {
        await removeBuilder(engine, builder);
      } catch {
        // The builder's registration is gone; remove its container and cache volume directly.
        await execute(engine, ["rm", "--force", "--volumes", container], {
          timeout: 30_000,
          maxBuffer: 65536,
        });
        await execute(engine, ["volume", "rm", "--force", `${container}_state`], {
          timeout: 30_000,
          maxBuffer: 65536,
        });
      }
      removed++;
    } catch {
      // Already removed or refused; the next sweep retries.
    }
  }
  return removed;
}
