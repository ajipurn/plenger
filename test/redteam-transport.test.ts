import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import { WORKER_PROTOCOL_VERSION } from "../src/redteam/constants.ts";
import { qualifyLlmfyBudget } from "../src/redteam/qualification.ts";
import { WorkerError } from "../src/redteam/worker.ts";

const image = `sha256:${"a".repeat(64)}`;
const limits = { maxModelCalls: 9, maxTokens: 1, timeoutMs: 30_000 };
const ready = {
  type: "ready",
  protocolVersion: WORKER_PROTOCOL_VERSION,
  python: "3.12.13",
  llmfy: "0.11.0",
  os: "Linux",
  arch: "aarch64",
  isolationChecks: [
    "linux",
    "python-version",
    "non-root",
    "no-capabilities",
    "no-new-privileges",
    "seccomp-filter",
    "loopback-only",
    "read-only-root",
    "private-temporary-files",
    "memory-limit",
    "no-swap",
    "process-limit",
    "cpu-limit",
    "no-host-file",
    "no-host-environment",
    "no-container-socket",
    "image-write-denied",
    "temporary-write",
  ],
};
const started = { type: "trial_started", case: "approved-sync" };
const request = {
  type: "model_request",
  id: 1,
  case: "approved-sync",
  messages: [{ role: "user", content: "日本🌿" }],
  tools: null,
};
function frames(...messages: unknown[]): Buffer {
  return Buffer.from(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
}

// A process double exercises the actual launch/transport/cleanup interface without
// a daemon. Container tests separately establish real process and isolation behavior.
class Worker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  input: string[] = [];
  killed = false;
  onKill: (() => void) | undefined;
  kill = vi.fn(() => {
    if (!this.killed) {
      this.killed = true;
      this.onKill?.();
      queueMicrotask(() => this.close(null));
    }
    return true;
  });

  constructor() {
    super();
    this.stdin.on("data", (data: Buffer) => this.input.push(data.toString()));
  }

  close(code: number | null) {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
  }
}

let worker: Worker;
let cleanup: Worker;
let emit: (worker: Worker) => void;
let failCleanup = false;
beforeEach(() => {
  failCleanup = false;
  emit = (child) => child.stdout.write(frames(ready, started, request));
  spawn.mockImplementation((_program: string, args: string[]) => {
    const child = new Worker();
    if (args[0] === "run") {
      worker = child;
      queueMicrotask(() => emit(child));
    } else {
      expect(args.slice(0, 4)).toEqual(["rm", "--force", "--time=0", "--ignore"]);
      cleanup = child;
      queueMicrotask(() => {
        if (failCleanup) child.stderr.write("cleanup refused");
        child.close(failCleanup ? 1 : 0);
      });
    }
    return child;
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("clears the transport fallback deadline when the shared budget expires", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const launched = Promise.withResolvers<void>();
  emit = (child) => {
    child.stdout.write(frames(ready, started));
    // Retain close until both formerly competing timers would have fired.
    child.kill.mockImplementation(() => {
      child.killed = true;
      return true;
    });
    launched.resolve();
  };
  const result = qualifyLlmfyBudget(image, { limits: { ...limits, timeoutMs: 100 } });
  await launched.promise;
  await vi.advanceTimersByTimeAsync(100);
  expect(worker.kill).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  worker.close(null);
  expect(await result).toMatchObject({
    completed: false,
    budget: { state: "stopped", stopReasons: ["deadline"] },
  });
});

it("decodes fragmented frames and split UTF-8 before stopping a denied model request", async () => {
  emit = (child) => {
    const data = frames(ready, started, request);
    const split = data.indexOf(Buffer.from("日")) + 1;
    child.stdout.write(data.subarray(0, 7));
    child.stdout.write(data.subarray(7, split));
    child.stdout.write(data.subarray(split, split + 1));
    child.stdout.write(data.subarray(split + 1));
  };
  const report = await qualifyLlmfyBudget(image, { limits });
  expect(report).toMatchObject({
    completed: false,
    budget: {
      state: "stopped",
      stopReasons: ["token-limit"],
      callsAdmitted: 0,
    },
  });
  expect(report.cases[0]).toMatchObject({
    started: true,
    completed: false,
    outcome: "inconclusive",
  });
  expect(worker.kill).toHaveBeenCalledWith("SIGKILL");
  expect(worker.input.join("")).not.toContain("model_response");
  expect(JSON.parse(worker.input.join("").split("\n")[0] ?? "")).toMatchObject({
    protocolVersion: WORKER_PROTOCOL_VERSION,
    mode: "budget",
  });
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(cleanup.stdin.writableEnded).toBe(true);
});

it("dispatches only admitted responses and drains prior events before returning partial results", async () => {
  const events = [
    { stage: "model_tool_proposal", tool: "update_order" },
    { stage: "tool_handler_entered", tool: "update_order" },
    { stage: "recording_effect", order: "approved-order", status: "shipped" },
    { stage: "tool_handler_returned", tool: "update_order" },
  ];
  emit = (child) =>
    child.stdout.write(
      frames(
        ready,
        started,
        request,
        ...events.map((event) => ({ type: "event", case: "approved-sync", event })),
        { ...request, id: 2 },
      ),
    );
  const report = await qualifyLlmfyBudget(image, {
    limits: { ...limits, maxModelCalls: 1, maxTokens: 100_000 },
  });
  expect(report.budget).toMatchObject({ callsAdmitted: 1, stopReasons: ["model-call-limit"] });
  expect(report.cases[0]).toMatchObject({ events, completed: false, outcome: "inconclusive" });
  const responses = worker.input
    .join("")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line));
  expect(responses).toHaveLength(1);
  expect(responses[0]).toMatchObject({ type: "model_response", id: 1 });
});

it.each(["malformed-json", "bad-protocol", "truncated-frame", "invalid-utf8"])(
  "surfaces %s even after the budget has aborted the transport",
  async (failure) => {
    emit = (child) => {
      let extra: Buffer;
      if (failure === "malformed-json") extra = Buffer.from("{broken}\n");
      else if (failure === "bad-protocol") extra = frames({ type: "unknown" });
      else if (failure === "invalid-utf8") extra = Buffer.from([0xff, 10]);
      else extra = Buffer.from('{"incomplete":');
      child.stdout.write(Buffer.concat([frames(ready, started, request), extra]));
    };
    const error = await qualifyLlmfyBudget(image, { limits }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(WorkerError);
    const errors = (error as WorkerError).errors as Error[];
    expect(errors[0]?.message).toContain("cancelled");
    expect(errors[1]?.message).toContain(
      failure === "truncated-frame" ? "Truncated" : "protocol failed",
    );
    expect(spawn).toHaveBeenCalledTimes(2);
  },
);

it("surfaces output overflow racing a budget interruption", async () => {
  emit = (child) => {
    child.onKill = () => child.stdout.write(Buffer.alloc(65_537, 120));
    child.stdout.write(frames(ready, started, request));
  };
  const error = await qualifyLlmfyBudget(image, { limits }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(WorkerError);
  expect((error as WorkerError).errors.map((item) => (item as Error).message)).toEqual([
    "Worker cancelled.",
    "Worker output limit exceeded.",
  ]);
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("preserves interruption and cleanup failures instead of returning a partial report", async () => {
  failCleanup = true;
  const error = await qualifyLlmfyBudget(image, { limits }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(WorkerError);
  expect((error as WorkerError).cleanupConfirmed).toBe(false);
  const errors = (error as WorkerError).errors as Error[];
  expect(errors[0]?.message).toContain("cancelled");
  expect(errors[1]?.message).toContain("cleanup failed");
  const cause = errors[1]?.cause;
  expect(cause).toBeInstanceOf(Error);
  expect((cause as Error).message).toContain("cleanup refused");
});

it("stops processing queued provider work after an independent protocol failure", async () => {
  emit = (child) => child.stdout.write(frames(ready, started, { type: "unknown" }, request));
  await expect(
    qualifyLlmfyBudget(image, { limits: { ...limits, maxTokens: 100_000 } }),
  ).rejects.toThrow("protocol failed");
  expect(worker.input.join("")).not.toContain("model_response");
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("rejects a worker that exits without completing the protocol", async () => {
  emit = (child) => {
    child.stdout.write(frames(ready, started));
    child.close(0);
  };
  await expect(qualifyLlmfyBudget(image, { limits })).rejects.toThrow(
    "before completing its protocol",
  );
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("bounds message count even if each frame is small", async () => {
  emit = (child) => child.stdout.write(Buffer.from("{}\n".repeat(257)));
  await expect(qualifyLlmfyBudget(image, { limits })).rejects.toThrow("message limit exceeded");
  expect(spawn).toHaveBeenCalledTimes(2);
});
