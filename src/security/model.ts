import {
  type ReviewMode,
  SECURITY_REVIEW_LIMITS,
  type SecurityReview,
  type SpendingLimit,
} from "../assessment/review-model.ts";
import type { CostSummary } from "../redteam/model-pricing.ts";
import type { Severity } from "../rules/model.ts";

export const FINDING_STATUSES = ["new", "triaged", "in-progress", "resolved", "dismissed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
/** Limits a scan's spending limit must respect, and Full coverage's batch cap. */
export const SCAN_BUDGET_LIMITS = {
  minTokens: 10_000,
  maxTokens: 100_000_000,
  minUsd: 0.01,
  maxUsd: 1_000,
  defaultTokens: 2_000_000,
  defaultUsd: 5,
  /** Full coverage stops here even when budget remains: the reviews a scan can hold. */
  fullBatches: SECURITY_REVIEW_LIMITS.perScan,
} as const;
export const SCAN_DEPTHS = {
  quick: { label: "Quick", batches: 1, selectable: true },
  full: { label: "Full coverage", batches: SCAN_BUDGET_LIMITS.fullBatches, selectable: true },
  // Saved before Quick and Full coverage existed; shown, never started.
  standard: { label: "Standard", batches: 1, selectable: false },
  deep: { label: "Deep", batches: 3, selectable: false },
} as const;
export type ScanDepth = keyof typeof SCAN_DEPTHS;
/** The depths a new scan can choose. */
export type SelectableScanDepth = "quick" | "full";
/**
 * A scan's spending limit across every model connection it uses: accounted tokens, or
 * USD estimated from saved prices. A batch starts only when its maximum fits what remains.
 */
export type ScanBudget = SpendingLimit;
/** How much of the project a scan's batches covered, and why they stopped. */
export interface ScanCoverage {
  /** Files the review could read: parsed source and listed text files. */
  eligibleFiles: number;
  /** Files at least partly sent in some batch. */
  sentFiles: number;
  /**
   * `complete`: no unsent source that fits a batch remained. `budget`: the next batch's
   * maximum exceeded what remained of the limit. `limit`: the Full coverage batch cap.
   * `quick`: one batch by choice. `explored`: an exploring review read nothing earlier
   * reviews had not. Null while running and after a failure.
   */
  stop: "complete" | "budget" | "limit" | "quick" | "explored" | null;
  /** Charged against the limit: accounted tokens, and USD when every request was priced. */
  charged: { tokens: number; usd: number | null };
}
export const SECURITY_POLL_MS = 1000;
export interface SourceRevision {
  commit: string | null;
  branch: string | null;
  /** Unknown (null) for new scans: reading working-tree status can run project filters. */
  dirty: boolean | null;
}
/** Bounds of a project's threat model, which the host and the page both enforce. */
export const THREAT_MODEL_LIMITS = {
  textCharacters: 1200,
  items: 12,
  itemCharacters: 300,
} as const;
/**
 * A project's threat model: what earlier reviews derived, or what the user edited. Every
 * review of a scan starts from it, and each scan records the version it used.
 */
export interface ProjectThreatModel {
  version: number;
  updatedAt: string;
  /** `review`: derived from a scan's reviews. `user`: edited, so reviews keep it as it is. */
  origin: "review" | "user";
  /** For `review`: the scan it came from. */
  scanId: string | null;
  architecture: string;
  assets: string[];
  trustBoundaries: string[];
}
export interface LocalRepository {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  revision: SourceRevision;
  environment: { name: string; notes: string };
  /** Absent until a scan derives one or the user writes one. */
  threatModel?: ProjectThreatModel;
  monitoring: {
    enabled: boolean;
    providerId: string | null;
    depth: ScanDepth;
    lastCommit: string | null;
    error: string | null;
  };
}
export interface SecurityFinding {
  id: string;
  repositoryId: string;
  scanId: string;
  sourceScanId: string;
  reviewId: string | null;
  sourceFindingId: string;
  fingerprint: string;
  origin: "ai" | "static";
  /** STRIDE category of an AI finding; matches it to the same issue in a later scan. */
  category?: string;
  /** The weakness, as a CWE id (`CWE-89`): the review's choice, or the rule's first mapping. */
  cwe?: string;
  title: string;
  severity: Severity;
  status: FindingStatus;
  detectedAt: string;
  updatedAt: string;
  summary: string;
  rootCause: string;
  attackPath: string;
  validation: string;
  remediation: string;
  evidence: { path: string; line: number; endLine: number; message: string; snippet: string }[];
}
export type SecurityScanStatus = "running" | "completed" | "failed" | "cancelled";
export type SecurityScanPhase = "reading" | "discovering" | "validating" | "finished";
export interface SecurityScanSummary {
  id: string;
  repositoryId: string;
  sourceScanId: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  status: SecurityScanStatus;
  phase: SecurityScanPhase;
  initiatedBy: "Local user" | "Continuous scanning" | "Imported history";
  scope: "local" | "repository" | "continuous";
  depth: ScanDepth;
  /** How its reviews read the source; absent on scans from before exploration, which ran batches. */
  mode?: ReviewMode;
  provider: { id: string; name: string; model: string } | null;
  /** The saved connection that ran second reviews, when it was not `provider`. */
  validator?: { id: string; name: string; model: string };
  revision: SourceRevision;
  findingCount: number;
  modelCalls: number;
  tokens: number | null;
  /** Absent on older scans. Estimates use the prices captured when the scan started. */
  cost?: CostSummary | null;
  /** The spending limit chosen at the start; absent on older scans and unlimited Quick scans. */
  budget?: ScanBudget;
  /** Absent on older scans. */
  coverage?: ScanCoverage;
  /** The project threat model the scan started from; absent when there was none. */
  threatModel?: { version: number; origin: ProjectThreatModel["origin"] };
  error: string | null;
}
export interface SecurityScan extends SecurityScanSummary {
  environment: LocalRepository["environment"];
  findings: SecurityFinding[];
  reviews: SecurityReview[];
}
export interface SecurityWorkspace {
  repositories: LocalRepository[];
  scans: SecurityScanSummary[];
  findings: SecurityFinding[];
}
export interface StartSecurityScan {
  repositoryId: string;
  providerId: string;
  /** Omit for compatibility with clients using the provider's default model. */
  model?: string;
  /** A saved connection for second reviews, with its saved model; omit to use `providerId`. */
  validatorProviderId?: string;
  depth: SelectableScanDepth;
  /** Batch when omitted. Explore runs one exploring review, so it needs Quick. */
  mode?: ReviewMode;
  /** Required for Full coverage; optional for Quick. */
  budget?: ScanBudget;
}
