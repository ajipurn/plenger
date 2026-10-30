import { describe, expect, it } from "vitest";
import type { SecurityReview } from "../src/assessment/review-model.ts";
import { reportedScanTokens } from "../src/security/usage.ts";

function review(request: Partial<SecurityReview["request"]>): SecurityReview {
  return { request: { calls: 2, usage: null, durationMs: 0, ...request } } as SecurityReview;
}
const usage = {
  inputTokens: 300,
  outputTokens: 100,
  cacheReadTokens: 600,
  cacheCreationTokens: 100,
  cacheWriteTokens: 100,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  request: 1,
};

describe("reported scan tokens", () => {
  it("uses a complete aggregate once rather than adding its billing details again", () => {
    expect(
      reportedScanTokens([
        review({
          usage: { inputTokens: 1000, outputTokens: 100, additionalTokens: 0 },
          billing: { pricing: null, cost: null, usage: [usage, usage] },
        }),
      ]),
    ).toEqual({ tokens: 1100, complete: true });
  });

  it("retains known totals alongside missing responses and ignores budget reservations", () => {
    const known = review({
      calls: 1,
      reportedUsage: { inputTokens: 1000, outputTokens: 100, additionalTokens: 20, complete: true },
    });
    const missing = review({ calls: 1, charged: { tokens: 999_999, usd: null } });
    expect(reportedScanTokens([known, missing])).toEqual({ tokens: 1120, complete: false });
    expect(
      reportedScanTokens([
        review({
          reportedUsage: {
            inputTokens: 1000,
            outputTokens: 100,
            additionalTokens: 0,
            complete: false,
          },
        }),
      ]),
    ).toEqual({ tokens: 1100, complete: false });
    expect(reportedScanTokens([missing])).toBeNull();
  });

  it("recovers disjoint cache categories across both billing passes in historical scans", () => {
    const billing = { pricing: null, cost: null, usage: [usage] };
    expect(reportedScanTokens([review({ billing, validatorBilling: billing })])).toEqual({
      tokens: 2200,
      complete: true,
    });
    expect(reportedScanTokens([review({ billing })])).toEqual({ tokens: 1100, complete: false });
    const { cacheWriteTokens: _write, ...withoutWriteLifetime } = usage;
    const unknownLifetime = {
      ...withoutWriteLifetime,
      cacheWrite5mTokens: null,
      cacheWrite1hTokens: null,
    };
    expect(
      reportedScanTokens([review({ calls: 1, billing: { ...billing, usage: [unknownLifetime] } })]),
    ).toEqual({ tokens: 1100, complete: true });
  });

  it("does not let a zero-call round make known usage incomplete", () => {
    expect(
      reportedScanTokens([
        review({ calls: 0 }),
        review({ calls: 1, usage: { inputTokens: 10, outputTokens: 2, additionalTokens: 0 } }),
      ]),
    ).toEqual({ tokens: 12, complete: true });
    expect(reportedScanTokens([])).toBeNull();
  });
});
