import { describe, expect, it } from "vitest";
import {
  type AiOutcome,
  aiOutcome,
  cweMetrics,
  dismissedByMistake,
  type EvaluationCase,
  evaluateAi,
  evaluateStatic,
  formatEvaluation,
  loadCorpus,
  metrics,
  pooled,
  RATE_LIMIT_PAUSE_MS,
  reviewSnapshot,
  ruleMetrics,
  sameWeakness,
  severityAgreement,
  spread,
  wilson,
} from "../scripts/lib/evaluation.ts";
import { STRIDE } from "../src/assessment/model.ts";
import {
  EXPLORE_LIMITS,
  reviewBudget,
  SECURITY_REVIEW_LIMITS,
  type SecurityReview,
} from "../src/assessment/review-model.ts";
import { captureReviewSource } from "../src/assessment/review-source.ts";
import { REVIEW_PROMPT_DIGEST } from "../src/assessment/security-review.ts";
import { fixturePath } from "./support/fixtures.ts";
import { nativeReviewReply, reviewDecision } from "./support/security-review.ts";

const access = {
  provider: "anthropic" as const,
  model: "claude-evaluation-test",
  apiKey: "evaluation-secret-7Hn2",
  maxOutputTokens: 8192,
};
const provider = { id: "evaluation", name: "Claude evaluation", model: access.model };

/** A discovery reply with one finding citing `cite`, or none. Synthetic protocol fixture. */
function discovery(cite: { path: string; line: number; endLine: number } | null) {
  return {
    status: "completed",
    reason: null,
    summary: "Synthetic evaluation reply.",
    architecture: "One small module.",
    assets: [],
    trustBoundaries: [],
    stride: STRIDE.map((category) => ({
      category,
      status: "insufficient-context",
      analysis: "Synthetic.",
      mitigation: "Synthetic.",
      evidence: [],
    })),
    findings: cite
      ? [
          {
            title: "Synthetic finding",
            severity: "high",
            confidence: "medium",
            category: "Tampering",
            cwe: "CWE-639",
            description: "Synthetic.",
            impact: "Synthetic.",
            preconditions: [],
            mitigation: "Synthetic.",
            evidence: [{ ...cite, role: "sink", message: "Synthetic." }],
          },
        ]
      : [],
    limitations: ["Synthetic."],
  };
}

describe("evaluation corpus", () => {
  it("pairs a vulnerable case with a safe near-miss for every weakness", async () => {
    const cases = await loadCorpus(fixturePath("evaluation"));
    expect(cases).toHaveLength(150);
    // Every vulnerable case carries the severity the discovery rubric gives it.
    for (const item of cases)
      expect(item.severity === undefined, item.id).toBe(item.kind === "safe");
    for (const cwe of new Set(cases.map((item) => item.cwe))) {
      const kinds = cases.filter((item) => item.cwe === cwe).map((item) => item.kind);
      expect(kinds, cwe).toContain("vulnerable");
      expect(kinds, cwe).toContain("safe");
    }
  });

  it("matches the static behaviour each label records, with nothing outside the labels", async () => {
    const cases = await loadCorpus(fixturePath("evaluation"));
    const outcomes = await evaluateStatic(cases);
    for (const [index, outcome] of outcomes.entries()) {
      const item = cases[index] as EvaluationCase;
      expect(outcome.rules, item.id).toEqual(item.static);
      expect(outcome.unlabeled, item.id).toEqual([]);
    }
    expect(metrics(outcomes)).toEqual({
      truePositives: 69,
      falsePositives: 0,
      falseNegatives: 7,
      trueNegatives: 74,
      precision: 1,
      recall: 69 / 76,
    });
    // Every rule has at least one vulnerable case in the corpus.
    expect(ruleMetrics(outcomes)).toHaveLength(38);
    expect(ruleMetrics(outcomes).find((row) => row.rule === "PLG101")).toEqual({
      rule: "PLG101",
      vulnerable: 3,
      safe: 0,
      precision: 1,
    });
    // Per CWE the largest weakness comes first, and a single pair proves almost nothing.
    const byCwe = cweMetrics(cases, [outcomes]);
    expect(byCwe[0]).toMatchObject({ cwe: "CWE-22", vulnerable: 26, safe: 24 });
    expect(byCwe.find((row) => row.cwe === "CWE-319")?.recall?.low).toBeCloseTo(0.2065, 4);
    // 150 projects scanned one after another.
  }, 30000);

  it("matches each library case's label in a library scan, and finds nothing in a default one", async () => {
    const cases = await loadCorpus(fixturePath("evaluation-library"));
    expect(cases).toHaveLength(18);
    expect(cases.every((item) => item.library === true)).toBe(true);
    const outcomes = await evaluateStatic(cases);
    for (const [index, outcome] of outcomes.entries()) {
      const item = cases[index] as EvaluationCase;
      expect(outcome.rules, item.id).toEqual(item.static);
      expect(outcome.unlabeled, item.id).toEqual([]);
    }
    expect(metrics(outcomes)).toMatchObject({ truePositives: 9, falsePositives: 0 });
    // The mode is opt-in: the same packages scanned as applications report nothing.
    const plain = await evaluateStatic(cases.map(({ library: _library, ...item }) => item));
    expect(plain.flatMap((outcome) => [...outcome.rules, ...outcome.unlabeled])).toEqual([]);
    for (const cwe of new Set(cases.map((item) => item.cwe))) {
      const kinds = cases.filter((item) => item.cwe === cwe).map((item) => item.kind);
      expect(kinds, cwe).toContain("vulnerable");
      expect(kinds, cwe).toContain("safe");
    }
  });

  it("keeps the deciding file of each large pair out of the first message", async () => {
    // The file that tells each twin apart, beside the labeled handler.
    const deciding: Record<string, string> = {
      "py-invoice-number-scoped": "app/repositories/invoices.py",
      "py-invoice-number-unscoped": "app/repositories/invoices.py",
      "py-ticket-file-path-confined": "app/utils/files/paths.py",
      "py-ticket-file-path-unconfined": "app/utils/files/paths.py",
      "ts-exports-mount-admin-role": "src/http/router.ts",
      "ts-exports-mount-no-role": "src/http/router.ts",
    };
    // The largest batch and the largest Explore first message any model window allows.
    const batch = reviewBudget([SECURITY_REVIEW_LIMITS.tokens]);
    const budgets = {
      batch,
      explore: {
        ...batch,
        contextBytes: Math.min(batch.contextBytes, EXPLORE_LIMITS.firstBytes),
        fileBytes: Math.min(batch.fileBytes, EXPLORE_LIMITS.firstBytes),
      },
    };
    const cases = await loadCorpus(fixturePath("evaluation"));
    for (const [id, path] of Object.entries(deciding)) {
      const item = required(cases.find((candidate) => candidate.id === id));
      const snapshot = await reviewSnapshot(item);
      for (const [mode, budget] of Object.entries(budgets)) {
        const { scope } = await captureReviewSource(snapshot, [], undefined, [], { budget });
        const paths = scope.files.map((file) => file.path);
        expect(paths, `${id} ${mode}`).toContain(item.location.path);
        expect(paths, `${id} ${mode}`).not.toContain(path);
      }
    }
    // Six projects of about 70 KiB, scanned and packed twice each.
  }, 30000);
});

describe("weakness matching", () => {
  it("matches a CWE to the label directly or within its family, never a missing one", () => {
    expect(sameWeakness("CWE-22", "CWE-22")).toBe(true);
    expect(sameWeakness("CWE-22", "CWE-23")).toBe(true);
    // `\..\filename` and `C:dirname` are traversal variants too.
    expect(sameWeakness("CWE-29", "CWE-22")).toBe(true);
    expect(sameWeakness("CWE-39", "CWE-73")).toBe(true);
    expect(sameWeakness("CWE-41", "CWE-22")).toBe(false);
    expect(sameWeakness("CWE-639", "CWE-862")).toBe(true);
    expect(sameWeakness("CWE-89", "CWE-639")).toBe(false);
    expect(sameWeakness("CWE-918", "CWE-400")).toBe(false);
    expect(sameWeakness("CWE-78", null)).toBe(false);
  });
});

describe("intervals", () => {
  it("gives the 95% Wilson interval, within 0 and 1 at the extremes", () => {
    expect(wilson(0.5, 10).low).toBeCloseTo(0.2366, 4);
    expect(wilson(0.5, 10).high).toBeCloseTo(0.7634, 4);
    expect(wilson(0, 10).low).toBeCloseTo(0, 10);
    expect(wilson(0, 10).high).toBeCloseTo(0.2775, 4);
    expect(wilson(1, 10).low).toBeCloseTo(0.7225, 4);
    expect(wilson(1, 10).high).toBeCloseTo(1, 10);
  });

  it("pools runs without narrowing the interval, and has none without cases", () => {
    const run = metrics([
      ...Array.from({ length: 10 }, (_, index) => ({
        kind: "vulnerable" as const,
        detected: index < 8,
      })),
      { kind: "safe" as const, detected: true },
    ]);
    expect(pooled([run])).toEqual({ precision: wilson(8 / 9, 9), recall: wilson(0.8, 10) });
    expect(pooled([run, run, run])).toEqual(pooled([run]));
    expect(pooled([metrics([])])).toEqual({ precision: null, recall: null });
  });
});

describe("AI review evaluation", () => {
  it("lists the files an exploring review read", async () => {
    const item = required(
      (await loadCorpus(fixturePath("evaluation"))).find((entry) => entry.id === "ts-idor-route"),
    );
    const review = {
      status: "completed",
      findings: [],
      request: { calls: 2, usage: null },
      scope: { files: [{ path: "server.ts" }, { path: "db.ts" }] },
      exploration: [{ toolCalls: { read_file: 1, submit_discovery: 1 } }],
    } as unknown as SecurityReview;
    expect(aiOutcome(item, review)).toMatchObject({
      read: ["db.ts", "server.ts"],
      toolCalls: { read_file: 1, submit_discovery: 1 },
    });
    const { exploration: _exploration, ...batch } = review;
    expect(aiOutcome(item, batch).read).toBeUndefined();
  });

  it("reviews cases concurrently in case order and reruns a review the provider rate-limited", async () => {
    const cases = (await loadCorpus(fixturePath("evaluation"))).filter((item) =>
      ["py-sql-tool", "ts-idor-route"].includes(item.id),
    );
    // The first request for each case is rejected with HTTP 429, as a busy provider does.
    const limited = new Set<string>();
    const dispatch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const messages = body.messages as { content: { text: string }[] }[];
      const data = JSON.parse(messages[0]?.content[0]?.text ?? "{}");
      const source = data.files.map((file: { source: string }) => file.source).join("\n");
      const id = source.includes("findUnique") ? "ts-idor-route" : "py-sql-tool";
      if (!data.candidates && !limited.has(id)) {
        limited.add(id);
        return new Response("{}", { status: 429 });
      }
      if (data.candidates) {
        const ids = data.candidates.map((item: { id: string }) => item.id);
        return new Response(JSON.stringify(nativeReviewReply(reviewDecision(ids))));
      }
      return new Response(JSON.stringify(nativeReviewReply(discovery(null))));
    };
    const waits: number[] = [];
    const result = await evaluateAi(
      cases,
      {
        connection: { provider, access },
        runs: 1,
        concurrency: 2,
        pause: async (ms) => {
          waits.push(ms);
        },
      },
      dispatch,
    );
    const outcomes = required(result.runs[0]);
    expect(outcomes.map((item) => [item.id, item.status, item.rateLimitedReruns])).toEqual([
      ["py-sql-tool", "completed", 1],
      ["ts-idor-route", "completed", 1],
    ]);
    expect(waits).toEqual([RATE_LIMIT_PAUSE_MS, RATE_LIMIT_PAUSE_MS]);
    const markdown = formatEvaluation(cases, await evaluateStatic(cases), [result], "2026-10-21");
    expect(markdown).toContain(
      "0 of 2 reviews did not complete. 2 reviews were rerun after the provider answered HTTP 429.",
    );
    // Other failures are never rerun.
    const failing = await evaluateAi(
      cases.slice(0, 1),
      { connection: { provider, access }, runs: 1, pause: async () => {} },
      async () => new Response("{}", { status: 500 }),
    );
    expect(failing.runs[0]?.[0]).toMatchObject({ status: "failed" });
    expect(failing.runs[0]?.[0]?.rateLimitedReruns).toBeUndefined();
  });

  it("compares reported severity with the labels and counts vulnerable cases dismissed by mistake", () => {
    const label = (id: string, severity?: "critical" | "high" | "medium") =>
      ({ id, kind: severity ? "vulnerable" : "safe", ...(severity ? { severity } : {}) }) as never;
    const cases: EvaluationCase[] = [
      label("a", "critical"),
      label("b", "high"),
      label("c", "medium"),
      label("d", "high"),
      label("e"),
    ];
    const outcome = (id: string, fields: Partial<AiOutcome>) =>
      ({
        id,
        kind: id === "e" ? "safe" : "vulnerable",
        detected: true,
        verdicts: [],
        ...fields,
      }) as AiOutcome;
    const outcomes = [
      outcome("a", { severity: "high" }),
      outcome("b", { severity: "high" }),
      outcome("c", { severity: "critical" }),
      // Not detected: its only finding at the label was dismissed.
      outcome("d", { severity: null, detected: false, verdicts: ["dismissed"] }),
      // A safe case is never rated, whatever it reports.
      outcome("e", { severity: "low" }),
    ];
    expect(severityAgreement(cases, outcomes)).toEqual({
      rated: 3,
      exact: 1,
      withinOne: 2,
      higher: 1,
      lower: 1,
    });
    expect(dismissedByMistake(outcomes)).toBe(1);
  });

  it("scores each run, ignores dismissed findings and counts findings outside the labels", async () => {
    const cases = (await loadCorpus(fixturePath("evaluation"))).filter((item) =>
      ["py-sql-tool", "py-sql-tool-param", "ts-idor-route", "ts-idor-route-scoped"].includes(
        item.id,
      ),
    );
    const dispatch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const messages = body.messages as { content: { text: string }[] }[];
      const data = JSON.parse(messages[0]?.content[0]?.text ?? "{}");
      const source = data.files.map((file: { source: string }) => file.source).join("\n");
      // Labels stay on the host.
      expect(data.files.map((file: { path: string }) => file.path)).not.toContain("case.json");
      if (data.candidates) {
        // The second review dismisses the candidate on the scoped route, citing its guard.
        const scoped = source.includes("tenantId");
        const ids = data.candidates.map((item: { id: string }) => item.id);
        const guard = required(cases.find((item) => item.id === "ts-idor-route-scoped")).location;
        return new Response(
          JSON.stringify(
            nativeReviewReply(
              reviewDecision(ids, scoped ? "dismissed" : "source-supported", guard),
            ),
          ),
        );
      }
      const id = source.includes("tenantId")
        ? "ts-idor-route-scoped"
        : source.includes("findUnique")
          ? "ts-idor-route"
          : source.includes("= ?")
            ? "py-sql-tool-param"
            : "py-sql-tool";
      const item = required(cases.find((candidate) => candidate.id === id));
      // The IDOR pair is cited at its label; the SQL pair only at its import line.
      const cite = id.startsWith("py-sql")
        ? { path: "tools.py", line: 1, endLine: 1 }
        : { ...item.location };
      return new Response(JSON.stringify(nativeReviewReply(discovery(cite))));
    };
    const result = await evaluateAi(cases, { connection: { provider, access }, runs: 2 }, dispatch);
    expect(result.promptDigest).toBe(REVIEW_PROMPT_DIGEST);
    expect(result.runs).toHaveLength(2);
    const first = required(result.runs[0]);
    const outcome = (id: string) => required(first.find((item) => item.id === id));
    // The SQL findings cite line 1, outside both labels: no detection, one unlabeled finding.
    expect(outcome("py-sql-tool")).toMatchObject({ detected: false, unlabeled: 1 });
    expect(outcome("py-sql-tool-param")).toMatchObject({ detected: false, unlabeled: 1 });
    expect(outcome("ts-idor-route")).toMatchObject({
      detected: true,
      matched: true,
      severity: "high",
      verdicts: ["source-supported"],
    });
    // A dismissed finding at the label is no false positive.
    expect(outcome("ts-idor-route-scoped")).toMatchObject({
      detected: false,
      severity: null,
      verdicts: ["dismissed"],
      unlabeled: 0,
      uncheckedDismissals: 0,
    });
    // The JSON keeps what each finding at the label claims and why it was decided.
    expect(outcome("ts-idor-route-scoped").findings).toEqual([
      {
        title: expect.any(String),
        category: expect.any(String),
        cwe: "CWE-639",
        severity: expect.any(String),
        verdict: "dismissed",
        basis: "control",
        reason: expect.stringMatching(/\S/),
      },
    ]);
    expect(result.metrics[0]).toEqual({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 1,
      trueNegatives: 2,
      precision: 1,
      recall: 0.5,
    });
    expect(spread(result.metrics.map((item) => item.recall))).toEqual({
      mean: 0.5,
      min: 0.5,
      max: 0.5,
    });
    const markdown = formatEvaluation(cases, await evaluateStatic(cases), [result], "2026-10-16");
    expect(markdown).toContain(
      `Batch mode, prompt digest \`${REVIEW_PROMPT_DIGEST.slice(0, 12)}\``,
    );
    expect(markdown.replace(/ {2,}/g, " ")).toContain(
      "| ts-idor-route | vulnerable | 2/2 | source-supported, source-supported | 0 | high: high, high |",
    );
    expect(markdown.replace(/ {2,}/g, " ")).toContain(
      "| ts-idor-route-scoped | safe | 0/2 | dismissed, dismissed | 0 | n/a: none |",
    );
    expect(markdown).toContain(
      "Severity of 2 rated detections across runs: 2 at the labeled level, 2 within one level, 0 rated higher and 0 lower. Vulnerable cases dismissed by mistake per run: 0, 0. Dismissals the host kept as needs-review: 0. Traced paths listed across runs: 4, closed 0 (finding 0, safe 0, open 0), unclosed 4.",
    );
    expect(markdown).toContain(
      "Counting only source-supported findings: precision 1.00 (min 1.00, max 1.00), recall 0.50 (min 0.50, max 0.50).",
    );
    // Two runs of two vulnerable cases weigh as two cases, not four.
    const ai = markdown.slice(markdown.indexOf("## AI review")).replace(/ {2,}/g, " ");
    expect(ai).toContain(
      "Over all runs, with 95% intervals: precision 1.00 (0.21 to 1.00), recall 0.50 (0.09 to 0.91).",
    );
    expect(ai).toContain("| CWE-89 | 1 | 1 | n/a | n/a | 0.00 | 0.00 to 0.79 |");
    expect(ai).toContain("| CWE-639 | 1 | 1 | 1.00 | 0.21 to 1.00 | 1.00 | 0.21 to 1.00 |");
    expect(markdown).not.toContain(access.apiKey);
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing fixture value");
  return value;
}
