import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BudgetLimits,
  BudgetStoppedError,
  describeBudgetStop,
  ModelBudget,
  type ModelReservation,
  type TokenUsage,
} from "../src/redteam/budget.ts";
import { withRunLifecycle } from "../src/redteam/run-lifecycle.ts";
import { newRun } from "../src/redteam/run-model.ts";
import { stubProvider } from "./support/provider.ts";

const budgets: ModelBudget[] = [];
function budget(limits: Partial<BudgetLimits> = {}, signal?: AbortSignal) {
  const instance = new ModelBudget(
    { maxModelCalls: 10, maxTokens: 1_000, timeoutMs: 5_000, ...limits },
    signal ? { signal } : {},
  );
  budgets.push(instance);
  return instance;
}
function reservation(overrides: Partial<ModelReservation> = {}): ModelReservation {
  return {
    purpose: "probe",
    inputTokensUpperBound: 10,
    maxOutputTokens: 20,
    additionalTokensUpperBound: 0,
    ...overrides,
  };
}
function usage(inputTokens: number, outputTokens: number, additionalTokens = 0): TokenUsage {
  return { inputTokens, outputTokens, additionalTokens };
}
function pending() {
  return Promise.withResolvers<{ value: string; usage?: TokenUsage }>();
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
afterEach(() => {
  for (const instance of budgets.splice(0)) instance.cancel();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("run-wide model budget", () => {
  it("shares admission across setup, controls, probes, retries and agent-loop calls", async () => {
    const run = budget({ maxModelCalls: 5, maxTokens: 150 });
    const seenSignals: AbortSignal[] = [];
    const dispatch = vi.fn(async ({ signal, maxOutputTokens }) => {
      seenSignals.push(signal);
      expect(maxOutputTokens).toBe(20);
      // Reservation must exist before the provider can do work.
      expect(run.snapshot().calls.at(-1)).toMatchObject({
        accounting: "reserved",
        accountedTokens: 30,
      });
      return { value: "private model response", usage: usage(3, 2) };
    });
    await run.execute(reservation({ purpose: "setup" }), dispatch);
    await run.execute(reservation({ purpose: "control" }), dispatch);
    const failure = vi.fn(async () => {
      throw new Error("private provider error");
    });
    await expect(run.execute(reservation(), failure)).rejects.toThrow("private provider error");
    expect(failure).toHaveBeenCalledTimes(1); // Retrying must be an explicit, admitted call.
    await run.execute(reservation({ purpose: "retry" }), dispatch);
    await run.execute(reservation(), async () => ({ value: "unknown usage" }));

    const report = run.finish();
    expect(report).toMatchObject({
      kind: "redteam-model-budget",
      enforcementScope: "submitted-dispatches",
      state: "completed",
      stopReasons: [],
      callsAdmitted: 5,
      callsInFlight: 0,
      providersUnsettled: 0,
      observedTokens: 15,
      outstandingReservedTokens: 60,
      accountedTokens: 75,
      remainingCalls: 0,
      remainingTokens: 75,
    });
    expect(report.calls.map((call) => call.purpose)).toEqual([
      "setup",
      "control",
      "probe",
      "retry",
      "probe",
    ]);
    expect(report.calls.map((call) => call.state)).toEqual([
      "succeeded",
      "succeeded",
      "failed",
      "succeeded",
      "succeeded",
    ]);
    expect(seenSignals.every((signal) => signal === run.signal)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("private");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases only confirmed unused tokens and can finish exactly at both caps", async () => {
    const run = budget({ maxModelCalls: 2, maxTokens: 50 });
    const request = reservation({ additionalTokensUpperBound: 10 });
    await run.execute(request, async () => ({ value: "first", usage: usage(3, 4, 3) }));
    expect(run.snapshot().remainingTokens).toBe(40);
    await run.execute(request, async () => ({ value: "second", usage: usage(10, 20, 10) }));
    expect(run.finish()).toMatchObject({
      state: "completed",
      stopReasons: [],
      observedTokens: 50,
      accountedTokens: 50,
      outstandingReservedTokens: 0,
      remainingTokens: 0,
      remainingCalls: 0,
    });
    expect(run.signal.aborted).toBe(false);
  });

  it.each([
    { limits: { maxModelCalls: 1 }, reason: "model-call-limit" },
    { limits: { maxTokens: 30 }, reason: "token-limit" },
  ])("stops only when further required work exceeds $reason", async ({ limits, reason }) => {
    const run = budget(limits);
    await run.execute(reservation(), async () => ({ value: "first" }));
    expect(run.snapshot().state).toBe("open");
    const provider = vi.fn(async () => ({ value: "must not run" }));
    await expect(run.execute(reservation(), provider)).rejects.toMatchObject({ reason });
    expect(provider).not.toHaveBeenCalled();
    expect(run.finish()).toMatchObject({
      state: "stopped",
      stopReasons: [reason],
      callsAdmitted: 1,
    });
    expect(run.signal.aborted).toBe(true);
  });

  it("refuses an oversized first request without contacting a provider", async () => {
    const run = budget({ maxTokens: 29 });
    const provider = vi.fn(async () => ({ value: "must not run" }));
    await expect(run.execute(reservation(), provider)).rejects.toMatchObject({
      reason: "token-limit",
    });
    expect(provider).not.toHaveBeenCalled();
    expect(run.snapshot()).toMatchObject({ callsAdmitted: 0, accountedTokens: 0 });
  });

  it("retains the complete reservation on missing usage, rejection and synchronous failure", async () => {
    const run = budget({ maxTokens: 90 });
    await run.execute(reservation(), async () => ({ value: "no usage" }));
    await expect(
      run.execute(reservation(), async () => {
        throw new Error("network failure");
      }),
    ).rejects.toThrow("network failure");
    await expect(
      run.execute(reservation(), () => {
        throw new Error("dispatch failure");
      }),
    ).rejects.toThrow("dispatch failure");
    expect(run.finish()).toMatchObject({
      state: "completed",
      callsAdmitted: 3,
      accountedTokens: 90,
      observedTokens: 0,
      outstandingReservedTokens: 90,
    });
    expect(
      run.snapshot().calls.every((call) => call.accounting === "unknown" && call.providerSettled),
    ).toBe(true);
  });

  it.each(["token-limit", "model-call-limit"])(
    "atomically reserves concurrent requests at the %s",
    async (reason) => {
      const run = budget(reason === "token-limit" ? { maxTokens: 50 } : { maxModelCalls: 1 });
      const response = pending();
      const first = run.execute(reservation(), () => response.promise);
      const firstRejection = expect(first).rejects.toMatchObject({ reason });
      const secondProvider = vi.fn(async () => ({ value: "must not run" }));
      await expect(run.execute(reservation(), secondProvider)).rejects.toMatchObject({ reason });
      await firstRejection;
      expect(secondProvider).not.toHaveBeenCalled();
      expect(run.snapshot()).toMatchObject({
        callsAdmitted: 1,
        callsInFlight: 0,
        providersUnsettled: 1,
        accountedTokens: 30,
      });

      // The caller stops even when the remote transport ignores AbortSignal.
      response.resolve({ value: "late result", usage: usage(3, 5) });
      await Promise.resolve();
      expect(run.finish()).toMatchObject({
        state: "stopped",
        providersUnsettled: 0,
        accountedTokens: 8,
        observedTokens: 8,
      });
      expect(run.snapshot().calls[0]).toMatchObject({
        state: "interrupted",
        accounting: "confirmed",
      });
    },
  );

  it("admits concurrent work that fits and reconciles out-of-order replies", async () => {
    const run = budget({ maxModelCalls: 2, maxTokens: 60 });
    const a = pending();
    const b = pending();
    const first = run.execute(reservation(), () => a.promise);
    const second = run.execute(reservation(), () => b.promise);
    expect(run.snapshot()).toMatchObject({
      callsAdmitted: 2,
      callsInFlight: 2,
      accountedTokens: 60,
    });
    b.resolve({ value: "second", usage: usage(4, 6) });
    await expect(second).resolves.toBe("second");
    expect(run.snapshot()).toMatchObject({ callsInFlight: 1, accountedTokens: 40 });
    a.resolve({ value: "first", usage: usage(5, 10) });
    await expect(first).resolves.toBe("first");
    expect(run.finish()).toMatchObject({
      state: "completed",
      observedTokens: 25,
      accountedTokens: 25,
    });
  });

  it.each([
    { name: "negative tokens", report: usage(-1, 0) },
    { name: "fractional tokens", report: usage(1, 0.5) },
    { name: "NaN", report: usage(Number.NaN, 0) },
    { name: "missing charged category", report: { inputTokens: 1, outputTokens: 2 } },
    { name: "unavailable usage object", report: null },
    { name: "unsafe total", report: usage(Number.MAX_SAFE_INTEGER, 1) },
  ])("fails closed on $name in provider usage", async ({ report }) => {
    const run = budget();
    await expect(
      run.execute(reservation(), async () => ({ value: "bad", usage: report as TokenUsage })),
    ).rejects.toMatchObject({ reason: "invalid-provider-usage" });
    expect(run.finish()).toMatchObject({
      state: "stopped",
      accountedTokens: 30,
      observedTokens: 0,
      outstandingReservedTokens: 30,
    });
  });

  it.each([
    { report: usage(11, 0), charged: 30 },
    { report: usage(0, 21), charged: 30 },
    { report: usage(0, 0, 1), charged: 30 },
    { report: usage(20, 20, 1), charged: 41 },
  ])(
    "stops on any exceeded token category and never refunds an overrun: $report",
    async ({ report, charged }) => {
      const run = budget();
      await expect(
        run.execute(reservation(), async () => ({ value: "bad profile", usage: report })),
      ).rejects.toMatchObject({ reason: "provider-usage-exceeded-reservation" });
      expect(run.finish()).toMatchObject({
        state: "stopped",
        accountedTokens: charged,
        observedTokens: report.inputTokens + report.outputTokens + report.additionalTokens,
        outstandingReservedTokens:
          charged - report.inputTokens - report.outputTokens - report.additionalTokens,
      });
      expect(run.snapshot().calls[0]).toMatchObject({ accounting: "overrun", usage: report });
    },
  );

  it("rejects accounting overflow without emitting imprecise totals", async () => {
    const run = budget();
    await run.execute(reservation(), async () => ({ value: "retained reservation" }));
    await expect(
      run.execute(reservation(), async () => ({
        value: "corrupt usage",
        usage: usage(Number.MAX_SAFE_INTEGER, 0),
      })),
    ).rejects.toMatchObject({ reason: "invalid-provider-usage" });
    expect(run.finish()).toMatchObject({
      accountedTokens: 60,
      observedTokens: 0,
      outstandingReservedTokens: 60,
    });
  });

  it.each([
    null,
    {},
    {
      get value() {
        throw new Error("bad response");
      },
    },
  ])("stops on a malformed normalized provider response", async (response) => {
    const run = budget();
    await expect(
      run.execute(reservation(), async () => response as { value: string }),
    ).rejects.toMatchObject({ reason: "invalid-provider-response" });
    expect(run.finish()).toMatchObject({ accountedTokens: 30, providersUnsettled: 0 });
  });

  it("cancels before dispatch when the external signal is already aborted", async () => {
    const run = budget({}, AbortSignal.abort());
    const provider = vi.fn(async () => ({ value: "must not run" }));
    await expect(run.execute(reservation(), provider)).rejects.toMatchObject({
      reason: "cancelled",
    });
    expect(provider).not.toHaveBeenCalled();
    expect(run.finish()).toMatchObject({ callsAdmitted: 0, accountedTokens: 0 });
  });

  it("interrupts every active caller on cancellation while retaining completed observations", async () => {
    const cancellation = new AbortController();
    const run = budget({}, cancellation.signal);
    const evidence = await run.execute(reservation(), async () => ({
      value: "confirmed violation",
      usage: usage(2, 2),
    }));
    const a = pending();
    const b = pending();
    const first = expect(run.execute(reservation(), () => a.promise)).rejects.toMatchObject({
      reason: "cancelled",
    });
    const second = expect(run.execute(reservation(), () => b.promise)).rejects.toMatchObject({
      reason: "cancelled",
    });
    cancellation.abort();
    await Promise.all([first, second]);
    expect(evidence).toBe("confirmed violation");
    expect(run.finish()).toMatchObject({
      state: "stopped",
      callsInFlight: 0,
      providersUnsettled: 2,
      observedTokens: 4,
      outstandingReservedTokens: 60,
    });
    expect(run.snapshot().calls[0]?.state).toBe("succeeded");
    a.reject(new Error("late remote rejection"));
    b.resolve({ value: "late response without usage" });
    await Promise.resolve();
    expect(run.snapshot()).toMatchObject({ providersUnsettled: 0, accountedTokens: 64 });
  });

  it("handles cancellation synchronously inside dispatch", async () => {
    const run = budget();
    await expect(
      run.execute(reservation(), async () => {
        run.cancel();
        return { value: "already cancelled", usage: usage(2, 2) };
      }),
    ).rejects.toBeInstanceOf(BudgetStoppedError);
    expect(run.finish()).toMatchObject({ state: "stopped", callsAdmitted: 1, accountedTokens: 4 });
  });

  it("enforces a single wall-clock deadline during uncooperative provider work", async () => {
    const run = budget({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(60);
    const response = pending();
    const rejected = expect(
      run.execute(reservation(), () => response.promise),
    ).rejects.toMatchObject({ reason: "deadline" });
    await vi.advanceTimersByTimeAsync(39);
    expect(run.snapshot().state).toBe("open");
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(run.signal.aborted).toBe(true);
    expect(run.finish()).toMatchObject({
      state: "stopped",
      providersUnsettled: 1,
      outstandingReservedTokens: 30,
    });
  });

  it("checks elapsed time at admission even if the timer has not fired", async () => {
    const run = budget({ timeoutMs: 100 });
    vi.spyOn(performance, "now").mockReturnValue(100);
    const provider = vi.fn(async () => ({ value: "must not run" }));
    await expect(run.execute(reservation(), provider)).rejects.toMatchObject({
      reason: "deadline",
    });
    expect(provider).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("does not complete an active call, reopen a finished run, or retroactively cancel completion", async () => {
    const cancellation = new AbortController();
    const run = budget({}, cancellation.signal);
    const response = pending();
    const call = run.execute(reservation(), () => response.promise);
    expect(() => run.finish()).toThrow("in flight");
    response.resolve({ value: "done", usage: usage(1, 1) });
    await call;
    const completed = run.finish();
    cancellation.abort();
    run.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.snapshot()).toEqual(completed);
    await expect(
      run.execute(reservation(), async () => ({ value: "must not run" })),
    ).rejects.toThrow("already completed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps ledger state independent of mutable input and returned reports", async () => {
    const limits = { maxModelCalls: 1, maxTokens: 30, timeoutMs: 100, extra: "never persist" };
    const run = new ModelBudget(limits);
    budgets.push(run);
    limits.maxTokens = 1_000;
    const request = reservation();
    const reportedUsage = { ...usage(2, 3), providerMetadata: "never persist" };
    await run.execute(request, async () => ({ value: "done", usage: reportedUsage }));
    request.inputTokensUpperBound = 99;
    reportedUsage.inputTokens = 99;
    const report = run.snapshot();
    report.limits.maxTokens = 999;
    report.stopReasons.push("cancelled");
    const call = report.calls[0];
    if (!call?.usage) throw new Error("Expected confirmed usage");
    call.reservation.inputTokens = 999;
    call.usage.inputTokens = 999;
    expect(run.finish()).toMatchObject({
      limits: { maxTokens: 30 },
      stopReasons: [],
      accountedTokens: 5,
      calls: [{ reservation: usage(10, 20), usage: usage(2, 3) }],
    });
    expect(JSON.stringify(run.snapshot())).not.toContain("never persist");
  });

  it.each([
    { maxModelCalls: 0 },
    { maxModelCalls: 100_001 },
    { maxTokens: 0 },
    { maxTokens: Number.POSITIVE_INFINITY },
    { timeoutMs: 0 },
    { timeoutMs: 86_400_001 },
  ])("rejects invalid run limits: %j", (limits) => {
    expect(() => budget(limits)).toThrow("must be an integer");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { purpose: "invalid" },
    { inputTokensUpperBound: -1 },
    { maxOutputTokens: 0 },
    { additionalTokensUpperBound: Number.NaN },
    { inputTokensUpperBound: Number.MAX_SAFE_INTEGER },
  ])("rejects an invalid reservation without admitting it: %j", async (invalid) => {
    const run = budget();
    const provider = vi.fn(async () => ({ value: "must not run" }));
    await expect(
      run.execute(reservation(invalid as Partial<ModelReservation>), provider),
    ).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
    expect(run.snapshot()).toMatchObject({ state: "open", callsAdmitted: 0, accountedTokens: 0 });
  });
});

describe("stop messages", () => {
  const limits = { maxModelCalls: 12, maxTokens: 200_000, timeoutMs: 600_000 };
  it.each([
    ["model-call-limit", "Stopped at the model call limit of 12 calls."],
    ["token-limit", "Stopped at the token budget of 200,000 tokens."],
    ["deadline", "Stopped when the 600-second deadline passed."],
    ["cancelled", "Stopped because the test was cancelled."],
    [
      "invalid-provider-response",
      "Stopped because the model provider returned an invalid response.",
    ],
  ] as const)("names the cause of a %s stop", (reason, message) => {
    expect(describeBudgetStop(reason, limits)).toBe(message);
  });

  it("records the limit that stopped a run instead of a generic message", async () => {
    const provider = stubProvider();
    const options = {
      target: "agent.py:build_agent",
      sourceDigest: "digest",
      limits: { maxModelCalls: 1, maxTokens: 1_000, timeoutMs: 5_000 },
      provider,
    };
    const report = newRun("/project", options);
    await withRunLifecycle(report, options, "failed", async ({ budget }) => {
      await budget.execute(reservation(), async () => ({ value: "first" }));
      await budget.execute(reservation(), async () => ({ value: "never admitted" }));
    });
    expect(report).toMatchObject({
      state: "stopped",
      error: "Stopped at the model call limit of 1 call.",
      budget: { stopReasons: ["model-call-limit"] },
    });
  });
});
