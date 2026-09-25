// Shapes returned by the local plenger API. Keep in sync with src/plenger/api.

import type {EngineState} from './view-utils';

export type Ref = {path: string; line: number};
export type Node = {id: string; label: string; kind: string; source_ref: Ref; provenance?: string};
export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: string;
  source_ref?: Ref;
  provenance?: string;
};
export type GraphPage = {
  snapshot_id: string | null;
  nodes: Node[];
  edges: GraphEdge[];
  next_offset: number | null;
};
export type Evidence = {
  id: string;
  observed: string;
  source: string;
  sha256_redacted: string;
  retention_until?: string;
  size?: number;
};
export type Lifecycle = 'open' | 'acknowledged' | 'suppressed' | 'resolved';
export type Finding = {
  evidence_integrity?: string;
  evidence_expired?: boolean;
  kind?: string;
  lifecycle_state?: Lifecycle;
  suppression_state?: string;
  revision?: number;
  id: string;
  title: string;
  severity: string;
  validation_state: string;
  source_ref: Ref;
  evidence: Evidence;
  evidence_refs?: Evidence[];
  suppression?: {reason: string; expires_at: string};
};
export type TestResult = {
  case_id: string;
  category: string;
  result: string;
  reason_code: string;
  evidence: string[];
  http_status?: number;
};
export type Assessment = {
  id: string;
  finding_id: string;
  evaluator: 'deterministic' | 'manual' | 'jev';
  state: string;
  reason_code: string;
  requested_model?: string | null;
  resolved_model?: string | null;
  cached?: boolean;
  cache_source_id?: string | null;
  answers?: Record<string, unknown>;
  created_at: string;
};
export type Snapshot = {
  manifest_digest?: string;
  commit?: string | null;
  dirty?: boolean | null;
};
export type Report = {
  active?: boolean;
  test_results?: TestResult[];
  summary?: Record<string, number>;
  assessments?: Assessment[];
  accounting?: {
    reserved_attempts: number;
    cost: number | null;
    cost_status?: string;
    cost_guard?: string;
  };
  counts?: {
    nodes: number;
    edges: number;
    findings: number;
    priority_findings?: number;
    skipped?: number;
    assessments?: number;
    snapshot_files?: number;
    snapshot_skipped?: number;
  };
  view_truncated?: boolean;
  fixture: boolean;
  run_id: string;
  snapshot_id: string | null;
  snapshot?: Snapshot;
  created_at: string;
  state: string;
  profile: string;
  profile_digest?: string;
  rubric_hash?: string;
  case_ids?: string[];
  case_count?: number;
  nodes: Node[];
  edges: GraphEdge[];
  findings: Finding[];
  limitations: string[];
  coverage: {category: string; state: string}[];
  engine_states: Record<string, EngineState>;
};
export type RunSummary = {
  id: string;
  state: string;
  profile: string;
  fixture: boolean;
  plan_id?: string | null;
  approval_id?: string | null;
  attempts: number;
  reason?: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
};
export type RunHistoryPage = {items: RunSummary[]; next_offset?: number};
export type BudgetPreview = {
  max_cases: number;
  max_attempts: number;
  concurrency: number;
  request_timeout_seconds: number;
  wall_time_seconds: number;
  cost_guard: 'strict' | 'request_only';
  cost_acknowledged: boolean;
};
export type DiffItem = {
  fingerprint: string;
  status: string;
  base_finding_id?: string | null;
  current_finding_id?: string | null;
};
export type DiffResult = {
  comparable: boolean;
  reason: string;
  base_run_id?: string;
  current_run_id?: string;
  items: DiffItem[];
};
export type Plan = {
  id: string;
  state: string;
  plan_digest: string;
  scope_digest: string;
  target_revision?: string;
  preview?: {
    project_id: string;
    profile: string;
    profile_digest: string;
    rubric_hash: string;
    target_ref: string;
    target_revision: string;
    environment: 'local' | 'staging';
    base_origin: string;
    allowed_ips: string[];
    allowed_paths: string[];
    allowed_methods: string[];
    auth_profile_ref: string | null;
    max_response_bytes: number;
    observability: 'none' | 'trace';
    output_path: string;
    trace_path: string | null;
    case_ids: string[];
    case_count: number;
    snapshot_digest: string;
    auth_identity: string;
    data_classes: string[];
    budget: BudgetPreview;
  };
};
export type Approval = {id: string; expires_at: string};
export type AssessmentConsentPreview = {
  provider: 'jev';
  domain: string;
  data_classes: string[];
  config_hash: string;
  granted: boolean;
};
