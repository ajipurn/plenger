import { access } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});
vi.mock("../src/redteam/worker.ts", () => ({
  EXPIRES_LABEL: "org.plenger.expires",
  removeExpiredWorkers: vi.fn(async () => 0),
}));
vi.mock("../src/redteam/services.ts", () => ({ removeExpiredNetworks: vi.fn(async () => 0) }));

import {
  BUILDKIT_IMAGE,
  DISPOSABLE_RUNTIME_TTL,
  RUNTIME_BUILD_TIMEOUT_MS,
} from "../src/redteam/constants.ts";
import {
  prepareFastapiRuntime,
  prepareLlmfyRuntime,
  prepareRunRuntime,
  RuntimeBuildError,
  RuntimeCleanupError,
  removeExpiredRuntimes,
} from "../src/redteam/runtime.ts";

const image = `sha256:${"a".repeat(64)}`;
let tags: Set<string>;
let contexts: string[];
let docker: boolean;
let failBuild: (() => void) | undefined;
let failCleanup: boolean;
let failCacheCleanup: boolean;
let failBuilderCreate: boolean;
let builders: Set<string>;

beforeEach(() => {
  tags = new Set();
  contexts = [];
  docker = true;
  failBuild = undefined;
  failCleanup = false;
  failCacheCleanup = false;
  failBuilderCreate = false;
  builders = new Set();
  execute.mockImplementation(async (engine: string, args: string[]) => {
    if (engine === "docker" && !docker) throw new Error("Docker unavailable.");
    if (args[0] === "buildx") {
      const name = args.at(-1) as string;
      if (args[1] === "create") {
        if (failBuilderCreate) throw new Error("'buildx' is not a docker command.");
        builders.add(args[args.indexOf("--name") + 1] as string);
      }
      if (args[1] === "rm") {
        if (failCacheCleanup) throw new Error("Cache removal refused.");
        if (!builders.delete(name)) throw new Error("No builder found.");
      }
      if (args[1] === "inspect" && !builders.has(name)) throw new Error("No builder found.");
    }
    if (args[0] === "build" || args[1] === "build") {
      contexts.push(args.at(-1) as string);
      tags.add(args[args.indexOf("--tag") + 1] as string);
      failBuild?.();
    }
    if (args[0] === "image") {
      const tag = args.at(-1) as string;
      if (args[1] === "inspect") {
        if (!tags.has(tag)) throw new Error("Image absent.");
        return { stdout: `${image}\n`, stderr: "" };
      }
      if (args[1] === "ls") return { stdout: tags.has(tag) ? image : "", stderr: "" };
      if (args[1] === "rm") {
        if (failCleanup) throw new Error("Removal refused.");
        tags.delete(tag);
      }
    }
    return { stdout: "", stderr: "" };
  });
});
afterEach(() => vi.clearAllMocks());

it("removes the dedicated Docker build cache and context before trials, then its image tag", async () => {
  const runtime = await prepareRunRuntime("llmfy", new AbortController().signal);
  expect(runtime.image).toBe(`docker:${image}`);
  const calls = execute.mock.calls.map((call) => call[1] as string[]);
  const create = calls.find((args) => args[1] === "create") as string[];
  const builder = create[create.indexOf("--name") + 1];
  expect(create).toContain(`image=${BUILDKIT_IMAGE}`);
  expect(create).not.toContain("--use");
  expect(calls).toContainEqual(["buildx", "rm", "--force", builder]);
  expect(calls.find((args) => args[1] === "build")).toEqual(
    expect.arrayContaining(["--builder", builder, "--load"]),
  );
  for (const context of contexts) await expect(access(context)).rejects.toThrow();
  expect(tags.size).toBe(1);
  await runtime.dispose();
  expect(tags.size).toBe(0);
  expect(execute.mock.calls.at(-1)?.[1]).toEqual([
    "image",
    "rm",
    expect.stringMatching(/^localhost\/plenger-llmfy:/),
  ]);
  await runtime.dispose();
});

it("keeps concurrent runs with identical image ids separate without forcing image removal", async () => {
  const first = await prepareRunRuntime("llmfy", new AbortController().signal);
  const second = await prepareRunRuntime("llmfy", new AbortController().signal);
  expect(first.image).toBe(second.image);
  expect(tags.size).toBe(2);
  await first.dispose();
  expect(tags.size).toBe(1);
  await second.dispose();
  expect(tags.size).toBe(0);
  expect(execute.mock.calls.some(([, args]) => args.includes("prune"))).toBe(false);
  for (const [, args] of execute.mock.calls)
    if (args[0] === "image" && args[1] === "rm") expect(args).not.toContain("--force");
});

it("disables Podman intermediate image caching and removes the resulting runtime", async () => {
  docker = false;
  const runtime = await prepareRunRuntime("vercel", new AbortController().signal);
  expect(runtime.image).toBe(image);
  const build = execute.mock.calls.find(([, args]) => args[0] === "build")?.[1];
  expect(build).toEqual(expect.arrayContaining(["--layers=false", "--no-cache", "--force-rm"]));
  await runtime.dispose();
  expect(tags.size).toBe(0);
});

it.each([false, true])(
  "cleans partial images and cache after a build fails (cancelled=%s)",
  async (cancelled) => {
    const controller = new AbortController();
    failBuild = () => {
      if (cancelled) controller.abort();
      throw Object.assign(new Error("Build failed."), { stderr: "no wheel" });
    };
    await expect(prepareRunRuntime("llmfy", controller.signal)).rejects.toBeInstanceOf(
      RuntimeBuildError,
    );
    expect(tags.size).toBe(0);
    for (const context of contexts) await expect(access(context)).rejects.toThrow();
    const cleanup = execute.mock.calls.filter(([, args]) => args[1] === "rm");
    expect(cleanup.map(([, args]) => args[0])).toEqual(["buildx", "image"]);
    for (const [, , options] of cleanup) expect(options.signal).toBeUndefined();
  },
);

it("reports image removal failures and allows a later cleanup retry", async () => {
  const runtime = await prepareRunRuntime("llmfy", new AbortController().signal);
  failCleanup = true;
  await expect(runtime.dispose()).rejects.toBeInstanceOf(RuntimeCleanupError);
  expect(tags.size).toBe(1);
  failCleanup = false;
  await runtime.dispose();
  expect(tags.size).toBe(0);
});

it("does not start workers when its build cache could not be removed", async () => {
  failCacheCleanup = true;
  await expect(prepareRunRuntime("llmfy", new AbortController().signal)).rejects.toBeInstanceOf(
    RuntimeCleanupError,
  );
  expect(tags.size).toBe(0);
  for (const context of contexts) await expect(access(context)).rejects.toThrow();
});

it("owns the FastAPI image until preparation releases it", async () => {
  const runtime = await prepareFastapiRuntime("llmfy==0.6.0\n", new AbortController().signal);
  expect(runtime).toMatchObject({ image: `docker:${image}`, platform: "native", engine: "docker" });
  expect(tags.size).toBe(1);
  await runtime.dispose();
  expect(tags.size).toBe(0);
});

it("keeps qualification fixture images reusable", async () => {
  const signal = new AbortController().signal;
  expect(await prepareLlmfyRuntime(signal)).toBe(`docker:${image}`);
  const count = contexts.length;
  expect(await prepareLlmfyRuntime(signal)).toBe(`docker:${image}`);
  expect(contexts).toHaveLength(count);
  expect(execute.mock.calls.some(([, args]) => args[0] === "buildx")).toBe(false);
  expect(tags.size).toBe(1);
});

it("reports a missing Buildx as a build failure, not as a cleanup failure", async () => {
  failBuilderCreate = true;
  const failure = prepareRunRuntime("llmfy", new AbortController().signal);
  await expect(failure).rejects.toBeInstanceOf(RuntimeBuildError);
  await expect(failure).rejects.toThrow("with Buildx");
  expect(tags.size).toBe(0);
  for (const context of contexts) await expect(access(context)).rejects.toThrow();
});

it("labels disposable images for expiry and gives uncached builds their own deadline", async () => {
  const before = Date.now();
  const runtime = await prepareRunRuntime("llmfy", new AbortController().signal);
  const [, build, options] = execute.mock.calls.find(([, args]) => args[1] === "build") ?? [];
  const label = (build as string[])[(build as string[]).indexOf("--label") + 1] as string;
  expect(label).toMatch(/^org\.plenger\.expires=\d+$/);
  expect(Number(label.split("=")[1])).toBeGreaterThanOrEqual(
    before + DISPOSABLE_RUNTIME_TTL.imageMs,
  );
  expect(options).toMatchObject({ timeout: RUNTIME_BUILD_TIMEOUT_MS });
  await runtime.dispose();
});

it("sweeps expired run images and stale dedicated builders, keeping live ones", async () => {
  const now = Date.now();
  const id = (digit: string) =>
    `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`;
  const expiredTag = `localhost/plenger-llmfy:${id("1")}`;
  const liveTag = `localhost/plenger-vercel:${id("2")}`;
  const staleBuilder = `plenger-${id("3")}`;
  const liveBuilder = `plenger-${id("4")}`;
  const removed: string[][] = [];
  execute.mockImplementation(async (_engine: string, args: string[]) => {
    if (args[0] === "image" && args[1] === "ls")
      return { stdout: `${expiredTag}\n${liveTag}\nother/image:latest\n`, stderr: "" };
    if (args[0] === "image" && args[1] === "inspect")
      return { stdout: `${args.at(-1) === expiredTag ? now - 1 : now + 60_000}\n`, stderr: "" };
    if (args[0] === "ps")
      return {
        stdout: `buildx_buildkit_${staleBuilder}0\nbuildx_buildkit_${liveBuilder}0\nunrelated\n`,
        stderr: "",
      };
    if (args[0] === "inspect") {
      const stale = args.at(-1) === `buildx_buildkit_${staleBuilder}0`;
      const created = stale ? now - DISPOSABLE_RUNTIME_TTL.builderMs - 1 : now - 1000;
      return { stdout: `${new Date(created).toISOString()}\n`, stderr: "" };
    }
    if (args.includes("rm")) removed.push(args);
    return { stdout: "", stderr: "" };
  });
  expect(await removeExpiredRuntimes("docker", now)).toBe(2);
  expect(removed).toEqual([
    ["image", "rm", expiredTag],
    ["buildx", "rm", "--force", staleBuilder],
  ]);
});
