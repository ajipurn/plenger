import { createHash } from "node:crypto";
import type { Inventory } from "../inventory/model.ts";
import type { Project } from "../project/project.ts";
import { RULE_BY_ID } from "./catalog.ts";
import { agentChecks } from "./checks/agents.ts";
import { mcpChecks } from "./checks/mcp.ts";
import { optionChecks } from "./checks/options.ts";
import { outputChecks } from "./checks/output.ts";
import { promptChecks } from "./checks/prompts.ts";
import { secretChecks } from "./checks/secrets.ts";
import { toolChecks } from "./checks/tools.ts";
import { RuleContext } from "./context.ts";
import type { Confidence, Draft, Evidence, Finding, Severity } from "./model.ts";

export { RULE_BY_ID, RULES } from "./catalog.ts";
export type { Confidence, Evidence, Finding, Rule, Severity } from "./model.ts";

const SEVERITY_SCORE: Record<Severity, number> = { critical: 90, high: 70, medium: 45, low: 20 };
const CONFIDENCE_FACTOR: Record<Confidence, number> = { high: 1, medium: 0.85, low: 0.65 };
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const EXPOSURE_BONUS = 10;

/** Runs every risk rule over the inventory and returns the findings, most urgent first. */
export function evaluateRules(project: Project, inventory: Inventory): Finding[] {
  const cx = new RuleContext(project, inventory);
  const drafts = [
    ...toolChecks(cx),
    ...agentChecks(cx),
    ...promptChecks(cx),
    ...outputChecks(cx),
    ...secretChecks(cx),
    ...mcpChecks(cx),
    ...optionChecks(cx),
  ];
  for (const draft of drafts) {
    if (!RULE_BY_ID.has(draft.rule)) throw new Error(`finding for unknown rule ${draft.rule}`);
  }
  // Model output that reaches a tool's effect is reported once, as the tool finding.
  const toolSinks = new Set(
    drafts.filter((draft) => /^PLG1\d\d$/.test(draft.rule)).map((draft) => at(draft.location)),
  );
  return finalize(
    drafts.filter((draft) => draft.rule !== "PLG401" || !toolSinks.has(at(draft.location))),
  );
}

function at(location: { path: string; line: number; column: number }): string {
  return `${location.path}:${location.line}:${location.column}`;
}

/** How urgent a finding is, 0–100: severity, scaled by confidence, plus a bonus when it is exposed. */
export function triageScore(severity: Severity, confidence: Confidence, exposed: boolean): number {
  const score = SEVERITY_SCORE[severity] * CONFIDENCE_FACTOR[confidence];
  return Math.min(100, Math.round(score + (exposed ? EXPOSURE_BONUS : 0)));
}

/** Paths of tests and fixtures, whose code does not run in production. */
const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|spec|fixtures?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.py$/;

/** Findings in test code are kept, with lower confidence and a note. */
function inTests(draft: Draft): Draft {
  if (!TEST_PATH.test(draft.location.path)) return draft;
  const confidence = draft.confidence === "high" ? "medium" : "low";
  return { ...draft, confidence, notes: [...draft.notes, "In test code."] };
}

function finalize(drafts: Draft[]): Finding[] {
  drafts = drafts.map(inTests);
  // Source order first, so that fingerprints of findings with the same key are numbered stably.
  drafts.sort(
    (a, b) =>
      compare(a.location.path, b.location.path) ||
      a.location.line - b.location.line ||
      a.location.column - b.location.column ||
      compare(a.rule, b.rule),
  );
  const counts = new Map<string, number>();
  const findings = drafts.map(({ key, ...draft }): Finding => {
    const base = [draft.rule, draft.location.path, draft.subject.kind, ...key].join("\u0000");
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    const fingerprint = createHash("sha256")
      .update(count === 1 ? base : `${base}\u0000${count}`)
      .digest("hex")
      .slice(0, 16);
    return {
      ...draft,
      evidence: mergeSameLine(draft.evidence),
      fingerprint,
      score: triageScore(draft.severity, draft.confidence, draft.exposed),
    };
  });
  return findings.sort(
    (a, b) =>
      b.score - a.score ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      compare(a.location.path, b.location.path) ||
      a.location.line - b.location.line ||
      compare(a.rule, b.rule),
  );
}

/** Joins consecutive evidence steps on the same line into one. */
function mergeSameLine(evidence: Evidence[]): Evidence[] {
  const merged: Evidence[] = [];
  for (const step of evidence) {
    const last = merged.at(-1);
    if (last?.location.path === step.location.path && last.location.line === step.location.line) {
      if (!last.message.includes(step.message)) last.message = `${last.message}; ${step.message}`;
      continue;
    }
    merged.push({ ...step });
  }
  return merged;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
