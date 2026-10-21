// Scoring for `pnpm evaluate`: the labeled corpus in test/fixtures/evaluation, measured
// against the static scanner and against the AI review of one or more models.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewMode, SecurityReview } from "../../src/assessment/review-model.ts";
import {
  REVIEW_EXPLORE_PROMPT_DIGEST,
  REVIEW_PROMPT_DIGEST,
  reviewProject,
} from "../../src/assessment/security-review.ts";
import type { ModelPricing } from "../../src/redteam/model-pricing.ts";
import type { ProviderAccess } from "../../src/redteam/provider.ts";
import { type Finding, SEVERITIES, type Severity } from "../../src/rules/model.ts";
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
  /** For a vulnerable case: the severity the discovery rubric gives the labeled weakness. */
  severity?: Severity;
  location: Span;
  /** Rules the static scanner reports at the location today. */
  static: string[];
  note?: string;
  /** Scanned as a package (library mode): its public functions' parameters are input. */
  library?: true;
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
  /** Why a review did not complete. */
  reason?: string;
  detected: boolean;
  /** Second-review verdicts of the findings at the labeled location, dismissed ones included. */
  verdicts: string[];
  /** A kept finding at the labeled location names the labeled weakness (see `sameWeakness`). */
  matched: boolean;
  /**
   * The highest severity of the kept findings at the labeled location, of those that name
   * the labeled weakness when any does; null without one.
   */
  severity: Severity | null;
  /** Those findings, with what they claim and why the second review decided as it did. */
  findings: {
    title: string;
    category: string;
    cwe: string | null;
    severity: string;
    verdict: string;
    /** What a dismissal rests on; null for other verdicts and earlier reviews. */
    basis: string | null;
    reason: string;
  }[];
  /** Findings that were not dismissed and cite none of the labeled lines. */
  unlabeled: number;
  /** Dismissals in the review that the host kept as needs-review. */
  uncheckedDismissals: number;
  /** Model requests the review made, and tool calls by name in an exploring review. */
  calls: number;
  toolCalls?: Record<string, number>;
  /** Files an exploring review's sessions received, its first message included. */
  read?: string[];
  /** Why the host rejected exploring submissions, when it did. */
  rejected?: string[];
  /** Times the review was rerun after the provider answered HTTP 429. */
  rateLimitedReruns?: number;
  tokens: number | null;
  costUsd: number | null;
}

export interface AiEvaluation {
  provider: SecurityReview["provider"];
  validator?: SecurityReview["provider"];
  /** Absent on evaluations from before exploration, which were batch reviews. */
  mode?: ReviewMode;
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
      !label.static.every((rule) => typeof rule === "string") ||
      (label.severity !== undefined &&
        (label.kind !== "vulnerable" || !SEVERITIES.includes(label.severity as Severity)))
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
      ...(label.severity !== undefined ? { severity: label.severity as Severity } : {}),
      location,
      static: [...(label.static as string[])].sort(),
      ...(typeof label.note === "string" ? { note: label.note } : {}),
      ...(label.library === true ? { library: true as const } : {}),
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

/**
 * CWEs that name the same weakness for scoring: a review that calls a traversal CWE-23
 * or an insecure direct object reference CWE-862 has found the labeled weakness.
 */
const WEAKNESS_FAMILIES: readonly (readonly number[])[] = [
  [77, 78, 88],
  // Path traversal with its named relative (23 to 35) and absolute (36 to 40) variants.
  [22, ...Array.from({ length: 18 }, (_, index) => 23 + index), 59, 73],
  [89, 564, 943],
  [94, 95, 96, 1336, 1426],
  [74, 1427],
  [269, 284, 285, 287, 306, 566, 639, 862, 863],
  [441, 918],
  [502],
  [200, 201, 256, 259, 312, 321, 359, 522, 532, 798],
  [494, 829, 1104, 1357],
  [311, 319],
  [400, 770, 834, 835],
];

/** Whether a finding's CWE names the labeled weakness, directly or within its family. */
export function sameWeakness(label: string, cwe: string | null | undefined): boolean {
  const id = (value: string) => Number(/^CWE-(\d+)$/.exec(value)?.[1] ?? Number.NaN);
  if (!cwe) return false;
  const [a, b] = [id(label), id(cwe)];
  return a === b || WEAKNESS_FAMILIES.some((family) => family.includes(a) && family.includes(b));
}

/** A review's findings at the labeled location; dismissed findings never count as detection. */
export function aiOutcome(item: EvaluationCase, review: SecurityReview): AiOutcome {
  const at = (finding: SecurityReview["findings"][number]) =>
    finding.evidence.some((cite) => overlaps(item.location, cite));
  const kept = review.findings.filter((finding) => finding.validation !== "dismissed");
  const here = kept.filter(at);
  const named = here.filter((finding) => sameWeakness(item.cwe, finding.cwe));
  const rated = (named.length ? named : here).map((finding) => finding.severity);
  const usage = review.request.usage;
  const costs = [review.request.billing?.cost, review.request.validatorBilling?.cost];
  return {
    id: item.id,
    kind: item.kind,
    status: review.status,
    ...(review.status !== "completed" && review.reason ? { reason: review.reason } : {}),
    detected: here.length > 0,
    matched: named.length > 0,
    severity: SEVERITIES.find((severity) => rated.includes(severity)) ?? null,
    verdicts: review.findings.filter(at).map((finding) => finding.validation),
    findings: review.findings.filter(at).map((finding) => ({
      title: finding.title,
      category: finding.category,
      // Reviews saved before the CWE field have none.
      cwe: finding.cwe ?? null,
      severity: finding.severity,
      verdict: finding.validation,
      basis: finding.dismissal?.basis ?? null,
      reason: finding.validationReason,
    })),
    unlabeled: kept.filter((finding) => !at(finding)).length,
    uncheckedDismissals: review.findings.filter((finding) => finding.uncheckedDismissal).length,
    calls: review.request.calls,
    ...(review.exploration
      ? {
          toolCalls: review.exploration.reduce<Record<string, number>>((sum, session) => {
            for (const [name, count] of Object.entries(session.toolCalls))
              sum[name] = (sum[name] ?? 0) + count;
            return sum;
          }, {}),
          // An exploring review's scope is what its sessions read.
          read: review.scope.files.map((file) => file.path).sort(),
        }
      : {}),
    ...(review.exploration?.some((session) => session.rejected?.length)
      ? { rejected: review.exploration.flatMap((session) => session.rejected ?? []) }
      : {}),
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
  for (const item of cases)
    outcomes.push(
      staticOutcome(item, (await scan(item.root, { library: item.library === true })).findings),
    );
  return outcomes;
}

/**
 * A case's scan as the AI review reads it: text files are listed as the dashboard lists
 * them, and the label file is never sent.
 */
export async function reviewSnapshot(item: EvaluationCase) {
  const snapshot = await scan(item.root, { texts: true });
  snapshot.textFiles = (snapshot.textFiles ?? []).filter((file) => file.path !== "case.json");
  return snapshot;
}

export interface AiConnection {
  provider: SecurityReview["provider"];
  access: ProviderAccess;
  pricing?: ModelPricing;
  inputTokens?: number | null;
}

/** How long to wait before rerunning a review the provider rate-limited, per attempt. */
export const RATE_LIMIT_PAUSE_MS = 30_000;

/**
 * Reviews every case `runs` times and scores each run, `concurrency` cases at a time. A
 * batch review makes at most two model requests; an exploring one stays within its
 * sessions' limits. A review that fails because the provider answered HTTP 429 is rerun
 * after a pause, up to `rateLimitReruns` times, since a rate limit says nothing about the
 * model; the outcome counts its reruns. Nothing else is retried.
 */
export async function evaluateAi(
  cases: readonly EvaluationCase[],
  options: {
    connection: AiConnection;
    validator?: AiConnection;
    runs: number;
    mode?: ReviewMode;
    /** Cases reviewed at the same time; 1 when omitted. */
    concurrency?: number;
    /** Reruns of a review rejected with HTTP 429; 4 when omitted. */
    rateLimitReruns?: number;
    pause?: (ms: number) => Promise<void>;
    onReview?: (item: EvaluationCase, run: number, outcome: AiOutcome) => void;
  },
  dispatch: typeof fetch = fetch,
): Promise<AiEvaluation> {
  const pause =
    options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const reruns = options.rateLimitReruns ?? 4;
  const snapshots = new Map<string, Awaited<ReturnType<typeof scan>>>();
  for (const item of cases) snapshots.set(item.id, await reviewSnapshot(item));
  const runs: AiOutcome[][] = [];
  for (let run = 0; run < options.runs; run++) {
    const outcomes: AiOutcome[] = new Array(cases.length);
    const review = (item: EvaluationCase) => {
      const { connection, validator } = options;
      return reviewProject(
        snapshots.get(item.id) as Awaited<ReturnType<typeof scan>>,
        {
          scanId: `evaluation-${item.id}-${run + 1}`,
          provider: connection.provider,
          access: connection.access,
          ...(connection.pricing ? { pricing: connection.pricing } : {}),
          inputTokens: connection.inputTokens ?? null,
          mode: options.mode ?? "batch",
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
    };
    let next = 0;
    const worker = async () => {
      while (next < cases.length) {
        const index = next++;
        const item = cases[index] as EvaluationCase;
        let result = await review(item);
        let rerun = 0;
        while (
          rerun < reruns &&
          result.status === "failed" &&
          /HTTP 429\b/.test(result.reason ?? "")
        ) {
          rerun += 1;
          await pause(RATE_LIMIT_PAUSE_MS * rerun);
          result = await review(item);
        }
        const outcome = {
          ...aiOutcome(item, result),
          ...(rerun ? { rateLimitedReruns: rerun } : {}),
        };
        options.onReview?.(item, run + 1, outcome);
        outcomes[index] = outcome;
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 1, cases.length)) }, worker),
    );
    runs.push(outcomes);
  }
  return {
    provider: options.connection.provider,
    ...(options.validator ? { validator: options.validator.provider } : {}),
    mode: options.mode ?? "batch",
    promptDigest: options.mode === "explore" ? REVIEW_EXPLORE_PROMPT_DIGEST : REVIEW_PROMPT_DIGEST,
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

/** Metrics when only a kept finding that names the labeled weakness counts. */
export function weaknessMetrics(outcomes: readonly AiOutcome[]): Metrics {
  return metrics(outcomes.map((item) => ({ kind: item.kind, detected: item.matched })));
}

/**
 * Reported severity against the labels, over vulnerable cases with a label and a kept
 * finding at the location: the same level, at most one level apart, rated higher or lower.
 */
export function severityAgreement(
  cases: readonly EvaluationCase[],
  outcomes: readonly AiOutcome[],
) {
  const labels = new Map(cases.map((item) => [item.id, item.severity]));
  const counts = { rated: 0, exact: 0, withinOne: 0, higher: 0, lower: 0 };
  for (const outcome of outcomes) {
    const label = labels.get(outcome.id);
    if (outcome.kind !== "vulnerable" || !label || !outcome.severity) continue;
    // Negative when the review rated it more severe than the label.
    const gap = SEVERITIES.indexOf(outcome.severity) - SEVERITIES.indexOf(label);
    counts.rated += 1;
    if (gap === 0) counts.exact += 1;
    if (Math.abs(gap) <= 1) counts.withinOne += 1;
    if (gap < 0) counts.higher += 1;
    if (gap > 0) counts.lower += 1;
  }
  return counts;
}

/** Vulnerable cases whose findings at the labeled location were all dismissed. */
export function dismissedByMistake(outcomes: readonly AiOutcome[]): number {
  return outcomes.filter(
    (item) => item.kind === "vulnerable" && !item.detected && item.verdicts.includes("dismissed"),
  ).length;
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
  corpus = "test/fixtures/evaluation",
): string {
  const ratio = (value: number | null) => (value === null ? "n/a" : value.toFixed(2));
  const vulnerable = cases.filter((item) => item.kind === "vulnerable").length;
  const libraries = cases.filter((item) => item.library).length;
  const lines = [
    `# Detection evaluation ${date}`,
    "",
    `Corpus: ${cases.length} labeled cases in \`${corpus}\`, ${vulnerable} vulnerable and ${cases.length - vulnerable} safe near-misses. A finding counts for a case when it overlaps the labeled lines; AI findings dismissed by the second review do not count. The corpus is small and synthetic: these figures describe it, not arbitrary projects.`,
    "",
    ...(libraries > 0
      ? [
          `${libraries === cases.length ? "Every case is" : `${libraries} cases are`} scanned as a package (library mode): the parameters of public functions count as untrusted input.`,
          "",
        ]
      : []),
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
    // Counting only findings that name the labeled weakness, so another issue at the same lines is not a false positive.
    const weakness = evaluation.runs.map((outcomes) => weaknessMetrics(outcomes));
    const weaknessPrecision = spread(weakness.map((item) => item.precision));
    const weaknessRecall = spread(weakness.map((item) => item.recall));
    const outcomes = evaluation.runs.flat();
    const failed = outcomes.filter((item) => item.status !== "completed").length;
    const costs = outcomes.map((item) => item.costUsd).filter((cost) => cost !== null);
    const requests = outcomes.reduce((sum, item) => sum + item.calls, 0);
    const rerun = outcomes.reduce((sum, item) => sum + (item.rateLimitedReruns ?? 0), 0);
    const tools = Object.entries(
      outcomes.reduce<Record<string, number>>((sum, item) => {
        for (const [name, count] of Object.entries(item.toolCalls ?? {}))
          sum[name] = (sum[name] ?? 0) + count;
        return sum;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b));
    const range = (value: ReturnType<typeof spread>) =>
      value === null
        ? "n/a"
        : `${value.mean.toFixed(2)} (min ${value.min.toFixed(2)}, max ${value.max.toFixed(2)})`;
    const agreement = severityAgreement(cases, outcomes);
    const unchecked = outcomes.reduce((sum, item) => sum + item.uncheckedDismissals, 0);
    lines.push(
      "",
      `## AI review: ${evaluation.provider.model}${evaluation.validator ? `, second review ${evaluation.validator.model}` : ""}`,
      "",
      `${evaluation.mode === "explore" ? "Explore" : "Batch"} mode, prompt digest \`${evaluation.promptDigest.slice(0, 12)}\`, ${evaluation.runs.length} ${evaluation.runs.length === 1 ? "run" : "runs"}, Standard depth. ${failed} of ${outcomes.length} reviews did not complete.${rerun ? ` ${rerun} ${rerun === 1 ? "review was" : "reviews were"} rerun after the provider answered HTTP 429.` : ""}${costs.length ? ` Estimated cost USD ${costs.reduce((sum, cost) => sum + cost, 0).toFixed(4)}.` : ""} ${requests} model requests${tools.length ? `; tool calls: ${tools.map(([name, count]) => `${name} ${count}`).join(", ")}` : ""}.`,
      "",
      `Precision ${range(precision)}. Recall ${range(recall)}. Counting only source-supported findings: precision ${range(strictPrecision)}, recall ${range(strictRecall)}. Counting only findings that name the labeled weakness: precision ${range(weaknessPrecision)}, recall ${range(weaknessRecall)}.`,
      "",
      `Severity of ${agreement.rated} rated detections across runs: ${agreement.exact} at the labeled level, ${agreement.withinOne} within one level, ${agreement.higher} rated higher and ${agreement.lower} lower. Vulnerable cases dismissed by mistake per run: ${evaluation.runs.map((run) => dismissedByMistake(run)).join(", ")}. Dismissals the host kept as needs-review: ${unchecked}.`,
      "",
      "| Run | TP | FP | FN | TN | Precision | Recall |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...evaluation.metrics.map(
        (item, index) =>
          `| ${index + 1} | ${item.truePositives} | ${item.falsePositives} | ${item.falseNegatives} | ${item.trueNegatives} | ${ratio(item.precision)} | ${ratio(item.recall)} |`,
      ),
      "",
      "| Case | Truth | Detected in runs | Verdicts at the location | Unlabeled findings | Severity: label, reported |",
      "| --- | --- | --- | --- | --- | --- |",
      ...cases.map((item) => {
        const own = evaluation.runs.map((outcomes) =>
          outcomes.find((outcome) => outcome.id === item.id),
        );
        const detected = own.filter((outcome) => outcome?.detected).length;
        const verdicts = own.flatMap((outcome) => outcome?.verdicts ?? []);
        const unlabeled = own.reduce((sum, outcome) => sum + (outcome?.unlabeled ?? 0), 0);
        const reported = own.flatMap((outcome) => (outcome?.severity ? [outcome.severity] : []));
        return `| ${item.id} | ${item.kind} | ${detected}/${own.length} | ${verdicts.join(", ") || "none"} | ${unlabeled} | ${item.severity ?? "n/a"}: ${reported.join(", ") || "none"} |`;
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
