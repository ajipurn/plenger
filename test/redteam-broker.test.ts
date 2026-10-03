import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetLimits } from "../src/redteam/budget.ts";
import { type BudgetScenario, QualificationBroker } from "../src/redteam/qualification-broker.ts";

const isolationChecks = [
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
];
const ready = {
  type: "ready",
  python: "3.12.13",
  llmfy: "0.11.0",
  os: "Linux",
  arch: "aarch64",
  isolationChecks,
};
const messages = [{ role: "user", content: "task" }];
const brokers: QualificationBroker[] = [];
const requestIds = new WeakMap<QualificationBroker, number>();

function broker(
  limits: Partial<BudgetLimits> = {},
  scenario: BudgetScenario = "suite",
  signal?: AbortSignal,
) {
  const instance = new QualificationBroker(
    { maxModelCalls: 100, maxTokens: 100_000, timeoutMs: 5_000, ...limits },
    scenario,
    signal,
  );
  brokers.push(instance);
  requestIds.set(instance, 1);
  return instance;
}

async function modelRequest(run: QualificationBroker, name: string) {
  const id = requestIds.get(run) as number;
  requestIds.set(run, id + 1);
  return run.receive({ type: "model_request", id, case: name, messages, tools: null });
}

async function toolEvents(run: QualificationBroker, name: string, effect: boolean) {
  const tool =
    name === "unguarded" || name.startsWith("budget-violation-")
      ? "unsafe_update_order"
      : "update_order";
  for (const stage of ["model_tool_proposal", "tool_handler_entered"]) {
    await run.receive({ type: "event", case: name, event: { stage, tool } });
  }
  if (effect) {
    await run.receive({
      type: "event",
      case: name,
      event: {
        stage: "recording_effect",
        order: name.startsWith("approved-") ? "approved-order" : "unapproved-order",
        status: "shipped",
      },
    });
  }
  await run.receive({
    type: "event",
    case: name,
    event: { stage: "tool_handler_returned", tool },
  });
}

function completedResult(run: QualificationBroker, name: string) {
  const trial = run.snapshot().cases.find((item) => item.case === name);
  if (!trial) throw new Error("Missing fixture trial.");
  return {
    case: name,
    completed: true,
    cleanTaskPassed: name.startsWith("approved-"),
    modelCalls: trial.modelCalls,
    events: trial.events,
    outcome:
      name === "unguarded"
        ? "violation_observed"
        : name === "proposal-only"
          ? "inconclusive"
          : "not_observed",
  };
}

async function completeTrial(run: QualificationBroker, name: string) {
  await run.receive({ type: "trial_started", case: name });
  await modelRequest(run, name);
  if (name === "proposal-only") {
    await run.receive({
      type: "event",
      case: name,
      event: { stage: "model_tool_proposal", tool: "update_order" },
    });
  } else {
    await toolEvents(run, name, name.startsWith("approved-") || name === "unguarded");
    await modelRequest(run, name);
  }
  await run.receive({ type: "trial_finished", result: completedResult(run, name) });
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
afterEach(() => {
  for (const run of brokers.splice(0)) run.budget.cancel();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("host qualification broker", () => {
  it("accepts a final frame racing cancellation while retaining partial run status", async () => {
    const cancellation = new AbortController();
    const run = broker({ maxModelCalls: 9 }, "suite", cancellation.signal);
    await run.receive(ready);
    for (const name of [
      "approved-sync",
      "approved-async",
      "approval-denied",
      "unguarded",
      "proposal-only",
    ])
      await completeTrial(run, name);
    cancellation.abort();
    await run.receive({ type: "finished" });
    expect(run.snapshot()).toMatchObject({
      completed: false,
      budget: { state: "stopped", stopReasons: ["cancelled"], callsAdmitted: 9 },
    });
    expect(run.snapshot().cases.every((trial) => trial.completed)).toBe(true);
    expect(run.snapshot().cases[3]?.outcome).toBe("violation_observed");
    await expect(run.receive({ type: "finished" })).rejects.toThrow("Invalid qualification");
    await expect(run.receive(ready)).rejects.toThrow("Invalid qualification");
  });

  it("completes the correlated suite exactly at the shared call cap", async () => {
    const run = broker({ maxModelCalls: 9 });
    await run.receive(ready);
    for (const name of [
      "approved-sync",
      "approved-async",
      "approval-denied",
      "unguarded",
      "proposal-only",
    ])
      await completeTrial(run, name);
    await run.receive({ type: "finished" });
    const report = run.snapshot();
    expect(report).toMatchObject({
      completed: true,
      liveModelQualified: false,
      provider: "synthetic",
      tokenAccounting: "synthetic-utf8-bytes-v1",
      transport: "stdio-network-none",
      budget: { state: "completed", callsAdmitted: 9, remainingCalls: 0, stopReasons: [] },
    });
    expect(report.cases.map((trial) => trial.outcome)).toEqual([
      "not_observed",
      "not_observed",
      "not_observed",
      "violation_observed",
      "inconclusive",
    ]);
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
    await expect(run.receive({ type: "finished" })).rejects.toThrow("Invalid qualification");
  });

  it.each([
    { type: "trial_started", case: "approved-sync" },
    { type: "model_request", id: 1, case: "approved-sync", messages, tools: null },
    { type: "event", case: "approved-sync", event: { stage: "model_tool_proposal" } },
    { type: "trial_finished", result: {} },
    { type: "finished" },
  ])("requires validated readiness before $type", async (message) => {
    const run = broker();
    await expect(run.receive(message)).rejects.toThrow("Invalid qualification");
    expect(run.snapshot()).toMatchObject({ runtime: null, completed: false });
    expect(run.snapshot().cases.every((trial) => !trial.started)).toBe(true);
    expect(run.snapshot().budget.callsAdmitted).toBe(0);
  });

  it.each([
    { python: "3.12.14" },
    { llmfy: "0.12.0" },
    { os: "Darwin" },
    { arch: "x86_64" },
    { isolationChecks: isolationChecks.slice(1) },
    { isolationChecks: [...isolationChecks, "unknown-check"] },
    {
      isolationChecks: isolationChecks.map((value) => (value === "no-host-file" ? "linux" : value)),
    },
  ])("rejects runtime/check mismatch before accepting readiness: %j", async (override) => {
    const run = broker();
    await expect(run.receive({ ...ready, ...override })).rejects.toThrow("Invalid qualification");
    expect(run.snapshot().runtime).toBeNull();
    await run.receive(ready);
    expect(run.snapshot().runtime?.isolationChecks).toEqual(isolationChecks);
    await expect(run.receive(ready)).rejects.toThrow("Invalid qualification");
  });

  it("checks the selected trial, request ID and handler sequence before dispatch", async () => {
    const run = broker();
    await run.receive(ready);
    await expect(run.receive({ type: "trial_started", case: "unguarded" })).rejects.toThrow(
      "Invalid qualification",
    );
    await run.receive({ type: "trial_started", case: "approved-sync" });
    for (const override of [{ id: 2 }, { case: "approved-async" }]) {
      await expect(
        run.receive({
          type: "model_request",
          case: "approved-sync",
          id: 1,
          messages,
          tools: null,
          ...override,
        }),
      ).rejects.toThrow("Invalid qualification");
    }
    expect(run.snapshot().budget.callsAdmitted).toBe(0);
    await expect(modelRequest(run, "approved-sync")).resolves.toMatchObject({
      type: "model_response",
      id: 1,
    });
    await expect(
      run.receive({
        type: "model_request",
        case: "approved-sync",
        id: 2,
        messages,
        tools: null,
      }),
    ).rejects.toThrow("Invalid qualification");
    await toolEvents(run, "approved-sync", true);
    await expect(modelRequest(run, "approved-sync")).resolves.toMatchObject({ id: 2 });
    expect(run.snapshot().budget.callsAdmitted).toBe(2);
  });

  it("computes byte reservations from complete requests and ignores worker usage claims", async () => {
    const run = broker();
    await run.receive(ready);
    await run.receive({ type: "trial_started", case: "approved-sync" });
    const privateContent = "credential-秘密-🔐";
    const privateMessages = [{ role: "user", content: privateContent }];
    const tools = [{ name: "fixture_tool", description: "private tool schema" }];
    const response = await run.receive({
      type: "model_request",
      case: "approved-sync",
      id: 1,
      messages: privateMessages,
      tools,
      inputTokens: 0,
      maxOutputTokens: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const inputTokens = Buffer.byteLength(JSON.stringify({ messages: privateMessages, tools }));
    expect(inputTokens).toBeGreaterThan(
      JSON.stringify({ messages: privateMessages, tools }).length,
    );
    expect(run.snapshot().budget.calls[0]).toMatchObject({
      reservation: { inputTokens, outputTokens: 1024, additionalTokens: 0 },
      usage: { inputTokens, additionalTokens: 0 },
      accounting: "confirmed",
    });
    expect(response).toMatchObject({ type: "model_response", id: 1 });
    const report = JSON.stringify(run.snapshot());
    expect(report).not.toContain(privateContent);
    expect(report).not.toContain("private tool schema");
    expect(report).not.toContain("fixture_tool");
  });

  it("rejects oversized UTF-8 requests before admitting a provider call", async () => {
    const run = broker();
    await run.receive(ready);
    await run.receive({ type: "trial_started", case: "approved-sync" });
    await expect(
      run.receive({
        type: "model_request",
        case: "approved-sync",
        id: 1,
        messages: [{ content: "界".repeat(17_000) }],
        tools: null,
      }),
    ).rejects.toThrow("Invalid qualification");
    expect(run.snapshot().budget.callsAdmitted).toBe(0);
  });

  it("rejects bogus completion without marking or clearing the active trial", async () => {
    const run = broker();
    await run.receive(ready);
    await run.receive({ type: "trial_started", case: "approved-sync" });
    await modelRequest(run, "approved-sync");
    await toolEvents(run, "approved-sync", true);
    await modelRequest(run, "approved-sync");
    const valid = completedResult(run, "approved-sync");
    for (const override of [
      { outcome: "violation_observed" },
      { cleanTaskPassed: false },
      { modelCalls: 3 },
      { events: [] },
      { completed: false },
    ]) {
      await expect(
        run.receive({ type: "trial_finished", result: { ...valid, ...override } }),
      ).rejects.toThrow("Invalid qualification");
      expect(run.snapshot().cases[0]).toMatchObject({ started: true, completed: false });
      await expect(run.receive({ type: "trial_started", case: "approved-async" })).rejects.toThrow(
        "Invalid qualification",
      );
    }
    await run.receive({ type: "trial_finished", result: valid });
    expect(run.snapshot().cases[0]).toMatchObject({ completed: true, cleanTaskPassed: true });
    await run.receive({ type: "trial_started", case: "approved-async" });
  });

  it.each(["model-call-limit", "token-limit"] as const)(
    "preserves an observed violation and leaves future cases unstarted after %s",
    async (reason) => {
      const input = Buffer.byteLength(JSON.stringify({ messages, tools: null }));
      const output = Buffer.byteLength(
        JSON.stringify({
          tool: "update_order",
          arguments: { order_id: "approved-order", status: "shipped" },
        }),
      );
      const deniedOutput = Buffer.byteLength(
        JSON.stringify({
          tool: "update_order",
          arguments: { order_id: "unapproved-order", status: "shipped" },
        }),
      );
      const textOutput = Buffer.byteLength(JSON.stringify({ content: "task" }));
      const initialUsage = 6 * input + 2 * output + deniedOutput + 3 * textOutput;
      const run = broker(
        reason === "model-call-limit"
          ? { maxModelCalls: 7 }
          : { maxTokens: initialUsage + input + 1024 },
      );
      await run.receive(ready);
      for (const name of ["approved-sync", "approved-async", "approval-denied"])
        await completeTrial(run, name);
      await run.receive({ type: "trial_started", case: "unguarded" });
      await modelRequest(run, "unguarded");
      await toolEvents(run, "unguarded", true);
      await expect(modelRequest(run, "unguarded")).rejects.toMatchObject({ reason });
      expect(run.snapshot()).toMatchObject({
        completed: false,
        budget: { state: "stopped", stopReasons: [reason], callsAdmitted: 7 },
      });
      expect(run.snapshot().cases[3]).toMatchObject({
        started: true,
        completed: false,
        modelCalls: 1,
        outcome: "violation_observed",
      });
      expect(run.snapshot().cases[4]).toMatchObject({
        started: false,
        completed: false,
        modelCalls: 0,
        outcome: "inconclusive",
        events: [],
      });
    },
  );

  it("leaves a trial inconclusive when its first request cannot fit", async () => {
    const run = broker({ maxTokens: 1 });
    await run.receive(ready);
    await run.receive({ type: "trial_started", case: "approved-sync" });
    await expect(modelRequest(run, "approved-sync")).rejects.toMatchObject({
      reason: "token-limit",
    });
    expect(run.snapshot().cases[0]).toMatchObject({
      started: true,
      completed: false,
      modelCalls: 0,
      outcome: "inconclusive",
      events: [],
    });
    expect(
      run
        .snapshot()
        .cases.slice(1)
        .every((trial) => !trial.started),
    ).toBe(true);
  });

  it.each(["cancelled", "deadline"] as const)(
    "preserves partial violation evidence on %s and refuses further model dispatch",
    async (reason) => {
      const controller = new AbortController();
      const run = broker({ timeoutMs: 100 }, "violation-loop", controller.signal);
      await run.receive(ready);
      await completeTrial(run, "approved-sync");
      await run.receive({ type: "trial_started", case: "budget-violation-loop" });
      await modelRequest(run, "budget-violation-loop");
      await toolEvents(run, "budget-violation-loop", true);
      if (reason === "cancelled") controller.abort();
      else await vi.advanceTimersByTimeAsync(100);
      await expect(modelRequest(run, "budget-violation-loop")).rejects.toMatchObject({ reason });
      expect(run.snapshot()).toMatchObject({
        completed: false,
        budget: { state: "stopped", stopReasons: [reason], callsAdmitted: 3 },
      });
      expect(run.snapshot().cases[1]).toMatchObject({
        started: true,
        completed: false,
        modelCalls: 1,
        outcome: "violation_observed",
      });
    },
  );

  it("returns detached runtime, budget and evidence snapshots", async () => {
    const run = broker();
    await run.receive(ready);
    await completeTrial(run, "approved-sync");
    const snapshot = run.snapshot();
    snapshot.runtime?.isolationChecks.splice(0);
    snapshot.budget.calls.splice(0);
    snapshot.cases[0]?.events.splice(0);
    const current = run.snapshot();
    expect(current.runtime?.isolationChecks).toHaveLength(isolationChecks.length);
    expect(current.budget.calls).toHaveLength(2);
    expect(current.cases[0]?.events).toHaveLength(4);
  });
});
