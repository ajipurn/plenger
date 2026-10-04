import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256Hex } from "../shared/hash.ts";
import { embeddedAsset } from "../shared/runtime.ts";
import { removeExpiredWorkers } from "./worker.ts";

const execute = promisify(execFile);

/** Every file of each managed runtime recipe; the binary build embeds exactly these. */
export const RUNTIME_FILES = {
  llmfy: ["Dockerfile", "requirements.txt", "qualify.py", "worker.py", "project/agent.py"],
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

async function prepareManagedRuntime(
  profile: RuntimeProfile,
  files: readonly string[],
  signal: AbortSignal,
  engine = "podman",
): Promise<string> {
  signal.throwIfAborted();
  const recipe = await Promise.all(
    files.map(async (path) => ({
      path,
      content:
        embeddedAsset(`runtimes/${profile}/${path}`) ??
        (await readFile(
          fileURLToPath(new URL(`../../runtimes/${profile}/${path}`, import.meta.url)),
        )),
    })),
  );
  const digest = sha256Hex(
    Buffer.concat(recipe.map((file) => Buffer.concat([Buffer.from(file.path), file.content]))),
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
  const directory = await mkdtemp(join(tmpdir(), "plenger-runtime-"));
  try {
    for (const file of recipe) {
      await mkdir(join(directory, file.path, ".."), { recursive: true });
      await writeFile(join(directory, file.path), file.content, { mode: 0o600 });
    }
    await execute(engine, ["build", "--tag", tag, directory], {
      signal,
      timeout: profile === "vercel" ? 600_000 : 120_000,
      maxBuffer: 1024 * 1024,
    });
    return await inspect();
  } catch (cause) {
    throw new Error(
      `Managed runtime preparation failed. Install/start ${engine} and retry; no project code was executed.`,
      { cause },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
