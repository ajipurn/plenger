import type { SecurityReview } from "../assessment/review-model.ts";
import type { CostSummary } from "../redteam/model-pricing.ts";
import type { Severity } from "../rules/model.ts";

export const FINDING_STATUSES = ["new", "triaged", "in-progress", "resolved", "dismissed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export const SCAN_DEPTHS = {
  standard: { label: "Standard", batches: 1 },
  deep: { label: "Deep", batches: 3 },
} as const;
export type ScanDepth = keyof typeof SCAN_DEPTHS;
export const SECURITY_POLL_MS = 1000;
export interface SourceRevision {
  commit: string | null;
  branch: string | null;
  /** Unknown (null) for new scans: reading working-tree status can run project filters. */
  dirty: boolean | null;
}
export interface LocalRepository {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  revision: SourceRevision;
  environment: { name: string; notes: string };
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
  provider: { id: string; name: string; model: string } | null;
  revision: SourceRevision;
  findingCount: number;
  modelCalls: number;
  tokens: number | null;
  /** Absent on older scans. Estimates use the prices captured when the scan started. */
  cost?: CostSummary | null;
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
  depth: ScanDepth;
}
