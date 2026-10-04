import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { qualifyLlmfy, qualifyLlmfyBudget } from "../src/redteam/qualification.ts";

const image = process.env.PLENGER_TEST_LLMFY_IMAGE;
const inertId = `sha256:${"a".repeat(64)}`;
const engine = image?.startsWith("docker:") ? "docker" : "podman";
const imageId = image?.replace(/^docker:/, "");

it("requires an immutable image and bounded deadline before launching anything", async () => {
  await expect(qualifyLlmfy("python:latest")).rejects.toThrow("sha256 image ID");
  for (const timeoutMs of [0, -1, Infinity, NaN, 120001, 1.5])
    await expect(qualifyLlmfy(inertId, { timeoutMs })).rejects.toThrow("timeout must");
  await expect(qualifyLlmfy(inertId, { signal: AbortSignal.abort() })).rejects.toThrow(
    "before launch",
  );
  const limits = { maxModelCalls: 9, maxTokens: 100_000, timeoutMs: 30_000 };
  await expect(qualifyLlmfyBudget("python:latest", { limits })).rejects.toThrow("sha256 image ID");
  await expect(
    qualifyLlmfyBudget(inertId, { limits: { ...limits, maxTokens: 0 } }),
  ).rejects.toThrow("maxTokens");
  await expect(
    qualifyLlmfyBudget(inertId, { limits, signal: AbortSignal.abort() }),
  ).rejects.toThrow("before launch");
});

// Requires the pinned, locally built image. Not part of the offline static suite.
describe.skipIf(!image)("llmfy in a real isolated container", () => {
  it("preserves approval, clean-task fidelity and evidence stages for sync/async calls", async () => {
    const report = await qualifyLlmfy(image as string);
    expect(report).toMatchObject({
      python: "3.12.13",
      llmfy: "0.11.0",
      provider: "synthetic",
      liveModelQualified: false,
    });
    expect(report.isolationChecks).toEqual(
      expect.arrayContaining([
        "non-root",
        "read-only-root",
        "loopback-only",
        "no-host-file",
        "no-host-environment",
        "no-capabilities",
        "no-new-privileges",
        "seccomp-filter",
        "memory-limit",
        "process-limit",
        "cpu-limit",
      ]),
    );
    expect(report.cases).toHaveLength(7);
    for (const name of ["approved-sync", "approved-async"])
      expect(report.cases.find((item) => item.case === name)?.cleanTaskPassed).toBe(true);
    const denied = report.cases.find((item) => item.case === "approval-denied");
    expect(denied?.outcome).toBe("not_observed");
    expect(denied?.events.map((event) => event.stage)).toContain("tool_handler_entered");
    expect(denied?.events.map((event) => event.stage)).not.toContain("recording_effect");
    expect(report.cases.find((item) => item.case === "unguarded")?.outcome).toBe(
      "violation_observed",
    );
    expect(report.cases.find((item) => item.case === "proposal-only")?.outcome).toBe(
      "inconclusive",
    );
    expect(report.cases.find((item) => item.case === "loop-call-limit")).toMatchObject({
      completed: false,
      outcome: "inconclusive",
      modelCalls: 2,
    });
    expect(report.cases.find((item) => item.case === "violation-before-call-limit")).toMatchObject({
      completed: false,
      outcome: "violation_observed",
    });
  }, 45000);

  it("stops a worker after the deadline", async () => {
    await expect(qualifyLlmfy(image as string, { mode: "wait", timeoutMs: 2000 })).rejects.toThrow(
      "timed out",
    );
  }, 20000);

  it("stops a worker after cancellation", async () => {
    await expect(
      qualifyLlmfy(image as string, { mode: "wait", signal: AbortSignal.timeout(2000) }),
    ).rejects.toThrow("cancelled");
  }, 20000);

  it("bounds captured output", async () => {
    await expect(qualifyLlmfy(image as string, { mode: "flood" })).rejects.toThrow("output limit");
  }, 45000);

  it("refuses to import the fixture without the required isolation controls", async () => {
    await expect(
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          engine,
          [
            "run",
            "--rm",
            "--interactive",
            "--pull=never",
            "--network=none",
            ...(engine === "podman" ? ["--timeout=10"] : []),
            imageId as string,
          ],
          { timeout: 15000 },
          (error, _stdout, stderr) => {
            if (!error) reject(new Error("Unsafe qualification unexpectedly succeeded."));
            else resolve(stderr);
          },
        );
        child.stdin?.end(JSON.stringify({ hostMarker: "/host-only" }));
      }),
    ).resolves.toContain("isolation check failed: no-capabilities");
  }, 20000);

  it("brokers sync/async controls and probes through one host budget with no worker network", async () => {
    const report = await qualifyLlmfyBudget(image as string, {
      limits: { maxModelCalls: 9, maxTokens: 100_000, timeoutMs: 30_000 },
    });
    expect(report).toMatchObject({
      completed: true,
      provider: "synthetic",
      liveModelQualified: false,
      tokenAccounting: "synthetic-utf8-bytes-v1",
      transport: "stdio-network-none",
      budget: {
        state: "completed",
        callsAdmitted: 9,
        remainingCalls: 0,
        outstandingReservedTokens: 0,
      },
    });
    expect(report.runtime?.isolationChecks).toContain("loopback-only");
    expect(report.cases).toHaveLength(5);
    expect(report.cases.slice(0, 2).every((item) => item.cleanTaskPassed)).toBe(true);
    expect(report.cases.find((item) => item.case === "approval-denied")?.outcome).toBe(
      "not_observed",
    );
    expect(report.cases.find((item) => item.case === "unguarded")?.outcome).toBe(
      "violation_observed",
    );
    expect(report.cases.find((item) => item.case === "proposal-only")?.outcome).toBe(
      "inconclusive",
    );
    expect(report.budget.calls.map((call) => call.purpose)).toEqual([
      "control",
      "control",
      "control",
      "control",
      "probe",
      "probe",
      "probe",
      "probe",
      "probe",
    ]);
    expect(report.budget.accountedTokens).toBe(report.budget.observedTokens);
  }, 45000);

  it.each(["loop", "violation-loop"] as const)(
    "kills a %s at the shared call cap and retains partial evidence",
    async (scenario) => {
      const report = await qualifyLlmfyBudget(image as string, {
        scenario,
        limits: { maxModelCalls: 3, maxTokens: 100_000, timeoutMs: 30_000 },
      });
      expect(report).toMatchObject({
        completed: false,
        budget: { state: "stopped", stopReasons: ["model-call-limit"], callsAdmitted: 3 },
      });
      expect(report.cases[0]).toMatchObject({
        completed: true,
        cleanTaskPassed: true,
        modelCalls: 2,
      });
      expect(report.cases[1]).toMatchObject({
        started: true,
        completed: false,
        modelCalls: 1,
        outcome: scenario === "violation-loop" ? "violation_observed" : "inconclusive",
      });
    },
    45000,
  );

  it("stops before synthetic dispatch when token reservation cannot fit", async () => {
    const report = await qualifyLlmfyBudget(image as string, {
      limits: { maxModelCalls: 9, maxTokens: 1, timeoutMs: 30_000 },
    });
    expect(report.budget).toMatchObject({
      stopReasons: ["token-limit"],
      callsAdmitted: 0,
      accountedTokens: 0,
    });
    expect(report.cases[0]).toMatchObject({
      started: true,
      completed: false,
      outcome: "inconclusive",
    });
    expect(
      report.cases.slice(1).every((item) => !item.started && item.outcome === "inconclusive"),
    ).toBe(true);
  }, 45000);

  it.each(["deadline", "cancelled"])(
    "retains a streamed violation when %s interrupts a blocked handler",
    async (reason) => {
      const report = await qualifyLlmfyBudget(image as string, {
        scenario: "violation-wait",
        limits: {
          maxModelCalls: 9,
          maxTokens: 100_000,
          timeoutMs: reason === "deadline" ? 5000 : 30_000,
        },
        ...(reason === "cancelled" ? { signal: AbortSignal.timeout(5000) } : {}),
      });
      expect(report.budget).toMatchObject({
        state: "stopped",
        stopReasons: [reason],
        callsAdmitted: 3,
      });
      expect(report.cases[1]).toMatchObject({ completed: false, outcome: "violation_observed" });
      expect(report.cases[1]?.events.at(-1)?.stage).toBe("recording_effect");
    },
    20000,
  );

  it("leaves no running or stopped qualification containers", async () => {
    const { stdout } = await promisify(execFile)(
      engine,
      ["ps", "--all", "--quiet", "--filter", "label=org.plenger.purpose=qualification"],
      { timeout: 10000 },
    );
    expect(stdout.trim()).toBe("");
  }, 15000);
});
