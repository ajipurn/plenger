import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { qualifyLlmfy } from "../src/redteam/qualification.ts";

const image = process.env.PLENGER_TEST_LLMFY_IMAGE;
const inertId = `sha256:${"a".repeat(64)}`;

it("requires an immutable image and bounded deadline before launching anything", async () => {
  await expect(qualifyLlmfy("python:latest")).rejects.toThrow("sha256 image ID");
  for (const timeoutMs of [0, -1, Infinity, NaN, 120001, 1.5])
    await expect(qualifyLlmfy(inertId, { timeoutMs })).rejects.toThrow("timeout must");
  await expect(qualifyLlmfy(inertId, { signal: AbortSignal.abort() })).rejects.toThrow(
    "before launch",
  );
});

// Requires the pinned, locally built image. Not part of the offline static suite.
describe.skipIf(!image)("llmfy in a real Podman container", () => {
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
          "podman",
          [
            "run",
            "--rm",
            "--interactive",
            "--pull=never",
            "--network=none",
            "--timeout=10",
            image as string,
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

  it("leaves no running or stopped qualification containers", async () => {
    const { stdout } = await promisify(execFile)(
      "podman",
      ["ps", "--all", "--quiet", "--filter", "label=org.plenger.purpose=qualification"],
      { timeout: 10000 },
    );
    expect(stdout.trim()).toBe("");
  }, 15000);
});
