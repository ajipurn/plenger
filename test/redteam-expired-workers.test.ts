import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import { startDisposableServices } from "../src/redteam/services.ts";
import { removeExpiredWorkers, runWorker } from "../src/redteam/worker.ts";

const image = `sha256:${"a".repeat(64)}`;

/** Answer every engine command with its stdout and exit code; returns the argument lists. */
function engine(answer: (args: string[]) => { stdout?: string; code?: number }): string[][] {
  const calls: string[][] = [];
  spawn.mockImplementation((_program: string, args: string[]) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    const { stdout = "", code = 0 } = answer(args);
    child.stdout.once("end", () => queueMicrotask(() => child.emit("close", code)));
    queueMicrotask(() => {
      child.stderr.end();
      child.stdout.end(stdout);
    });
    return child;
  });
  return calls;
}

afterEach(() => {
  vi.clearAllMocks();
});

it("removes only labelled workers past their expiry", async () => {
  const labels: Record<string, { stdout?: string; code?: number }> = {
    expired: { stdout: "1000\n" },
    live: { stdout: "9000\n" },
    vanished: { code: 1 },
    malformed: { stdout: "\n" },
  };
  const calls = engine((args) => {
    if (args[0] === "ps") return { stdout: `${Object.keys(labels).join("\n")}\n` };
    if (args[0] === "inspect") return labels[args.at(-1) as string] ?? { code: 1 };
    return {};
  });
  expect(await removeExpiredWorkers("docker", 5000)).toBe(1);
  expect(calls[0]).toEqual(["ps", "--all", "--quiet", "--filter", "label=org.plenger.expires"]);
  expect(calls.filter((args) => args[0] === "rm")).toEqual([
    ["rm", "--force", "--volumes", "expired"],
  ]);
});

it("leaves everything in place when the engine cannot list containers", async () => {
  const calls = engine(() => ({ code: 1 }));
  expect(await removeExpiredWorkers("podman", 5000)).toBe(0);
  expect(calls).toHaveLength(1);
});

it("labels each worker with its deadline plus the backstop grace", async () => {
  const calls = engine((args) => (args[0] === "run" ? { stdout: "{}" } : {}));
  const before = Date.now();
  await runWorker(`docker:${image}`, { timeoutMs: 5000 });
  const after = Date.now();
  const run = calls.find((args) => args[0] === "run") ?? [];
  const label = run[run.indexOf("org.plenger.purpose=qualification") + 2] ?? "";
  const expires = Number(label.replace("org.plenger.expires=", ""));
  expect(label).toMatch(/^org\.plenger\.expires=\d+$/);
  expect(expires).toBeGreaterThanOrEqual(before + 15_000);
  expect(expires).toBeLessThanOrEqual(after + 15_000);
});

it.each(["docker", "podman"] as const)(
  "removes service containers with their anonymous data volumes on %s",
  async (program) => {
    const containers = new Set<string>();
    const calls = engine((args) => {
      if (args[0] === "run") containers.add(args[args.indexOf("--name") + 1] as string);
      if (args[0] === "exec") return { stdout: "alive PONG" };
      if (args[0] === "ps") {
        const name = (args.at(-1) as string).replace(/^name=\^\//, "").replace(/\$$/, "");
        return { stdout: containers.has(name) ? name : "" };
      }
      if (args[0] === "rm") containers.delete(args.at(-1) as string);
      return {};
    });
    const services = await startDisposableServices(
      program,
      ["mysql", "redis"],
      new AbortController().signal,
      { timeoutMs: 10_000 },
    );
    expect(containers.size).toBe(2);
    expect(await services.dispose()).toBe(true);
    expect(containers.size).toBe(0);
    const removals = calls.filter((args) => args[0] === "rm");
    expect(removals).toHaveLength(2);
    for (const args of removals) expect(args).toContain("--volumes");
    expect(calls.at(-1)).toEqual(["network", "rm", services.network]);
  },
);
