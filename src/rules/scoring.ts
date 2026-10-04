/** How findings are rated and identified: triage score, severity order, fingerprints and the test-code down-rating. */

import { sha256Hex } from "../shared/hash.ts";
import type { Confidence, Draft, Severity } from "./model.ts";

const SEVERITY_SCORE: Record<Severity, number> = { critical: 90, high: 70, medium: 45, low: 20 };
const CONFIDENCE_FACTOR: Record<Confidence, number> = { high: 1, medium: 0.85, low: 0.65 };
const EXPOSURE_BONUS = 10;

/** Position of each severity in the triage order, most severe first. */
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** How urgent a finding is, 0–100: severity, scaled by confidence, plus a bonus when it is exposed. */
export function triageScore(severity: Severity, confidence: Confidence, exposed: boolean): number {
  const score = SEVERITY_SCORE[severity] * CONFIDENCE_FACTOR[confidence];
  return Math.min(100, Math.round(score + (exposed ? EXPOSURE_BONUS : 0)));
}

/** Paths of tests and fixtures, whose code does not run in production. */
const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|spec|fixtures?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.py$/;

/** Findings in test code are kept, with lower confidence and a note. */
export function inTests(draft: Draft): Draft {
  if (!TEST_PATH.test(draft.location.path)) return draft;
  const confidence = draft.confidence === "high" ? "medium" : "low";
  return { ...draft, confidence, notes: [...draft.notes, "In test code."] };
}

/**
 * The stable identity of a finding: the rule, file, subject kind and the draft's own
 * key parts, numbered when several findings share them. Lines are left out so that
 * edits above a finding do not change its fingerprint.
 */
export function fingerprint(draft: Draft, ordinal: number): string {
  const base = [draft.rule, draft.location.path, draft.subject.kind, ...draft.key].join("\u0000");
  return sha256Hex(ordinal === 1 ? base : `${base}\u0000${ordinal}`, 16);
}
