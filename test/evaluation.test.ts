import { describe, expect, it } from "vitest";
import {
  type EvaluationCase,
  evaluateAi,
  evaluateStatic,
  formatEvaluation,
  loadCorpus,
  metrics,
  ruleMetrics,
  spread,
} from "../scripts/lib/evaluation.ts";
import { STRIDE } from "../src/assessment/model.ts";
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
    expect(cases).toHaveLength(72);
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
      truePositives: 35,
      falsePositives: 0,
      falseNegatives: 1,
      trueNegatives: 36,
      precision: 1,
      recall: 35 / 36,
    });
    // Every rule has at least one vulnerable case in the corpus.
    expect(ruleMetrics(outcomes)).toHaveLength(26);
    expect(ruleMetrics(outcomes).find((row) => row.rule === "PLG101")).toEqual({
      rule: "PLG101",
      vulnerable: 3,
      safe: 0,
      precision: 1,
    });
  });
});

describe("AI review evaluation", () => {
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
        // The second review dismisses the candidate on the scoped route.
        const verdict = source.includes("tenantId") ? "dismissed" : "source-supported";
        const ids = data.candidates.map((item: { id: string }) => item.id);
        return new Response(JSON.stringify(nativeReviewReply(reviewDecision(ids, verdict))));
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
      verdicts: ["source-supported"],
    });
    // A dismissed finding at the label is no false positive.
    expect(outcome("ts-idor-route-scoped")).toMatchObject({
      detected: false,
      verdicts: ["dismissed"],
      unlabeled: 0,
    });
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
    expect(markdown).toContain(`Prompt digest \`${REVIEW_PROMPT_DIGEST.slice(0, 12)}\``);
    expect(markdown).toContain(
      "| ts-idor-route | vulnerable | 2/2 | source-supported, source-supported | 0 |",
    );
    expect(markdown).toContain(
      "Counting only source-supported findings: precision 1.00 (min 1.00, max 1.00), recall 0.50 (min 0.50, max 0.50).",
    );
    expect(markdown).not.toContain(access.apiKey);
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing fixture value");
  return value;
}
