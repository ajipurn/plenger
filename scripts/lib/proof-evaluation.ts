/**
 * Measures proof sessions on the labeled corpus (docs/design/proof-tests.md, M11b): a
 * model writes and runs tests for each case with a `proof` label. A safe twin that is
 * Proven is a false proof; the acceptance is none, in every run.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { ExploreTools, exploreTools, ReadLog } from "../../src/assessment/review-explore.ts";
import { ReviewSourceReader } from "../../src/assessment/review-source.ts";
import type { ProofOutcome, ProofSessionStop } from "../../src/redteam/constants.ts";
import { proofEntries } from "../../src/redteam/proof-entry.ts";
import type { ProofFamily, ProofWeakness } from "../../src/redteam/proof-model.ts";
import { proofConnection } from "../../src/redteam/proof-provider.ts";
import { proofSession } from "../../src/redteam/proof-session.ts";
import type { ProviderAccess } from "../../src/redteam/provider.ts";
import { scan } from "../../src/scan.ts";
import { errorMessage } from "../../src/shared/guards.ts";
import { type EvaluationCase, reviewSnapshot } from "./evaluation.ts";

export interface ProofCaseOutcome {
  id: string;
  kind: EvaluationCase["kind"];
  expected: "proven" | "not-reproduced";
  /** `failed`: the session did not finish (a provider error); it scores nothing. */
  outcome: ProofOutcome | "failed";
  reason: string;
  stop: ProofSessionStop | null;
  modelCalls: number;
  testRuns: number;
  tokens: number;
  durationMs: number;
  /** The derived entry holds every labeled entry range. */
  entryMatchesLabel: boolean;
  /** The label says the harness cannot show this vulnerable case. */
  unprovable: boolean;
}

export interface ProofEvaluation {
  provider: { name: string; model: string };
  runs: ProofCaseOutcome[][];
}

const WEAKNESS_NAMES: Record<ProofWeakness, string> = {
  "CWE-22": "Path traversal",
  "CWE-78": "Command injection",
};
const FAMILY_OF_EXTENSION: Record<string, ProofFamily> = {
  ".py": "python",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "javascript",
};

async function caseSources(root: string): Promise<{ path: string; content: string }[]> {
  const found: { path: string; content: string }[] = [];
  const walk = async (folder: string) => {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.name !== "case.json")
        found.push({ path: relative(root, path), content: await readFile(path, "utf8") });
    }
  };
  await walk(root);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The same finding for both twins: it claims the weakness at the labeled lines and says
 * nothing about why. The safe twin's then stands for a finding the review wrongly
 * supported.
 */
function neutralFinding(item: EvaluationCase) {
  const weakness = item.cwe as ProofWeakness;
  const at = `${item.location.path}:${item.location.line}-${item.location.endLine}`;
  return {
    title: `${WEAKNESS_NAMES[weakness]} at ${at}`,
    weakness,
    summary: `The review reported that untrusted input reaches the code at ${at} without a check that stops it.`,
    attackPath: "Input enters through the entry and reaches the cited lines.",
    validation: "source-supported",
    evidence: [{ ...item.location, snippet: "" }],
  };
}

/** One session for one case. Provider failures become `failed`; nothing is retried. */
export async function proveCase(
  item: EvaluationCase,
  options: {
    access: ProviderAccess;
    images: Record<ProofFamily, string>;
    dispatch?: typeof fetch;
    session?: typeof proofSession;
  },
): Promise<ProofCaseOutcome> {
  const started = performance.now();
  const expected = item.kind === "vulnerable" ? "proven" : "not-reproduced";
  const family = FAMILY_OF_EXTENSION[extname(item.location.path)];
  const entries = proofEntries(await scan(item.root, { facts: true }), [item.location]);
  const entryMatchesLabel = (item.proof?.entry ?? []).every((label) =>
    entries.ranges.some(
      (range) =>
        range.path === label.path && range.line <= label.line && range.endLine >= label.endLine,
    ),
  );
  const base = {
    id: item.id,
    kind: item.kind,
    expected,
    entryMatchesLabel,
    unprovable: item.proof?.unprovable !== undefined,
  } as const;
  const empty = { stop: null, modelCalls: 0, testRuns: 0, tokens: 0 };
  if (!family || !entries.ranges.length)
    return {
      ...base,
      ...empty,
      outcome: "could-not-run",
      reason: family
        ? "No route, tool or public function reaches the cited code."
        : "No proof image for this language.",
      durationMs: Math.round(performance.now() - started),
    };
  const snapshot = await reviewSnapshot(item);
  const reader = await ReviewSourceReader.open(snapshot, []);
  const files: { path: string; text: string }[] = [];
  for (const path of [...new Set([...entries.ranges, item.location].map((range) => range.path))]) {
    const source = await reader.read(path);
    if (source)
      files.push({
        path,
        text: source.lines
          .slice(0, 400)
          .map((line, index) => `${index + 1}: ${line}`)
          .join("\n"),
      });
  }
  const read = new ExploreTools(snapshot, reader, [], new ReadLog());
  const connection = proofConnection(
    options.access,
    options.dispatch ? { dispatch: options.dispatch } : {},
  );
  try {
    const result = await (options.session ?? proofSession)({
      image: options.images[family],
      family,
      finding: neutralFinding(item),
      entries,
      cited: [item.location],
      sources: await caseSources(item.root),
      files,
      // The review's read tools, without its submit tool.
      tools: {
        definitions: exploreTools("discovery").slice(0, -1),
        run: (name, args) => read.run(name, args),
      },
      send: connection.send,
      tokens: connection.tokens,
    });
    return {
      ...base,
      outcome: result.outcome,
      reason: result.reason,
      stop: result.record.stop,
      modelCalls: result.record.modelCalls,
      testRuns: result.runs.length,
      tokens: connection.tokens.used(),
      durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      ...base,
      ...empty,
      outcome: "failed",
      reason: errorMessage(error).slice(0, 300),
      tokens: connection.tokens.used(),
      durationMs: Math.round(performance.now() - started),
    };
  }
}

/** Runs every labeled case `runs` times, one case at a time. */
export async function evaluateProof(
  cases: readonly EvaluationCase[],
  options: {
    provider: { name: string; model: string };
    access: ProviderAccess;
    images: Record<ProofFamily, string>;
    runs: number;
    dispatch?: typeof fetch;
    session?: typeof proofSession;
    onCase?: (outcome: ProofCaseOutcome, run: number) => void;
  },
): Promise<ProofEvaluation> {
  const labeled = cases.filter((item) => item.proof !== undefined);
  const runs: ProofCaseOutcome[][] = [];
  for (let run = 1; run <= options.runs; run++) {
    const outcomes: ProofCaseOutcome[] = [];
    for (const item of labeled) {
      const outcome = await proveCase(item, options);
      options.onCase?.(outcome, run);
      outcomes.push(outcome);
    }
    runs.push(outcomes);
  }
  return { provider: options.provider, runs };
}

export interface ProofScore {
  /** Vulnerable cases the harness can show; yield is `proven` of these. */
  vulnerable: number;
  proven: number;
  /** Vulnerable cases labeled unprovable that were Proven anyway: check the label. */
  unprovableProven: number;
  safe: number;
  falseProofs: number;
  failed: number;
  outcomes: Record<ProofCaseOutcome["outcome"], number>;
  stops: Partial<Record<ProofSessionStop, number>>;
  entryMismatches: number;
  tokens: number;
  modelCalls: number;
}

export function scoreProof(outcomes: readonly ProofCaseOutcome[]): ProofScore {
  const scored = outcomes.filter((item) => item.outcome !== "failed");
  const stops: ProofScore["stops"] = {};
  for (const item of outcomes) if (item.stop) stops[item.stop] = (stops[item.stop] ?? 0) + 1;
  const count = (outcome: ProofCaseOutcome["outcome"]) =>
    outcomes.filter((item) => item.outcome === outcome).length;
  return {
    vulnerable: scored.filter((item) => item.kind === "vulnerable" && !item.unprovable).length,
    proven: scored.filter(
      (item) => item.kind === "vulnerable" && !item.unprovable && item.outcome === "proven",
    ).length,
    unprovableProven: scored.filter((item) => item.unprovable && item.outcome === "proven").length,
    safe: scored.filter((item) => item.kind === "safe").length,
    falseProofs: scored.filter((item) => item.kind === "safe" && item.outcome === "proven").length,
    failed: count("failed"),
    outcomes: {
      proven: count("proven"),
      "not-reproduced": count("not-reproduced"),
      "could-not-run": count("could-not-run"),
      failed: count("failed"),
    },
    stops,
    entryMismatches: outcomes.filter((item) => !item.entryMatchesLabel).length,
    tokens: outcomes.reduce((sum, item) => sum + item.tokens, 0),
    modelCalls: outcomes.reduce((sum, item) => sum + item.modelCalls, 0),
  };
}

export function formatProofEvaluation(evaluation: ProofEvaluation, date: string): string {
  const lines = [
    `# Proof sessions: ${evaluation.provider.name}, \`${evaluation.provider.model}\` (${date})`,
    "",
    "| Run | False proofs | Yield | Proven | Not reproduced | Could not run | Failed | Tokens | Model calls |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  evaluation.runs.forEach((outcomes, index) => {
    const score = scoreProof(outcomes);
    lines.push(
      `| ${index + 1} | ${score.falseProofs} of ${score.safe} | ${score.proven} of ${score.vulnerable} | ${score.outcomes.proven} | ${score.outcomes["not-reproduced"]} | ${score.outcomes["could-not-run"]} | ${score.failed} | ${score.tokens.toLocaleString("en-US")} | ${score.modelCalls} |`,
    );
  });
  lines.push(
    "",
    "| Case | Kind | Outcome per run | Reason (last run) |",
    "| --- | --- | --- | --- |",
  );
  const ids = evaluation.runs[0]?.map((item) => item.id) ?? [];
  for (const id of ids) {
    const per = evaluation.runs.map((outcomes) => outcomes.find((item) => item.id === id));
    const last = per.at(-1);
    lines.push(
      `| \`${id}\` | ${last?.kind}${last?.unprovable ? ", unprovable" : ""} | ${per.map((item) => item?.outcome ?? "-").join(", ")} | ${(last?.reason ?? "").replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
