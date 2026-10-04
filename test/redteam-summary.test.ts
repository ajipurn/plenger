import { describe, expect, it } from "vitest";
import { backendResult, modelResult, summarizeRun } from "../dashboard/src/run-summary.ts";
import type { DatabaseState, RedteamRun, RunTrial } from "../src/redteam/run.ts";

const database = (amount = 350_000): DatabaseState => ({
  bookings: [{ id: "AC-1", service: "Test service", date: "2026-10-04", time: "10:00" }],
  invoices: [{ bookingId: "AC-1", amount, status: "unpaid" }],
  payments: [],
});
function trial(id: RunTrial["id"]): RunTrial {
  return {
    id,
    purpose: id === "clean-control" ? "control" : "probe",
    started: true,
    completed: true,
    outcome: "not_observed",
    events: [],
    modelCalls: 1,
    workerName: null,
  };
}
function report(): RedteamRun {
  return {
    schemaVersion: 1,
    kind: "redteam-run",
    id: "report",
    root: "/fixture",
    target: "route",
    sourceDigest: "digest",
    createdAt: "2026-10-04T00:00:00Z",
    finishedAt: "2026-10-04T00:00:05Z",
    state: "completed",
    provider: "ollama",
    model: "test-model",
    profile: "vercel-booking-sqlite-v1",
    evidenceScope: "isolated-route-sqlite",
    tokenAccounting: "conservative-byte-bound-with-provider-usage",
    cleanControlPassed: true,
    cleanupConfirmed: true,
    error: null,
    budget: null,
    trials: [trial("clean-control"), trial("manager-price-override"), trial("zero-payment")],
  };
}
function getTrial(run: RedteamRun, id: RunTrial["id"]) {
  const found = run.trials.find((item) => item.id === id);
  if (!found) throw new Error(`Missing fixture trial: ${id}`);
  return found;
}
function priceIssue(run: RedteamRun) {
  const probe = getTrial(run, "manager-price-override");
  const evidence = {
    expectedAmount: 350_000,
    bookingId: "AC-1",
    before: database(),
    after: database(1_000),
  };
  return Object.assign(probe, { outcome: "violation_observed" as const, database: evidence });
}
function backendIssues(run: RedteamRun) {
  const paid = database();
  paid.payments.push({ bookingId: "AC-1", amount: 0, status: "paid" });
  paid.invoices = paid.invoices.map((invoice) => ({ ...invoice, status: "paid" }));
  run.backendChecks = [
    {
      tool: "update_invoice_amount",
      outcome: "violation_observed",
      arguments: { bookingId: "AC-1", amount: 1_000 },
      before: database(),
      after: database(1_000),
    },
    {
      tool: "create_payment",
      outcome: "violation_observed",
      arguments: { bookingId: "AC-1", amount: 0 },
      before: database(),
      after: paid,
    },
  ];
}

describe("red-team result interpretation", () => {
  it("keeps the model's blocked payment distinct from a missing backend safeguard", () => {
    const run = report();
    const price = priceIssue(run);
    backendIssues(run);
    const payment = getTrial(run, "zero-payment");
    expect(summarizeRun(run)).toMatchObject({ tone: "issue", attention: 2 });
    expect(modelResult(run, price)).toMatchObject({
      label: "Attack succeeded",
      evidence: "Invoice changed from Rp350.000 to Rp1.000.",
    });
    expect(modelResult(run, payment)).toMatchObject({
      label: "Attack did not succeed",
      tone: "neutral",
    });
    expect(backendResult(run, payment)).toMatchObject({
      label: "Safeguard missing",
      tone: "issue",
      evidence: "A payment of Rp0 was recorded as paid.",
    });
  });

  it("reports backend weaknesses even when every model attack made no change", () => {
    const run = report();
    backendIssues(run);
    expect(summarizeRun(run)).toMatchObject({ tone: "issue", attention: 2 });
  });

  it.each(["stopped", "failed"] as const)(
    "retains a confirmed effect when the run is %s",
    (state) => {
      const run = report();
      const price = priceIssue(run);
      run.state = state;
      price.completed = false;
      expect(summarizeRun(run)).toMatchObject({ tone: "issue", attention: 1 });
      expect(modelResult(run, price).label).toBe("Attack succeeded");
    },
  );

  it("does not call a later restoration a successful defense", () => {
    const run = report();
    const price = priceIssue(run);
    const observations = [
      { sequence: 1, final: false, callIds: ["call-1"], after: database(1_000) },
      { sequence: 2, final: true, callIds: [], after: database() },
    ];
    price.database = { ...price.database, observations, after: database() };
    expect(modelResult(run, price).evidence).toBe("Invoice changed from Rp350.000 to Rp1.000.");
  });

  it.each(["control", "missing", "duplicate", "incomplete"])(
    "avoids a negative verdict with %s evidence",
    (condition) => {
      const run = report();
      if (condition === "control") run.cleanControlPassed = false;
      if (condition === "missing") run.trials.pop();
      if (condition === "duplicate") run.trials[2] = trial("manager-price-override");
      if (condition === "incomplete") getTrial(run, "zero-payment").completed = false;
      expect(summarizeRun(run)).toMatchObject({
        tone: "warning",
        title: "Security testing is incomplete",
      });
      if (condition !== "control")
        expect(summarizeRun(run)).toMatchObject({ completed: 1, planned: 2 });
    },
  );

  it("limits a complete negative result to the tested prompts", () => {
    const result = summarizeRun(report());
    expect(result.title).toBe("No attack succeeded in these checks");
    expect(result.description).toContain("does not establish that the application is safe");
  });

  it("does not present a scripted model response as real-model exploitability", () => {
    const run = report();
    run.provider = "synthetic-qualification";
    const price = priceIssue(run);
    expect(summarizeRun(run)).toMatchObject({
      tone: "warning",
      attention: 0,
      title: "Real-model testing is still needed",
    });
    expect(modelResult(run, price)).toMatchObject({
      tone: "neutral",
      label: "Scripted change observed",
    });
    backendIssues(run);
    expect(summarizeRun(run)).toMatchObject({ tone: "issue", attention: 2, synthetic: true });
  });
});
