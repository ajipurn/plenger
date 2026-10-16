// Scoring for `pnpm evaluate`: the labeled corpus in test/fixtures/evaluation, measured
// against the static scanner and against the AI review of one or more models.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecurityReview } from "../../src/assessment/review-model.ts";
import { REVIEW_PROMPT_DIGEST, reviewProject } from "../../src/assessment/security-review.ts";
import type { ModelPricing } from "../../src/redteam/model-pricing.ts";
import type { ProviderAccess } from "../../src/redteam/provider.ts";
import type { Finding } from "../../src/rules/model.ts";
import { scan } from "../../src/scan.ts";
import { isRecord } from "../../src/shared/guards.ts";

export interface Span {
  path: string;
  line: number;
  endLine: number;
}

export interface EvaluationCase {
  id: string;
  root: string;
  /** Ground truth for the labeled location. */
  kind: "vulnerable" | "safe";
  summary: string;
  cwe: string;
  location: Span;
  /** Rules the static scanner reports at the location today. */
  static: string[];
  note?: string;
}

export interface Metrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  /** Null when nothing was reported. */
  precision: number | null;
  /** Null when no case is vulnerable. */
  recall: number | null;
}

export interface StaticOutcome {
  id: string;
  kind: EvaluationCase["kind"];
  detected: boolean;
  rules: string[];
  /** Rules reported away from the labeled location. */
  unlabeled: string[];
}

export interface AiOutcome {
  id: string;
  kind: EvaluationCase["kind"];
  status: SecurityReview["status"];
  detected: boolean;
  /** Second-review verdicts of the findings at the labeled location, dismissed ones included. */
  verdicts: string[];
  /** Findings that were not dismissed and cite none of the labeled lines. */
  unlabeled: number;
  tokens: number | null;
  costUsd: number | null;
}

export interface AiEvaluation {
  provider: SecurityReview["provider"];
  validator?: SecurityReview["provider"];
  promptDigest: string;
  runs: AiOutcome[][];
  metrics: Metrics[];
}

/** The corpus cases, sorted by id. Rejects labels that do not point into their files. */
export async function loadCorpus(dir: string): Promise<EvaluationCase[]> {
  const cases: EvaluationCase[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const root = join(dir, entry.name);
    const label: unknown = JSON.parse(await readFile(join(root, "case.json"), "utf8"));
    if (
      !isRecord(label) ||
      (label.kind !== "vulnerable" && label.kind !== "safe") ||
      typeof label.summary !== "string" ||
      typeof label.cwe !== "string" ||
      !isRecord(label.location) ||
      typeof label.location.path !== "string" ||
      !Number.isSafeInteger(label.location.line) ||
      !Number.isSafeInteger(label.location.endLine) ||
      !Array.isArray(label.static) ||
      !label.static.every((rule) => typeof rule === "string")
    )
      throw new Error(`Invalid case label: ${entry.name}`);
    const location = label.location as unknown as Span;
    const lines = (await readFile(join(root, location.path), "utf8")).split("\n").length;
    if (location.line < 1 || location.endLine < location.line || location.endLine > lines)
      throw new Error(`Case ${entry.name} labels lines outside ${location.path}.`);
    cases.push({
      id: entry.name,
      root,
      kind: label.kind,
      summary: label.summary,
      cwe: label.cwe,
      location,
      static: [...(label.static as string[])].sort(),
      ...(typeof label.note === "string" ? { note: label.note } : {}),
    });
  }
  return cases;
}

export function overlaps(label: Span, span: Span): boolean {
  return span.path === label.path && span.line <= label.endLine && span.endLine >= label.line;
}

/** Rules reported at the labeled location, and elsewhere in the case. */
export function staticOutcome(item: EvaluationCase, findings: readonly Finding[]): StaticOutcome {
  const at = (finding: Finding) =>
    [finding.location, ...finding.evidence.map((step) => step.location)].some((span) =>
      overlaps(item.location, span),
    );
  const rules = [...new Set(findings.filter(at).map((finding) => finding.rule))].sort();
  return {
    id: item.id,
    kind: item.kind,
    detected: rules.length > 0,
    rules,
    unlabeled: [
      ...new Set(findings.filter((finding) => !at(finding)).map((finding) => finding.rule)),
    ].sort(),
  };
}

/** A review's findings at the labeled location; dismissed findings never count as detection. */
export function aiOutcome(item: EvaluationCase, review: SecurityReview): AiOutcome {
  const at = (finding: SecurityReview["findings"][number]) =>
    finding.evidence.some((cite) => overlaps(item.location, cite));
  const kept = review.findings.filter((finding) => finding.validation !== "dismissed");
  const usage = review.request.usage;
  const costs = [review.request.billing?.cost, review.request.validatorBilling?.cost];
  return {
    id: item.id,
    kind: item.kind,
    status: review.status,
    detected: kept.some(at),
    verdicts: review.findings.filter(at).map((finding) => finding.validation),
    unlabeled: kept.filter((finding) => !at(finding)).length,
    tokens: usage ? usage.inputTokens + usage.outputTokens + usage.additionalTokens : null,
    costUsd: costs.every((cost) => cost === undefined)
      ? null
      : costs.reduce((sum, cost) => sum + (cost?.totalUsd ?? 0), 0),
  };
}

export function metrics(outcomes: readonly { kind: EvaluationCase["kind"]; detected: boolean }[]) {
  const count = (kind: EvaluationCase["kind"], detected: boolean) =>
    outcomes.filter((item) => item.kind === kind && item.detected === detected).length;
  const truePositives = count("vulnerable", true);
  const falsePositives = count("safe", true);
  const falseNegatives = count("vulnerable", false);
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives: count("safe", false),
    precision:
      truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : null,
    recall:
      truePositives + falseNegatives ? truePositives / (truePositives + falseNegatives) : null,
  } satisfies Metrics;
}

/** Per rule: how often it fired on vulnerable and on safe locations. */
export function ruleMetrics(outcomes: readonly StaticOutcome[]) {
  const rules = [...new Set(outcomes.flatMap((item) => item.rules))].sort();
  return rules.map((rule) => {
    const vulnerable = outcomes.filter(
      (item) => item.kind === "vulnerable" && item.rules.includes(rule),
    ).length;
    const safe = outcomes.filter(
      (item) => item.kind === "safe" && item.rules.includes(rule),
    ).length;
    return { rule, vulnerable, safe, precision: vulnerable / (vulnerable + safe) };
  });
}

export async function evaluateStatic(cases: readonly EvaluationCase[]): Promise<StaticOutcome[]> {
  const outcomes: StaticOutcome[] = [];
  for (const item of cases) outcomes.push(staticOutcome(item, (await scan(item.root)).findings));
  return outcomes;
}

export interface AiConnection {
  provider: SecurityReview["provider"];
  access: ProviderAccess;
  pricing?: ModelPricing;
  inputTokens?: number | null;
}

/**
 * Reviews every case `runs` times, one case at a time, and scores each run. Each review
 * makes at most two model requests; nothing is retried.
 */
export async function evaluateAi(
  cases: readonly EvaluationCase[],
  options: {
    connection: AiConnection;
    validator?: AiConnection;
    runs: number;
    onReview?: (item: EvaluationCase, run: number, outcome: AiOutcome) => void;
  },
  dispatch: typeof fetch = fetch,
): Promise<AiEvaluation> {
  const snapshots = new Map<string, Awaited<ReturnType<typeof scan>>>();
  for (const item of cases) {
    // Text files are listed as the dashboard lists them; the label file is never sent.
    const snapshot = await scan(item.root, { texts: true });
    snapshot.textFiles = (snapshot.textFiles ?? []).filter((file) => file.path !== "case.json");
    snapshots.set(item.id, snapshot);
  }
  const runs: AiOutcome[][] = [];
  for (let run = 0; run < options.runs; run++) {
    const outcomes: AiOutcome[] = [];
    for (const item of cases) {
      const { connection, validator } = options;
      const review = await reviewProject(
        snapshots.get(item.id) as Awaited<ReturnType<typeof scan>>,
        {
          scanId: `evaluation-${item.id}-${run + 1}`,
          provider: connection.provider,
          access: connection.access,
          ...(connection.pricing ? { pricing: connection.pricing } : {}),
          inputTokens: connection.inputTokens ?? null,
          ...(validator
            ? {
                validator: {
                  provider: validator.provider,
                  access: validator.access,
                  ...(validator.pricing ? { pricing: validator.pricing } : {}),
                  inputTokens: validator.inputTokens ?? null,
                },
              }
            : {}),
        },
        dispatch,
      );
      const outcome = aiOutcome(item, review);
      options.onReview?.(item, run + 1, outcome);
      outcomes.push(outcome);
    }
    runs.push(outcomes);
  }
  return {
    provider: options.connection.provider,
    ...(options.validator ? { validator: options.validator.provider } : {}),
    promptDigest: REVIEW_PROMPT_DIGEST,
    runs,
    metrics: runs.map((outcomes) => metrics(outcomes)),
  };
}

/** Metrics when only a finding the second review marked source-supported counts. */
export function supportedMetrics(outcomes: readonly AiOutcome[]): Metrics {
  return metrics(
    outcomes.map((item) => ({
      kind: item.kind,
      detected: item.verdicts.includes("source-supported"),
    })),
  );
}

/** Mean, lowest and highest of the non-null values. */
export function spread(values: readonly (number | null)[]) {
  const known = values.filter((value): value is number => value !== null);
  if (!known.length) return null;
  return {
    mean: known.reduce((sum, value) => sum + value, 0) / known.length,
    min: Math.min(...known),
    max: Math.max(...known),
  };
}

/** The evaluation as Markdown, for docs/qualifications. */
export function formatEvaluation(
  cases: readonly EvaluationCase[],
  staticOutcomes: readonly StaticOutcome[],
  ai: readonly AiEvaluation[],
  date: string,
): string {
  const ratio = (value: number | null) => (value === null ? "n/a" : value.toFixed(2));
  const vulnerable = cases.filter((item) => item.kind === "vulnerable").length;
  const lines = [
    `# Detection evaluation ${date}`,
    "",
    `Corpus: ${cases.length} labeled cases in \`test/fixtures/evaluation\`, ${vulnerable} vulnerable and ${cases.length - vulnerable} safe near-misses. A finding counts for a case when it overlaps the labeled lines; AI findings dismissed by the second review do not count. The corpus is small and synthetic: these figures describe it, not arbitrary projects.`,
    "",
    "## Static rules",
    "",
    tableOf(metrics(staticOutcomes), ratio),
    "",
    "| Rule | Vulnerable cases | Safe cases | Precision |",
    "| --- | --- | --- | --- |",
    ...ruleMetrics(staticOutcomes).map(
      (row) => `| ${row.rule} | ${row.vulnerable} | ${row.safe} | ${row.precision.toFixed(2)} |`,
    ),
    "",
    "| Case | Truth | Static rules at the location |",
    "| --- | --- | --- |",
    ...staticOutcomes.map(
      (item) => `| ${item.id} | ${item.kind} | ${item.rules.join(", ") || "none"} |`,
    ),
  ];
  for (const evaluation of ai) {
    const precision = spread(evaluation.metrics.map((item) => item.precision));
    const recall = spread(evaluation.metrics.map((item) => item.recall));
    // Counting only findings the second review supported, the triage view of a strict reader.
    const supported = evaluation.runs.map((outcomes) => supportedMetrics(outcomes));
    const strictPrecision = spread(supported.map((item) => item.precision));
    const strictRecall = spread(supported.map((item) => item.recall));
    const outcomes = evaluation.runs.flat();
    const failed = outcomes.filter((item) => item.status !== "completed").length;
    const costs = outcomes.map((item) => item.costUsd).filter((cost) => cost !== null);
    const range = (value: ReturnType<typeof spread>) =>
      value === null
        ? "n/a"
        : `${value.mean.toFixed(2)} (min ${value.min.toFixed(2)}, max ${value.max.toFixed(2)})`;
    lines.push(
      "",
      `## AI review: ${evaluation.provider.model}${evaluation.validator ? `, second review ${evaluation.validator.model}` : ""}`,
      "",
      `Prompt digest \`${evaluation.promptDigest.slice(0, 12)}\`, ${evaluation.runs.length} ${evaluation.runs.length === 1 ? "run" : "runs"}, Standard depth. ${failed} of ${outcomes.length} reviews did not complete.${costs.length ? ` Estimated cost USD ${costs.reduce((sum, cost) => sum + cost, 0).toFixed(4)}.` : ""}`,
      "",
      `Precision ${range(precision)}. Recall ${range(recall)}. Counting only source-supported findings: precision ${range(strictPrecision)}, recall ${range(strictRecall)}.`,
      "",
      "| Run | TP | FP | FN | TN | Precision | Recall |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...evaluation.metrics.map(
        (item, index) =>
          `| ${index + 1} | ${item.truePositives} | ${item.falsePositives} | ${item.falseNegatives} | ${item.trueNegatives} | ${ratio(item.precision)} | ${ratio(item.recall)} |`,
      ),
      "",
      "| Case | Truth | Detected in runs | Verdicts at the location | Unlabeled findings |",
      "| --- | --- | --- | --- | --- |",
      ...cases.map((item) => {
        const own = evaluation.runs.map((outcomes) =>
          outcomes.find((outcome) => outcome.id === item.id),
        );
        const detected = own.filter((outcome) => outcome?.detected).length;
        const verdicts = own.flatMap((outcome) => outcome?.verdicts ?? []);
        const unlabeled = own.reduce((sum, outcome) => sum + (outcome?.unlabeled ?? 0), 0);
        return `| ${item.id} | ${item.kind} | ${detected}/${own.length} | ${verdicts.join(", ") || "none"} | ${unlabeled} |`;
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

function tableOf(value: Metrics, ratio: (value: number | null) => string): string {
  return [
    "| TP | FP | FN | TN | Precision | Recall |",
    "| --- | --- | --- | --- | --- | --- |",
    `| ${value.truePositives} | ${value.falsePositives} | ${value.falseNegatives} | ${value.trueNegatives} | ${ratio(value.precision)} | ${ratio(value.recall)} |`,
  ].join("\n");
}
