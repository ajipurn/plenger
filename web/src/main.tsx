import {useEffect, useRef, useState, type FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {engineStateSummary, snapshotWorkingTreeLabel, type EngineState} from './view-utils';
import './style.css';

type Ref = {path: string; line: number};
type Node = {id: string; label: string; kind: string; source_ref: Ref; provenance?: string};
type GraphEdge = {id: string; source: string; target: string; kind: string; source_ref?: Ref; provenance?: string};
type GraphPage = {snapshot_id: string | null; nodes: Node[]; edges: GraphEdge[]; next_offset: number | null};
type Evidence = {
  id: string;
  observed: string;
  source: string;
  sha256_redacted: string;
  retention_until?: string;
  size?: number;
};
type Lifecycle = 'open' | 'acknowledged' | 'suppressed' | 'resolved';
type Finding = {
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
type TestResult = {
  case_id: string;
  category: string;
  result: string;
  reason_code: string;
  evidence: string[];
  http_status?: number;
};
type Assessment = {
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
type Snapshot = {
  manifest_digest?: string;
  commit?: string | null;
  dirty?: boolean | null;
};
type Report = {
  active?: boolean;
  test_results?: TestResult[];
  assessments?: Assessment[];
  accounting?: {reserved_attempts: number; cost: number | null; cost_status?: string; cost_guard?: string};
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
type RunSummary = {
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
type RunHistoryPage = {items: RunSummary[]; next_offset?: number};
type BudgetPreview = {
  max_cases: number;
  max_attempts: number;
  concurrency: number;
  request_timeout_seconds: number;
  wall_time_seconds: number;
  cost_guard: 'strict' | 'request_only';
  cost_acknowledged: boolean;
};
type DiffItem = {
  fingerprint: string;
  status: string;
  base_finding_id?: string | null;
  current_finding_id?: string | null;
};
type DiffResult = {
  comparable: boolean;
  reason: string;
  base_run_id?: string;
  current_run_id?: string;
  items: DiffItem[];
};
type Plan = {
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
type Approval = {id: string; expires_at: string};
type AssessmentConsentPreview = {
  provider: 'jev';
  domain: string;
  data_classes: string[];
  config_hash: string;
  granted: boolean;
};

const COVERAGE_STATES = [
  {value: 'planned', label: 'Direncanakan'},
  {value: 'blocked', label: 'Diblokir'},
  {value: 'executed', label: 'Dijalankan'},
  {value: 'skipped', label: 'Dilewati'},
  {value: 'inconclusive', label: 'Inkonklusif'},
  {value: 'error', label: 'Error'},
  {value: 'not_tested', label: 'Belum diuji'},
] as const;

const EMPTY_GRAPH: GraphPage = {snapshot_id: null, nodes: [], edges: [], next_offset: null};
const ACTIVE_APPROVAL_ACTOR = 'browser-user';
const ACTIVE_APPROVAL_TTL_MINUTES = 5;

type ApiErrorEnvelope = {code?: unknown; request_id?: unknown};

const API_ERROR_MESSAGES: Record<string, string> = {
  active_runner_unavailable: 'Pengujian aktif tidak tersedia di host ini. Gunakan macOS atau Linux dengan dukungan Unix socket.',
  active_runner_failed: 'Pengujian aktif gagal dimulai. Periksa log server, lalu coba lagi.',
  assessment_unavailable: 'Riwayat assessment tidak tersedia karena data lokal perlu diperiksa.',
  assessment_consent_unavailable: 'Consent hosted belum dapat dimuat. Periksa konfigurasi lokal, lalu coba lagi.',
  assessment_consent_not_found: 'Consent hosted tidak ditemukan. Muat ulang status consent, lalu coba lagi.',
  approval_expired_or_used: 'Approval sudah kedaluwarsa atau pernah digunakan. Buat approval baru.',
  approval_not_found: 'Approval tidak ditemukan. Tinjau plan, lalu buat approval baru.',
  authorization_acknowledgment_required: 'Centang persetujuan scope sebelum menyetujui plan.',
  body_too_large: 'Data yang dikirim terlalu besar. Kurangi input, lalu coba lagi.',
  cancel_not_supported_for_static_run: 'Run scan statis tidak dapat dibatalkan dari dashboard.',
  config_changed: 'Konfigurasi workspace berubah. Muat ulang hasil analisis, lalu buat plan baru.',
  csrf_required: 'Sesi keamanan tidak cocok. Muat ulang halaman, lalu coba lagi.',
  finding_not_found: 'Temuan tidak ditemukan pada run ini. Muat ulang hasil analisis.',
  finding_revision_conflict_or_not_found: 'Temuan berubah atau tidak ditemukan. Muat ulang hasil analisis, lalu coba lagi.',
  hosted_consent_required: 'Berikan consent hosted sebelum menjalankan assessment Jev.',
  idempotency_key_required: 'Permintaan belum memiliki kunci idempotensi. Muat ulang halaman, lalu coba lagi.',
  idempotency_conflict: 'Permintaan dengan kunci yang sama memiliki input berbeda. Muat ulang halaman, lalu coba lagi.',
  internal_error: 'Server mengalami kesalahan. Periksa log server, lalu coba lagi.',
  invalid_approval: 'Data approval tidak valid. Periksa actor dan masa berlaku, lalu coba lagi.',
  invalid_event_cursor: 'Posisi riwayat run tidak valid. Muat ulang riwayat.',
  invalid_event_pagination: 'Halaman riwayat run tidak valid. Muat ulang riwayat.',
  invalid_finding_cursor: 'Penanda halaman temuan sudah tidak valid. Terapkan filter lagi.',
  invalid_finding_filter: 'Filter temuan tidak dikenali. Periksa nilai yang dipilih, lalu coba lagi.',
  invalid_graph_filter: 'Filter peta tidak valid. Periksa jenis atau path sumbernya, lalu coba lagi.',
  invalid_pagination: 'Halaman yang diminta tidak valid. Muat ulang data, lalu coba lagi.',
  invalid_plan: 'Scope plan tidak valid. Periksa target, path, case, dan budget.',
  invalid_request: 'Input belum sesuai format. Periksa nilai yang dimasukkan, lalu coba lagi.',
  invalid_host: 'Akses harus melalui alamat plenger yang tersedia di terminal.',
  invalid_origin: 'Asal halaman tidak diizinkan. Buka dashboard dari alamat plenger.',
  invalid_workspace_or_config: 'Konfigurasi workspace tidak valid. Jalankan doctor, lalu coba lagi.',
  not_found: 'Data yang diminta tidak ditemukan. Muat ulang hasil analisis, lalu coba lagi.',
  origin_required: 'Permintaan ini harus berasal dari dashboard plenger.',
  pairing_invalid_or_expired: 'Kode pairing salah, kedaluwarsa, atau sudah mencapai batas percobaan.',
  plan_changed: 'Scope plan sudah berubah. Buat plan baru sebelum menyetujuinya.',
  plan_not_approved: 'Plan belum disetujui. Tinjau scope, lalu setujui plan sekali pakai.',
  plan_not_approvable: 'Plan ini tidak lagi dapat disetujui. Cabut plan, lalu buat plan baru.',
  plan_not_found: 'Plan tidak ditemukan. Muat ulang hasil analisis, lalu buat plan baru.',
  plan_not_found_or_closed: 'Plan sudah ditutup atau tidak ditemukan. Muat ulang hasil analisis, lalu buat plan baru.',
  plan_prerequisite_failed: 'Prasyarat plan belum terpenuhi. Periksa snapshot dan scope, lalu buat plan baru.',
  project_worker_busy: 'Worker proyek sedang menjalankan pemeriksaan lain. Tunggu sampai selesai, lalu coba lagi.',
  queue_capacity: 'Antrean pengujian penuh. Tunggu sebentar, lalu coba lagi.',
  run_not_found: 'Run tidak ditemukan. Muat ulang riwayat pemeriksaan.',
  run_not_queued: 'Run sudah tidak berada di antrean. Muat ulang status run.',
  session_required: 'Sesi berakhir atau kode tidak valid. Jalankan ulang serve untuk kode baru.',
  strict_cost_guard_requires_target_control: 'Target belum menyediakan kontrol biaya yang diperlukan untuk guard ketat.',
  ui_assets_not_built: 'Aset dashboard belum tersedia. Jalankan build UI, lalu muat ulang serve.',
};

class ApiError extends Error {
  readonly code: string | null;
  readonly status: number;
  readonly requestId: string | null;

  constructor(status: number, code: string | null, requestId: string | null) {
    const message = code && API_ERROR_MESSAGES[code]
      ? API_ERROR_MESSAGES[code]
      : status === 401
        ? API_ERROR_MESSAGES.session_required
        : 'Data belum dapat dimuat. Periksa log server, lalu coba lagi.';
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

async function request<T = any>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api/v1/' + path, options);
  if (!response.ok) {
    let payload: ApiErrorEnvelope = {};
    try {
      payload = (await response.json()) as ApiErrorEnvelope;
    } catch {
      // Keep the safe status-based fallback when the response is not JSON.
    }
    const code = typeof payload.code === 'string' ? payload.code : null;
    const requestId = typeof payload.request_id === 'string' ? payload.request_id : null;
    throw new ApiError(response.status, code, requestId);
  }
  return (await response.json()) as T;
}

function App() {
  const [session, setSession] = useState<{project_id: string; csrf_token: string} | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [findingsCursor, setFindingsCursor] = useState<string | null>(null);
  const [findingsBusy, setFindingsBusy] = useState(false);
  const [findingSeverity, setFindingSeverity] = useState('');
  const [findingValidation, setFindingValidation] = useState('');
  const [findingLifecycle, setFindingLifecycle] = useState('');
  const [findingKind, setFindingKind] = useState('');
  const [findingSourcePath, setFindingSourcePath] = useState('');
  const [graph, setGraph] = useState<GraphPage>(EMPTY_GRAPH);
  const [graphBusy, setGraphBusy] = useState(false);
  const [graphKind, setGraphKind] = useState('');
  const [graphSourcePath, setGraphSourcePath] = useState('');
  const [selectedGraphEdgeId, setSelectedGraphEdgeId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [historyNextOffset, setHistoryNextOffset] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [baseRunId, setBaseRunId] = useState('');
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [staticRun, setStaticRun] = useState<string | null>(null);
  const [activePlanRun, setActivePlanRun] = useState<string | null>(null);
  const [activeRunState, setActiveRunState] = useState('');
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [activeApproval, setActiveApproval] = useState<Approval | null>(null);
  const [activeEnvironment, setActiveEnvironment] = useState<'local' | 'staging'>('local');
  const [activeBaseUrl, setActiveBaseUrl] = useState('http://127.0.0.1:8080');
  const [activePath, setActivePath] = useState('/test');
  const [activeCases, setActiveCases] = useState(
    'LLM01-direct-policy,LLM02-synthetic-disclosure,LLM03-supply-chain-integrity,LLM04-data-model-poisoning,LLM05-output-handling,LLM06-tool-authorization,LLM07-system-prompt-leakage,LLM08-tenant-boundary,LLM09-misinformation,LLM10-unbounded-consumption',
  );
  const [activeCostAcknowledged, setActiveCostAcknowledged] = useState(false);
  const [activeAcknowledged, setActiveAcknowledged] = useState(false);
  const [fixture, setFixture] = useState(false);
  const [assessmentProvider, setAssessmentProvider] = useState<
    'deterministic' | 'manual' | 'jev'
  >('deterministic');
  const [assessmentConsent, setAssessmentConsent] = useState(false);
  const [assessmentConsentPreview, setAssessmentConsentPreview] = useState<AssessmentConsentPreview | null>(null);
  const [assessingFinding, setAssessingFinding] = useState<string | null>(null);
  const [assessmentHistory, setAssessmentHistory] = useState<Assessment[]>([]);
  const [assessmentNextOffset, setAssessmentNextOffset] = useState<number | null>(null);
  const [assessmentHistoryBusy, setAssessmentHistoryBusy] = useState(false);
  const refreshGeneration = useRef(0);
  const sessionGeneration = useRef(0);
  const activeReportRunId = useRef<string | null>(null);

  function canApplyRefresh(generation: number, runId: string): boolean {
    return generation === refreshGeneration.current && activeReportRunId.current === runId;
  }

  function canApplySession(generation: number): boolean {
    return generation === sessionGeneration.current;
  }

  async function loadHistory(
    id: string,
    append = false,
    generation = sessionGeneration.current,
  ) {
    if (generation !== sessionGeneration.current) return;
    setHistoryBusy(true);
    try {
      const offset = append ? historyNextOffset ?? 0 : 0;
      const data = await request<RunHistoryPage>(
        `projects/${id}/runs?limit=50&offset=${offset}`,
      );
      if (generation !== sessionGeneration.current) return;
      setRuns((current) => (append ? [...current, ...data.items] : data.items));
      setHistoryNextOffset(
        typeof data.next_offset === 'number' ? data.next_offset : null,
      );
      if (!append) {
        const pendingStatic = data.items.find(
          (run) =>
            !run.plan_id
            && run.profile === 'deterministic'
            && ['queued', 'running'].includes(run.state),
        );
        const pendingActive = data.items.find(
          (run) =>
            Boolean(run.plan_id)
            && ['queued', 'running', 'cancelling'].includes(run.state),
        );
        setStaticRun(pendingStatic?.id ?? null);
        setActivePlanRun(pendingActive?.id ?? null);
        setActiveRunState(pendingActive?.state ?? '');
      }
    } catch (exception) {
      if (generation === sessionGeneration.current) setError((exception as Error).message);
    } finally {
      if (generation === sessionGeneration.current) setHistoryBusy(false);
    }
  }

  async function loadAssessmentConsent(generation = sessionGeneration.current) {
    if (generation !== sessionGeneration.current) return;
    try {
      const data = (await request('assessment-consent')) as AssessmentConsentPreview;
      if (generation !== sessionGeneration.current) return;
      setAssessmentConsentPreview(data);
      setAssessmentConsent(data.granted);
    } catch (exception) {
      if (generation === sessionGeneration.current) setError((exception as Error).message);
    }
  }

  async function loadAssessmentHistory(
    runId: string,
    append = false,
    generation = refreshGeneration.current,
  ) {
    setAssessmentHistoryBusy(true);
    try {
      const offset = append ? assessmentNextOffset ?? 0 : 0;
      const params = new URLSearchParams({limit: '100', offset: String(offset)});
      const data = await request<{items: Assessment[]; next_offset?: number}>(
        `runs/${runId}/assessments?${params.toString()}`,
      );
      if (!canApplyRefresh(generation, runId)) return;
      setAssessmentHistory((current) => (append ? [...current, ...data.items] : data.items));
      setAssessmentNextOffset(typeof data.next_offset === 'number' ? data.next_offset : null);
    } catch (exception) {
      if (canApplyRefresh(generation, runId)) setError((exception as Error).message);
    } finally {
      if (canApplyRefresh(generation, runId)) setAssessmentHistoryBusy(false);
    }
  }

  async function loadFindings(
    id: string,
    runId: string,
    append = false,
    fallback: Finding[] = [],
    generation = refreshGeneration.current,
  ) {
    setFindingsBusy(true);
    try {
      const params = new URLSearchParams({limit: '100', run_id: runId});
      if (findingSeverity) params.set('severity', findingSeverity);
      if (findingValidation) params.set('validation_state', findingValidation);
      if (findingLifecycle) params.set('lifecycle_state', findingLifecycle);
      if (findingKind) params.set('kind', findingKind);
      if (findingSourcePath.trim()) params.set('source_path', findingSourcePath.trim());
      if (append && findingsCursor) params.set('cursor', findingsCursor);
      const data = await request(`projects/${id}/findings?${params.toString()}`);
      if (!canApplyRefresh(generation, runId)) return;
      const items = data.items as Finding[];
      const filtered = Boolean(
        findingSeverity
        || findingValidation
        || findingLifecycle
        || findingKind
        || findingSourcePath.trim(),
      );
      if (append) {
        setFindings((current) => [...current, ...items]);
      } else if (items.length > 0 || filtered || fallback.length === 0) {
        setFindings(items);
      } else {
        setFindings(fallback);
      }
      setFindingsCursor(data.next_cursor as string | null);
    } catch (exception) {
      if (canApplyRefresh(generation, runId)) setError((exception as Error).message);
    } finally {
      if (canApplyRefresh(generation, runId)) setFindingsBusy(false);
    }
  }

  async function loadGraph(
    id: string,
    runId: string,
    append = false,
    fallbackNodes: Node[] = [],
    fallbackEdges: GraphEdge[] = [],
    fallbackSnapshotId: string | null = null,
    generation = refreshGeneration.current,
  ) {
    setGraphBusy(true);
    try {
      const offset = append ? graph.next_offset ?? 0 : 0;
      const params = new URLSearchParams({limit: '100', offset: String(offset), run_id: runId});
      if (graphKind) params.set('node_kind', graphKind);
      if (graphSourcePath.trim()) params.set('source_path', graphSourcePath.trim());
      const data = await request(`projects/${id}/graph?${params.toString()}`);
      if (!canApplyRefresh(generation, runId)) return;
      const page: GraphPage = {
        snapshot_id: (data.snapshot_id as string | null) ?? null,
        nodes: data.nodes as Node[],
        edges: data.edges as GraphEdge[],
        next_offset: (data.next_offset as number | null) ?? null,
      };
      if (append) {
        setGraph((current) => ({
          snapshot_id: page.snapshot_id ?? current.snapshot_id,
          nodes: [...current.nodes, ...page.nodes],
          edges: [...current.edges, ...page.edges],
          next_offset: page.next_offset,
        }));
      } else if (
        page.nodes.length > 0
        || page.edges.length > 0
        || graphKind
        || graphSourcePath.trim()
        || (fallbackNodes.length === 0 && fallbackEdges.length === 0)
      ) {
        setGraph(page);
        setSelectedGraphEdgeId(null);
      } else {
        setGraph({snapshot_id: fallbackSnapshotId, nodes: fallbackNodes, edges: fallbackEdges, next_offset: null});
        setSelectedGraphEdgeId(null);
      }
    } catch (exception) {
      if (canApplyRefresh(generation, runId) && !append) {
        setGraph({snapshot_id: fallbackSnapshotId, nodes: fallbackNodes, edges: fallbackEdges, next_offset: null});
        setSelectedGraphEdgeId(null);
      }
      if (canApplyRefresh(generation, runId)) setError((exception as Error).message);
    } finally {
      if (canApplyRefresh(generation, runId)) setGraphBusy(false);
    }
  }

  function clearReportState(messageText = '') {
    setReport(null);
    setFixture(false);
    setSelectedRunId(null);
    setFindings([]);
    setFindingsCursor(null);
    setGraph(EMPTY_GRAPH);
    setSelectedGraphEdgeId(null);
    setAssessmentHistory([]);
    setAssessmentNextOffset(null);
    setFindingsBusy(false);
    setGraphBusy(false);
    setAssessmentHistoryBusy(false);
    setDiff(null);
    setMessage(messageText);
  }

  async function refresh(id: string, runId?: string) {
    const generation = refreshGeneration.current + 1;
    refreshGeneration.current = generation;
    activeReportRunId.current = runId ?? null;
    setBusy(true);
    setFindingsBusy(false);
    setGraphBusy(false);
    setAssessmentHistoryBusy(false);
    setError('');
    setMessage('Memuat hasil analisis…');
    try {
      const suffix = runId ? `?run_id=${encodeURIComponent(runId)}` : '';
      const data = await request(`projects/${id}/report${suffix}`);
      if (generation !== refreshGeneration.current) return;
      activeReportRunId.current = data.report?.run_id ?? null;
      setReport(data.report as Report | null);
      if (data.report) {
        setFixture(data.report.fixture);
        setSelectedRunId(data.report.run_id);
        setAssessmentHistory((data.report.assessments as Assessment[] | undefined) ?? []);
        setAssessmentNextOffset(null);
        await Promise.all([
          loadFindings(id, data.report.run_id, false, data.report.findings as Finding[], generation),
          loadGraph(id, data.report.run_id, false, data.report.nodes as Node[], data.report.edges as GraphEdge[], data.report.snapshot_id, generation),
          loadAssessmentHistory(data.report.run_id, false, generation),
        ]);
        if (generation === refreshGeneration.current) setMessage('Hasil analisis dimuat.');
      } else {
        clearReportState('Belum ada hasil analisis.');
      }
    } catch (exception) {
      if (generation === refreshGeneration.current) {
        activeReportRunId.current = null;
        clearReportState();
        setError((exception as Error).message);
      }
    } finally {
      if (generation === refreshGeneration.current) setBusy(false);
    }
  }

  async function selectRun(runId: string) {
    if (!session || !runId) return;
    setDiff(null);
    await refresh(session.project_id, runId);
  }

  async function compareRuns() {
    if (!session || !baseRunId || !selectedRunId || baseRunId === selectedRunId) return;
    const generation = sessionGeneration.current;
    setHistoryBusy(true);
    setError('');
    try {
      const data = await request(
        `projects/${session.project_id}/diff?base_run_id=${encodeURIComponent(baseRunId)}&current_run_id=${encodeURIComponent(selectedRunId)}`,
      );
      if (!canApplySession(generation)) return;
      setDiff(data as DiffResult);
      setMessage(data.comparable ? 'Perbandingan run selesai.' : 'Run tidak dapat dibandingkan.');
    } catch (exception) {
      if (canApplySession(generation)) setError((exception as Error).message);
    } finally {
      if (canApplySession(generation)) setHistoryBusy(false);
    }
  }

  useEffect(() => {
    const generation = sessionGeneration.current;
    request('session')
      .then((current) => {
        if (generation !== sessionGeneration.current) return;
        setSession(current);
        void refresh(current.project_id);
        void loadHistory(current.project_id, false, generation);
        void loadAssessmentConsent(generation);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!staticRun || !session) return;
    const generation = sessionGeneration.current;
    let stopped = false;
    const poll = async () => {
      try {
        const run = await request(`runs/${staticRun}`);
        if (stopped || !canApplySession(generation)) return;
        if (['queued', 'running'].includes(run.state)) {
          setMessage(run.state === 'queued' ? 'Scan masuk antrean…' : 'Memeriksa kode dalam sandbox…');
          return;
        }
        setStaticRun(null);
        if (['completed', 'completed_with_errors'].includes(run.state)) {
          await refresh(session.project_id);
          if (canApplySession(generation)) await loadHistory(session.project_id, false, generation);
        } else {
          setError(`Scan ${run.state}. Periksa kesiapan sandbox dan konfigurasi melalui plenger doctor.`);
          setMessage('');
        }
      } catch (exception) {
        if (!stopped && canApplySession(generation)) {
          setError((exception as Error).message);
          setStaticRun(null);
        }
      }
    };
    const timer = window.setInterval(poll, 1000);
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [staticRun, session]);

  useEffect(() => {
    if (!activePlanRun || !session) return;
    const generation = sessionGeneration.current;
    let stopped = false;
    const poll = async () => {
      try {
        const run = await request(`runs/${activePlanRun}`);
        if (stopped || !canApplySession(generation)) return;
        setActiveRunState(run.state);
        if (['queued', 'running', 'cancelling'].includes(run.state)) {
          setMessage(
            run.state === 'queued' ? 'Pengujian aktif masuk antrean…' : `Pengujian aktif: ${run.state}…`,
          );
          return;
        }
        setActivePlanRun(null);
        setActivePlan(null);
        setActiveApproval(null);
        setActiveCostAcknowledged(false);
        const reportReady = ['completed', 'completed_with_errors'].includes(run.state);
        if (reportReady) {
          await refresh(session.project_id);
        }
        if (canApplySession(generation)) await loadHistory(session.project_id, false, generation);
        if (!reportReady) {
          setMessage(`Pengujian aktif ${run.state}.`);
        }
      } catch (exception) {
        if (!stopped && canApplySession(generation)) setError((exception as Error).message);
      }
    };
    const timer = window.setInterval(poll, 1000);
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activePlanRun, session]);

  async function startScan() {
    if (!session) return;
    const generation = sessionGeneration.current;
    setBusy(true);
    setError('');
    try {
      const run = await request(`projects/${session.project_id}/scans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': session.csrf_token,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({profile: 'deterministic', fixture}),
      });
      if (!canApplySession(generation)) return;
      setStaticRun(run.run_id);
      setMessage('Scan masuk antrean…');
    } catch (exception) {
      if (canApplySession(generation)) setError((exception as Error).message);
    } finally {
      if (canApplySession(generation)) setBusy(false);
    }
  }

  async function pair(event: FormEvent) {
    event.preventDefault();
    let generation = sessionGeneration.current;
    setBusy(true);
    setError('');
    try {
      const current = await request('pair', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({code}),
      });
      setSession(current);
      generation = sessionGeneration.current + 1;
      sessionGeneration.current = generation;
      setCode('');
      await refresh(current.project_id);
      if (generation !== sessionGeneration.current) return;
      await loadHistory(current.project_id, false, generation);
      await loadAssessmentConsent(generation);
    } catch (exception) {
      if (canApplySession(generation)) setError((exception as Error).message);
    } finally {
      if (canApplySession(generation)) setBusy(false);
    }
  }

  async function logout() {
    if (!session) return;
    sessionGeneration.current += 1;
    refreshGeneration.current += 1;
    activeReportRunId.current = null;
    try {
      await request('logout', {method: 'POST', headers: {'X-CSRF-Token': session.csrf_token}});
      setSession(null);
      setReport(null);
      setBusy(false);
      setFindingsBusy(false);
      setGraphBusy(false);
      setAssessmentHistoryBusy(false);
      setHistoryBusy(false);
      setFindings([]);
      setFindingsCursor(null);
      setGraph(EMPTY_GRAPH);
      setSelectedGraphEdgeId(null);
      setAssessmentHistory([]);
      setAssessmentNextOffset(null);
      setAssessmentConsentPreview(null);
      setAssessmentConsent(false);
      setActivePlanRun(null);
      setActivePlan(null);
      setActiveApproval(null);
      setActiveCostAcknowledged(false);
      setRuns([]);
      setHistoryNextOffset(null);
      setDiff(null);
      setSelectedRunId(null);
      setMessage('Sesi ditutup. Jalankan ulang serve untuk memasangkan kembali.');
    } catch (exception) {
      setError((exception as Error).message);
    }
  }

  async function createActivePlan() {
    if (!session || !report?.snapshot?.manifest_digest) {
      setError('Jalankan scan statis terlebih dahulu agar snapshot dapat diikat ke plan.');
      return;
    }
    if (!activeCostAcknowledged) {
      setError('Akui dahulu bahwa biaya target internal tidak tersedia; plan akan memakai request-only guard.');
      return;
    }
    const generation = sessionGeneration.current;
    setBusy(true);
    setError('');
    try {
      const plan = await request(`projects/${session.project_id}/plans`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token},
        body: JSON.stringify({
          target: {
            target_ref: activeEnvironment === 'local' ? 'local-fixture' : 'staging-target',
            base_url: activeBaseUrl,
            environment: activeEnvironment,
            allowed_paths: [activePath],
            allowed_methods: ['POST'],
            observability: 'trace',
          },
          case_ids: activeCases.split(',').map((item) => item.trim()).filter(Boolean),
          snapshot_digest: report.snapshot.manifest_digest,
          auth_identity: ACTIVE_APPROVAL_ACTOR,
          data_classes: ['metadata', 'prompt', 'response', 'trace'],
          budget: {
            max_cases: 40,
            max_attempts: 80,
            concurrency: 2,
            request_timeout_seconds: 30,
            wall_time_seconds: 600,
            cost_guard: 'request_only',
            cost_acknowledged: true,
          },
        }),
      });
      if (!canApplySession(generation)) return;
      setActivePlan(plan);
      setActiveApproval(null);
      setActiveAcknowledged(false);
      setMessage('Plan aktif dibuat. Periksa digest dan scope sebelum menyetujui.');
    } catch (exception) {
      if (canApplySession(generation)) setError((exception as Error).message);
    } finally {
      if (canApplySession(generation)) setBusy(false);
    }
  }

  async function approveActivePlan() {
    if (!session || !activePlan || !activeAcknowledged) return;
    const generation = sessionGeneration.current;
    setBusy(true);
    setError('');
    try {
      const approval = await request(`plans/${activePlan.id}/approvals`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token},
        body: JSON.stringify({
          actor: ACTIVE_APPROVAL_ACTOR,
          acknowledgment: 'I_AUTHORIZE_THIS_EXPLICIT_SCOPE',
          ttl_minutes: ACTIVE_APPROVAL_TTL_MINUTES,
        }),
      });
      if (!canApplySession(generation)) return;
      setActiveApproval(approval);
      setMessage('Plan disetujui sekali pakai.');
    } catch (exception) {
      if (canApplySession(generation)) setError((exception as Error).message);
    } finally {
      if (canApplySession(generation)) setBusy(false);
    }
  }

  async function startActivePlan() {
    if (!session || !activePlan || !activeApproval) return;
    const generation = sessionGeneration.current;
    setBusy(true);
    setError('');
    try {
      const run = await request(`plans/${activePlan.id}/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': session.csrf_token,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({approval_id: activeApproval.id}),
      });
      if (!canApplySession(generation)) return;
      setActivePlanRun(run.run_id);
      setActiveRunState('queued');
      setMessage('Pengujian aktif masuk antrean…');
    } catch (exception) {
      if (canApplySession(generation)) setError((exception as Error).message);
    } finally {
      if (canApplySession(generation)) setBusy(false);
    }
  }

  async function cancelActivePlan() {
    if (!session || !activePlanRun) return;
    const generation = sessionGeneration.current;
    try {
      await request(`runs/${activePlanRun}/cancel`, {
        method: 'POST',
        headers: {'X-CSRF-Token': session.csrf_token},
      });
      if (canApplySession(generation)) setMessage('Pembatalan dikirim ke worker.');
    } catch (exception) {
      if (canApplySession(generation)) setError((exception as Error).message);
    }
  }

  async function revokeActivePlan() {
    if (!session || !activePlan || activePlanRun) return;
    const generation = sessionGeneration.current;
    setBusy(true);
    setError('');
    try {
      await request(`plans/${activePlan.id}/revoke`, {
        method: 'POST',
        headers: {'X-CSRF-Token': session.csrf_token},
      });
      if (!canApplySession(generation)) return;
      setActivePlan(null);
      setActiveApproval(null);
      setActiveAcknowledged(false);
      setActiveCostAcknowledged(false);
      setMessage('Plan aktif dicabut. Periksa scope lalu buat plan baru.');
    } catch (exception) {
      if (canApplySession(generation)) setError((exception as Error).message);
    } finally {
      if (canApplySession(generation)) setBusy(false);
    }
  }

  async function updateFinding(finding: Finding, lifecycleState: Lifecycle) {
    if (!session) return;
    const generation = sessionGeneration.current;
    setBusy(true);
    setError('');
    const reasonByState: Record<Lifecycle, string> = {
      open: 'Dibuka kembali untuk verifikasi ulang oleh reviewer lokal.',
      acknowledged: 'Ditinjau oleh reviewer lokal.',
      suppressed: 'Disembunyikan sementara oleh reviewer lokal; kedaluwarsa dalam 30 hari.',
      resolved: 'Diperiksa ulang oleh reviewer lokal.',
    };
    try {
      await request(`findings/${finding.id}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token},
        body: JSON.stringify({
          lifecycle_state: lifecycleState,
          reason: reasonByState[lifecycleState],
          expected_revision: finding.revision ?? 0,
          actor: 'browser-user',
          expiry_days: 30,
        }),
      });
      await refresh(session.project_id, report?.run_id);
      if (!canApplySession(generation)) return;
      await loadHistory(session.project_id, false, generation);
      if (!canApplySession(generation)) return;
      setMessage(
        lifecycleState === 'open'
          ? 'Temuan dibuka kembali untuk verifikasi.'
          : lifecycleState === 'suppressed'
            ? 'Temuan disembunyikan sementara selama 30 hari.'
            : lifecycleState === 'resolved'
              ? 'Temuan ditandai terselesaikan dalam workflow.'
              : 'Temuan ditandai sudah ditinjau.',
      );
    } catch (exception) {
      if (canApplySession(generation)) setError((exception as Error).message);
    } finally {
      if (canApplySession(generation)) setBusy(false);
    }
  }

  async function assessFinding(finding: Finding) {
    const hostedConsentGranted = assessmentConsent || Boolean(assessmentConsentPreview?.granted);
    if (!session || !report || (assessmentProvider === 'jev' && !hostedConsentGranted)) return;
    const generation = sessionGeneration.current;
    setBusy(true);
    setAssessingFinding(finding.id);
    setError('');
    try {
      await request(`runs/${report.run_id}/assessments`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token},
        body: JSON.stringify({
          finding_id: finding.id,
          provider: assessmentProvider,
          consent: assessmentProvider === 'jev' && assessmentConsent,
          data_classes: assessmentConsentPreview?.data_classes ?? ['metadata', 'code_excerpt', 'response'],
        }),
      });
      await refresh(session.project_id, report.run_id);
      if (!canApplySession(generation)) return;
      setMessage('Hasil assessment disimpan untuk ditinjau. Assessment tidak mengubah status authority temuan.');
    } catch (exception) {
      if (canApplySession(generation)) setError((exception as Error).message);
    } finally {
      if (canApplySession(generation)) {
        setBusy(false);
        setAssessingFinding(null);
      }
    }
  }

  async function grantAssessmentConsent() {
    if (!session || !assessmentConsentPreview) return;
    const generation = sessionGeneration.current;
    setBusy(true);
    setError('');
    try {
      await request('assessment-consent', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token},
        body: JSON.stringify({
          provider: assessmentConsentPreview.provider,
          data_classes: assessmentConsentPreview.data_classes,
          acknowledgment: 'I_AUTHORIZE_HOSTED_ASSESSMENT',
        }),
      });
      if (!canApplySession(generation)) return;
      setAssessmentConsent(true);
      setAssessmentConsentPreview((current) => current ? {...current, granted: true} : current);
      setMessage('Consent hosted disimpan untuk konfigurasi ini.');
    } catch (exception) {
      if (canApplySession(generation)) setError((exception as Error).message);
    } finally {
      if (canApplySession(generation)) setBusy(false);
    }
  }

  async function revokeAssessmentConsent() {
    if (!session || !assessmentConsentPreview?.granted) return;
    const generation = sessionGeneration.current;
    setBusy(true);
    setError('');
    try {
      await request('assessment-consent', {
        method: 'DELETE',
        headers: {'X-CSRF-Token': session.csrf_token},
      });
      if (!canApplySession(generation)) return;
      setAssessmentConsent(false);
      setAssessmentConsentPreview((current) => current ? {...current, granted: false} : current);
      setMessage('Consent hosted dicabut. Assessment Jev berikutnya akan meminta persetujuan lagi.');
    } catch (exception) {
      if (canApplySession(generation)) setError((exception as Error).message);
    } finally {
      if (canApplySession(generation)) setBusy(false);
    }
  }

  function download() {
    if (!report) return;
    const anchor = document.createElement('a');
    anchor.href = `/api/v1/runs/${report.run_id}/exports/json`;
    anchor.download = `plenger-${report.run_id}.json`;
    anchor.click();
  }

  const label = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const selectedGraphEdge = graph.edges.find((edge) => edge.id === selectedGraphEdgeId) ?? null;
  const lifecycleActions = (finding: Finding) => {
    const state = finding.lifecycle_state ?? 'open';
    return (
      <div className="finding-actions" aria-label={`Tindakan lifecycle untuk ${finding.title}`}>
        {state === 'open' && <button disabled={busy} onClick={() => void updateFinding(finding, 'acknowledged')}>Tandai sudah ditinjau</button>}
        {state !== 'suppressed' && state !== 'resolved' && <button disabled={busy} onClick={() => void updateFinding(finding, 'suppressed')}>Sembunyikan sementara</button>}
        {state !== 'resolved' && <button disabled={busy} onClick={() => void updateFinding(finding, 'resolved')}>Tandai terselesaikan</button>}
        {(state === 'resolved' || state === 'suppressed') && <button disabled={busy} onClick={() => void updateFinding(finding, 'open')}>Buka kembali</button>}
      </div>
    );
  };

  const reportHasPartialCoverage = Boolean(
    report && (
      report.state !== 'completed'
      || report.coverage.some((item) => ['blocked', 'error', 'inconclusive', 'not_tested', 'planned', 'skipped'].includes(item.state))
    ),
  );
  const coverageCounts: Record<string, number> = {};
  for (const item of report?.coverage ?? []) {
    coverageCounts[item.state] = (coverageCounts[item.state] ?? 0) + 1;
  }

  const assessmentPanel = findings.length > 0 ? (
    <section className="assessment-panel" aria-labelledby="assessment-heading">
      <h2 id="assessment-heading">Assessment bukti</h2>
      <p>Assessment membantu reviewer menilai bukti yang sudah ada. Hasilnya tidak menaikkan authority temuan dan bukan pengganti verifikasi manusia.</p>
      <div className="assessment-controls">
        <label htmlFor="assessment-provider">Metode penilaian
          <select id="assessment-provider" value={assessmentProvider} onChange={(event) => setAssessmentProvider(event.target.value as 'deterministic' | 'manual' | 'jev')}>
            <option value="deterministic">Deterministic lokal</option>
            <option value="manual">Manual reviewer</option>
            <option value="jev">Jev (memerlukan consent)</option>
          </select>
        </label>
        {assessmentProvider === 'jev' && assessmentConsentPreview && <div className="assessment-consent">
          <p>Jev akan menerima data tersamarkan ke <code>{assessmentConsentPreview.domain}</code>: {assessmentConsentPreview.data_classes.join(', ')}.</p>
          <label><input type="checkbox" checked={assessmentConsent || assessmentConsentPreview.granted} disabled={busy || assessmentConsentPreview.granted} onChange={(event) => { if (event.target.checked) void grantAssessmentConsent(); }} /> {assessmentConsentPreview.granted ? 'Consent tersimpan untuk hash konfigurasi ini.' : 'Saya menyetujui dan menyimpan consent untuk konfigurasi ini.'}</label>
          {assessmentConsentPreview.granted && <button type="button" disabled={busy} onClick={() => void revokeAssessmentConsent()}>Cabut consent hosted</button>}
        </div>}
      </div>
      {assessmentHistoryBusy && <p role="status">Memuat riwayat assessment…</p>}
      {assessmentNextOffset !== null && <button type="button" disabled={assessmentHistoryBusy || busy} onClick={() => report && void loadAssessmentHistory(report.run_id, true)}>Muat riwayat assessment berikutnya</button>}
    </section>
  ) : null;

  return (
    <>
      <a className="skip" href="#main">Lewati ke hasil</a>
      <header>
        <a href="/" className="brand">plenger<span>Analisis lokal</span></a>
        <span className="badge">Pengembangan · cakupan terbatas</span>
        {session && <button onClick={logout}>Tutup sesi</button>}
      </header>
      <main id="main">
        <p className="eyebrow">Repository security / offline core</p>
        <h1>Telusuri kode. Tinjau buktinya.</h1>
        <p className="intro">Temuan statis adalah titik awal peninjauan. Pengujian aktif hanya berjalan melalui fixed-suite yang disetujui eksplisit, pada target local atau staging HTTPS.</p>
        <p role="status" aria-live="polite">{message}</p>
        {error && <p className="error" role="alert">{error}</p>}
        {!session ? (
          <section className="pair">
            <h2>Pasangkan browser</h2>
            <p>Masukkan kode dari terminal. Kode berlaku 60 detik dan hanya dapat digunakan sekali.</p>
            <form onSubmit={pair}>
              <label htmlFor="code">Kode pairing</label>
              <input id="code" name="code" type="password" autoComplete="one-time-code" required value={code} onChange={(event) => setCode(event.target.value)} />
              <button disabled={busy} type="submit">{busy ? 'Memasangkan…' : 'Pasangkan browser'}</button>
            </form>
          </section>
        ) : (
          <>
            <div className="toolbar">
              <h2>Hasil analisis</h2>
              <button disabled={busy || !!staticRun || !!activePlanRun} onClick={startScan}>{staticRun ? 'Scan berjalan…' : 'Jalankan scan statis'}</button>
              <button disabled={busy} onClick={() => { void refresh(session.project_id, selectedRunId ?? undefined); void loadHistory(session.project_id); }}>Muat ulang</button>
              {report && <button onClick={download}>Unduh JSON</button>}
            </div>
            <label className="fixture-choice"><input type="checkbox" checked={fixture} onChange={(event) => setFixture(event.target.checked)} disabled={!!staticRun || !!activePlanRun} /> Proyek ini adalah fixture sintetis</label>
            <section className="history-panel" aria-labelledby="history-heading">
              <h2 id="history-heading">Riwayat pemeriksaan</h2>
              <p>Pilih hasil lama untuk ditinjau atau bandingkan dengan run yang sedang dibuka.</p>
              <div className="history-grid">
                <label htmlFor="history-run">Hasil yang dibuka<select id="history-run" value={selectedRunId ?? ''} onChange={(event) => void selectRun(event.target.value)} disabled={historyBusy || runs.length === 0}><option value="">Belum ada hasil</option>{runs.map((run) => <option key={run.id} value={run.id}>{new Date(run.created_at).toLocaleString('id-ID')} · {run.profile} · {run.state}</option>)}</select></label>
                <label htmlFor="history-base">Bandingkan dengan<select id="history-base" value={baseRunId} onChange={(event) => { setBaseRunId(event.target.value); setDiff(null); }} disabled={historyBusy || runs.length < 2}><option value="">Pilih basis pembanding</option>{runs.filter((run) => run.id !== selectedRunId).map((run) => <option key={run.id} value={run.id}>{new Date(run.created_at).toLocaleString('id-ID')} · {run.state}</option>)}</select></label>
                <button disabled={historyBusy || !baseRunId || !selectedRunId || baseRunId === selectedRunId} onClick={() => void compareRuns()}>Bandingkan run</button>
              </div>
              {historyBusy && <p role="status">Memuat riwayat…</p>}
              {!historyBusy && runs.length === 0 && <p>Belum ada pemeriksaan. Jalankan scan statis untuk membuat hasil pertama.</p>}
              {historyNextOffset !== null && <button type="button" disabled={historyBusy || busy} onClick={() => void loadHistory(session.project_id, true)}>Muat riwayat berikutnya</button>}
              {diff && <div className="diff-result" aria-live="polite"><h3>Hasil perbandingan</h3>{!diff.comparable ? <p>Run tidak comparable: {diff.reason}.</p> : diff.items.length === 0 ? <p>Tidak ada perubahan temuan pada dua run ini.</p> : <ul>{diff.items.map((item) => <li key={`${item.status}-${item.fingerprint}`}><span className={`diff-${item.status}`}>{item.status}</span><code>{item.fingerprint}</code></li>)}</ul>}</div>}
            </section>
            <section className="active-panel">
              <h2>Pengujian aktif berizin</h2>
              <p>Hanya target local loopback HTTP atau staging HTTPS dengan path/method eksplisit dan kasus fixed suite yang dipilih. Tidak ada target production atau discovery otomatis.</p>
              <div className="active-grid">
                <label>Lingkungan<select value={activeEnvironment} onChange={(event) => setActiveEnvironment(event.target.value as 'local' | 'staging')} disabled={!!activePlan || !!activePlanRun}><option value="local">Local loopback</option><option value="staging">Staging HTTPS</option></select></label>
                <label>Base URL target<input value={activeBaseUrl} onChange={(event) => setActiveBaseUrl(event.target.value)} disabled={!!activePlan || !!activePlanRun} /></label>
                <label>Path yang diizinkan<input value={activePath} onChange={(event) => setActivePath(event.target.value)} disabled={!!activePlan || !!activePlanRun} /></label>
                <label>Case IDs<input value={activeCases} onChange={(event) => setActiveCases(event.target.value)} disabled={!!activePlan || !!activePlanRun} /></label>
              </div>
              <label className="active-cost-ack"><input type="checkbox" checked={activeCostAcknowledged} onChange={(event) => setActiveCostAcknowledged(event.target.checked)} disabled={!!activePlanRun || !!activePlan} /> Saya memahami biaya internal target tidak dapat diukur oleh plenger; gunakan request-only guard dan tampilkan biaya sebagai unknown.</label>
              <div className="active-actions"><button disabled={busy || !!activePlanRun || !!activePlan || !report || !activeCostAcknowledged} onClick={createActivePlan}>Buat plan</button>{activePlan && <><span className="mono">Plan {activePlan.plan_digest}</span><button disabled={busy || !!activeApproval || !activeAcknowledged} onClick={approveActivePlan}>Setujui scope sekali pakai</button><button disabled={busy || !!activePlanRun} onClick={revokeActivePlan}>Cabut plan aktif</button></>}{activeApproval && <button disabled={busy || !!activePlanRun} onClick={startActivePlan}>Jalankan fixed suite</button>}{activePlanRun && <button onClick={cancelActivePlan}>Cancel run</button>}</div>
              {activePlan?.preview && <div className="active-preview" aria-labelledby="active-plan-preview-title">
                <h3 id="active-plan-preview-title">Scope untuk persetujuan</h3>
                <dl className="plan-details">
                  <div><dt>Project</dt><dd><code>{activePlan.preview.project_id}</code></dd></div>
                  <div><dt>Digest plan</dt><dd><code>{activePlan.plan_digest}</code></dd></div>
                  <div><dt>Digest scope</dt><dd><code>{activePlan.scope_digest}</code></dd></div>
                  <div><dt>Target</dt><dd>{activePlan.preview.target_ref} · {activePlan.preview.environment} · {activePlan.preview.base_origin}</dd></div>
                  <div><dt>Revision target</dt><dd><code>{activePlan.preview.target_revision}</code></dd></div>
                  <div><dt>Alamat target yang diizinkan</dt><dd>{activePlan.preview.allowed_ips.join(', ') || 'Tidak ada'}</dd></div>
                  <div><dt>Path dan method</dt><dd><ul>{activePlan.preview.allowed_paths.map((path) => <li key={path}><code>{activePlan.preview?.allowed_methods.join(', ')}</code> {path}</li>)}</ul></dd></div>
                  <div><dt>Profil autentikasi</dt><dd>{activePlan.preview.auth_profile_ref ?? 'Tidak ada'}</dd></div>
                  <div><dt>Respons target</dt><dd>Maksimum {activePlan.preview.max_response_bytes} byte · observability {activePlan.preview.observability} · output <code>{activePlan.preview.output_path}</code> · trace <code>{activePlan.preview.trace_path ?? 'Tidak ada'}</code></dd></div>
                  <div><dt>Profil dan suite</dt><dd><code>{activePlan.preview.profile}</code><br />Digest profil <code>{activePlan.preview.profile_digest}</code><br />{activePlan.preview.case_count} case terpilih<ul>{activePlan.preview.case_ids.map((caseId) => <li key={caseId}><code>{caseId}</code></li>)}</ul></dd></div>
                  <div><dt>Digest rubric</dt><dd><code>{activePlan.preview.rubric_hash}</code></dd></div>
                  <div><dt>Snapshot kode</dt><dd><code>{activePlan.preview.snapshot_digest}</code></dd></div>
                  <div><dt>Identitas autentikasi target</dt><dd>{activePlan.preview.auth_identity}</dd></div>
                  <div><dt>Kelas data</dt><dd>{activePlan.preview.data_classes.join(', ') || 'Tidak ada'}</dd></div>
                  <div><dt>Budget</dt><dd><ul>
                    <li>Maksimum {activePlan.preview.budget.max_cases} case dan {activePlan.preview.budget.max_attempts} attempt</li>
                    <li>Concurrency {activePlan.preview.budget.concurrency}</li>
                    <li>Batas waktu request {activePlan.preview.budget.request_timeout_seconds} detik</li>
                    <li>Batas durasi {activePlan.preview.budget.wall_time_seconds} detik</li>
                    <li>Guard biaya {activePlan.preview.budget.cost_guard}{activePlan.preview.budget.cost_guard === 'request_only' ? ' · biaya target unknown' : ''} · acknowledgment {activePlan.preview.budget.cost_acknowledged ? 'diberikan' : 'tidak diberikan'}</li>
                  </ul></dd></div>
                  <div><dt>Persetujuan</dt><dd>{ACTIVE_APPROVAL_ACTOR} · berlaku {ACTIVE_APPROVAL_TTL_MINUTES} menit · sekali pakai</dd></div>
                </dl>
                <label className="active-approval-ack"><input type="checkbox" checked={activeAcknowledged} onChange={(event) => setActiveAcknowledged(event.target.checked)} disabled={!!activeApproval} /> Saya sudah meninjau digest rubric, target dan IP, path/method, revision, case, snapshot, identitas, kelas data, budget, serta masa berlaku persetujuan.</label>
              </div>}
              {activeRunState && <p role="status">Status active run: <strong>{activeRunState}</strong></p>}
            </section>
            {!report ? (
              <section><h3>Belum ada scan</h3><p>Pilih Jalankan scan statis atau gunakan perintah berikut pada direktori proyek.</p><code>plenger scan --project . --profile deterministic</code></section>
            ) : (
              <>
                {report.fixture && <p className="fixture">Fixture sintetis · hasil ini berasal dari kode demonstrasi.</p>}
                <section className="summary"><div><span>Kandidat untuk ditinjau</span><strong>{report.counts?.findings ?? report.findings.length}</strong></div><div><span>Komponen dipetakan</span><strong>{report.counts?.nodes ?? report.nodes.length}</strong></div><div><span>Kandidat prioritas</span><strong>{report.counts?.priority_findings ?? '—'}</strong><span>severity high / critical</span></div><div><span>Status run</span><strong className="small">{report.state}</strong><span>{new Date(report.created_at).toLocaleString('id-ID')}</span></div></section>
                <section><h2>Batas pemeriksaan</h2><p>Profil: {report.profile}. {report.active ? 'Coverage fixed suite ditampilkan berdasarkan kasus yang dipilih.' : 'OWASP belum diuji pada scan statis.'} Hasil ini bukan sertifikasi keamanan.</p><p role="status">Panggilan hosted: {assessmentConsentPreview === null ? 'status belum dimuat.' : assessmentConsentPreview.granted ? 'consent tersimpan; data hanya dikirim saat Anda menjalankan Jev.' : 'tidak aktif; tidak ada pengiriman otomatis.'}</p>{reportHasPartialCoverage && <p className="partial-notice" role="status">Hasil ini parsial atau memiliki kasus yang belum teruji. Temuan yang tidak terlihat pada run ini tidak otomatis terselesaikan.</p>}{report.snapshot && <p>Snapshot <code>{report.snapshot.manifest_digest ?? 'tidak tersedia'}</code> · Commit Git <code>{report.snapshot.commit ?? 'tidak tersedia'}</code> · Working tree {snapshotWorkingTreeLabel(report.snapshot.dirty)}.</p>}<ul>{report.limitations.map((item) => <li key={item}>{item}</li>)}</ul><h3>Status coverage</h3><dl className="coverage-summary" aria-label="Ringkasan status coverage">{COVERAGE_STATES.map(({value, label}) => <div key={value}><dt>{label}</dt><dd>{coverageCounts[value] ?? 0}</dd></div>)}</dl><p className="coverage-note">Jumlah ini menunjukkan kategori pada setiap status, bukan skor keamanan atau persentase coverage.</p><div className="coverage">{report.coverage.map((coverage) => <span key={coverage.category}>{coverage.category} · {coverage.state}</span>)}</div></section>
                {report.active && <section><h2>Hasil fixed suite</h2><p>Profil: <code>{report.profile}</code>{report.profile_digest && <> · digest <code>{report.profile_digest}</code></>}{report.rubric_hash && <> · rubric <code>{report.rubric_hash}</code></>}</p><p>Kasus yang dipilih: <strong>{report.case_count ?? report.test_results?.length ?? 0}</strong>. Hasil yang tercatat: <strong>{report.test_results?.length ?? 0}</strong>. Angka ini adalah denominator suite, bukan skor keamanan.</p>{report.case_ids && <p>Case IDs yang disetujui: {report.case_ids.map((caseId) => <code key={caseId}>{caseId} </code>)}</p>}<p role="status">Akuntansi target: {report.accounting?.cost_status === 'unknown' ? 'unknown (request-only)' : report.accounting?.cost ?? 'tidak tersedia'} · reserved attempts {report.accounting?.reserved_attempts ?? 0}</p>{report.test_results?.length ? <ul className="test-results">{report.test_results.map((item) => <li key={item.case_id}><strong>{item.case_id}</strong><span className={`result-${item.result}`}>{item.result}</span><small>{item.reason_code}{item.http_status ? ` · HTTP ${item.http_status}` : ''}</small>{item.evidence.length > 0 && <small className="test-evidence">Bukti: {item.evidence.join(' · ')}</small>}</li>)}</ul> : <p>Run aktif selesai tanpa hasil kasus tersimpan.</p>}</section>}
                {report.view_truncated && <p>Overview dibatasi 100 item per daftar. Temuan, peta, dan riwayat assessment dimuat dari endpoint terpaginasikan; unduh JSON untuk laporan lengkap.</p>}
                {assessmentPanel}
                <section className="findings-panel"><h2>Temuan &amp; bukti</h2><div className="findings-toolbar"><label htmlFor="finding-severity">Severity<select id="finding-severity" value={findingSeverity} onChange={(event) => setFindingSeverity(event.target.value)}><option value="">Semua severity</option><option value="critical">critical</option><option value="high">high</option><option value="medium">medium</option><option value="low">low</option><option value="info">info</option><option value="unknown">unknown</option></select></label><label htmlFor="finding-validation">Validasi<select id="finding-validation" value={findingValidation} onChange={(event) => setFindingValidation(event.target.value)}><option value="">Semua status</option><option value="candidate">candidate</option><option value="supported">supported</option><option value="confirmed">confirmed</option><option value="disputed">disputed</option></select></label><label htmlFor="finding-lifecycle">Workflow<select id="finding-lifecycle" value={findingLifecycle} onChange={(event) => setFindingLifecycle(event.target.value)}><option value="">Semua lifecycle</option><option value="open">open</option><option value="acknowledged">acknowledged</option><option value="suppressed">suppressed</option><option value="resolved">resolved</option></select></label><label htmlFor="finding-kind">Jenis<input id="finding-kind" list="finding-kind-options" value={findingKind} onChange={(event) => setFindingKind(event.target.value)} placeholder="contoh: code atau dynamic_code_execution" /></label><datalist id="finding-kind-options"><option value="code" /><option value="dependency" /><option value="secret" /><option value="mixed" /><option value="dynamic_code_execution" /></datalist><label htmlFor="finding-source-path">Path<input id="finding-source-path" value={findingSourcePath} onChange={(event) => setFindingSourcePath(event.target.value)} placeholder="src/..." /></label><button disabled={findingsBusy || busy} onClick={() => void loadFindings(session!.project_id, report.run_id, false, report.findings)}>Terapkan filter</button>{findingsCursor && <button disabled={findingsBusy || busy} onClick={() => void loadFindings(session!.project_id, report.run_id, true)}>Muat temuan berikutnya</button>}{findingsBusy && <span role="status">Memuat temuan…</span>}</div>{!findings.length ? <p>{findingSeverity || findingValidation || findingLifecycle || findingKind || findingSourcePath.trim() ? 'Tidak ada temuan untuk filter ini.' : 'Tidak ada kandidat pada pola yang diperiksa. Bagian lain belum dinilai.'}</p> : findings.map((finding) => { const assessments = assessmentHistory.filter((item) => item.finding_id === finding.id); return <article key={finding.id}><div className="finding-top"><span className="badge">{finding.severity} · {finding.validation_state}{finding.kind ? ` · ${finding.kind}` : ''}</span><code>{finding.source_ref.path}:{finding.source_ref.line}</code></div><h3>{finding.title}</h3><p className="finding-state">Status workflow: <strong>{finding.lifecycle_state ?? 'open'}</strong>. Status ini bukan bukti bahwa aplikasi sudah aman.</p>{finding.suppression && <p className="finding-state">Disembunyikan sampai {new Date(finding.suppression.expires_at).toLocaleDateString('id-ID')}: {finding.suppression.reason}</p>}{finding.suppression_state === 'expired' && <p className="finding-state">Suppression sebelumnya sudah kedaluwarsa; temuan kembali terlihat untuk review.</p>}{finding.evidence_expired && <p className="error">Bukti sudah kedaluwarsa dan tidak dapat diverifikasi ulang dari penyimpanan lokal.</p>}{lifecycleActions(finding)}<div className="finding-actions"><button disabled={busy || (assessmentProvider === 'jev' && !(assessmentConsent || Boolean(assessmentConsentPreview?.granted)))} onClick={() => void assessFinding(finding)}>{assessingFinding === finding.id ? 'Menilai…' : 'Nilai bukti'}</button></div>{assessments.length > 0 && <div className="assessment-results"><h4>Riwayat assessment</h4>{assessments.map((assessment) => <div className="assessment-result" key={assessment.id}><strong>{assessment.evaluator} · {assessment.state}{assessment.cached ? ' · cache' : ''}</strong><span>{assessment.reason_code}</span>{assessment.cached && <span>Hasil ini berasal dari assessment tersimpan; bukan penilaian baru.</span>}{assessment.resolved_model && <span>Model: {assessment.resolved_model}</span>}{assessment.answers && Object.keys(assessment.answers).length > 0 && <pre>{JSON.stringify(assessment.answers, null, 2)}</pre>}</div>)}</div>}<details><summary>Lihat bukti statis</summary>{finding.evidence_integrity !== 'verified' && <p className="error">Integritas bukti: {finding.evidence_integrity ?? 'belum diperiksa'}. Hasil ini perlu diperiksa ulang.</p>}<p>{finding.evidence.observed}</p><dl><dt>Sumber</dt><dd>{finding.evidence.source}</dd><dt>Digest bukti tersamarkan</dt><dd className="mono">{finding.evidence.sha256_redacted}</dd><dt>Retensi sampai</dt><dd>{finding.evidence.retention_until ?? 'Tidak ditentukan'}</dd></dl>{finding.evidence_refs?.filter((evidence) => evidence.id !== finding.evidence.id).map((evidence, index) => <div className="evidence-extra" key={evidence.id}><h4>Bukti tambahan {index + 1}</h4><p>{evidence.observed}</p><dl><dt>Sumber</dt><dd>{evidence.source}</dd><dt>Digest bukti tersamarkan</dt><dd className="mono">{evidence.sha256_redacted}</dd></dl></div>)}</details></article>; })}</section>
                <section className="graph-panel" aria-labelledby="graph-heading">
                  <h2 id="graph-heading">Peta definisi</h2>
                  <p>Relasi berikut diamati dari struktur kode; bukan bukti eksekusi runtime.</p>
                  <div className="graph-filters">
                    <label htmlFor="graph-kind">Jenis komponen<select id="graph-kind" value={graphKind} onChange={(event) => setGraphKind(event.target.value)}><option value="">Semua jenis</option><option value="file">file</option><option value="symbol">symbol</option><option value="endpoint">endpoint</option><option value="agent">agent</option><option value="tool">tool</option><option value="llm_call">llm_call</option><option value="retriever">retriever</option><option value="store">store</option></select></label>
                    <label htmlFor="graph-source-path">Path sumber<input id="graph-source-path" value={graphSourcePath} onChange={(event) => setGraphSourcePath(event.target.value)} placeholder="src/..." /></label>
                    <button type="button" disabled={graphBusy || busy} onClick={() => void loadGraph(session!.project_id, report.run_id)}>Terapkan filter peta</button>
                  </div>
                  {graphBusy && <p role="status">Memuat peta…</p>}
                  {!graphBusy && graph.nodes.length === 0 && graph.edges.length === 0 && <p>Belum ada relasi definisi pada input yang didukung.</p>}
                  {graph.nodes.length > 0 && <p className="graph-count">Komponen pada halaman ini: {graph.nodes.length}</p>}
                  {graph.nodes.length > 0 && <><h3>Komponen</h3><ul className="graph graph-nodes">{graph.nodes.map((node) => <li key={node.id}><code>{node.label}</code><span>{node.kind}{node.provenance ? ` · ${node.provenance}` : ''} · {node.source_ref.path}:{node.source_ref.line}</span></li>)}</ul></>}
                  {graph.edges.length > 0 && <><h3>Relasi</h3><ul className="graph graph-edges">{graph.edges.map((edge) => <li key={edge.id}><button type="button" className="graph-edge" aria-pressed={selectedGraphEdgeId === edge.id} onClick={() => setSelectedGraphEdgeId((current) => current === edge.id ? null : edge.id)}><code>{label.get(edge.source) ?? edge.source}</code><span> → {edge.kind}{edge.provenance ? ` · ${edge.provenance}` : ''}{edge.source_ref ? ` · ${edge.source_ref.path}:${edge.source_ref.line}` : ''} → </span><code>{label.get(edge.target) ?? edge.target}</code></button></li>)}</ul></>}
                  {selectedGraphEdge && <div className="graph-edge-details" role="region" aria-live="polite" aria-labelledby="selected-edge-heading"><h4 id="selected-edge-heading">Bukti relasi dipilih</h4><p>Relasi ini berasal dari analisis struktur kode, bukan observasi eksekusi runtime.</p><dl><dt>Dari</dt><dd>{label.get(selectedGraphEdge.source) ?? selectedGraphEdge.source}</dd><dt>Ke</dt><dd>{label.get(selectedGraphEdge.target) ?? selectedGraphEdge.target}</dd><dt>Jenis relasi</dt><dd>{selectedGraphEdge.kind}</dd><dt>Provenance</dt><dd>{selectedGraphEdge.provenance ?? 'tidak tersedia'}</dd><dt>Lokasi sumber</dt><dd>{selectedGraphEdge.source_ref ? `${selectedGraphEdge.source_ref.path}:${selectedGraphEdge.source_ref.line}` : 'tidak tersedia'}</dd></dl></div>}
                  {graph.nodes.length > 0 && graph.edges.length === 0 && <p>Halaman ini belum memuat relasi antar-komponen.</p>}
                  {graph.next_offset !== null && <button disabled={graphBusy || busy} onClick={() => void loadGraph(session!.project_id, report.run_id, true)}>Muat peta berikutnya</button>}
                </section>
                <section><h2>Kemampuan engine</h2><ul className="engines">{Object.entries(report.engine_states).map(([name, state]) => <li key={name}><strong>{name}</strong><span>{engineStateSummary(name, state)}</span></li>)}</ul></section>
                <footer>Run <code>{report.run_id}</code><br />Snapshot <code>{report.snapshot_id}</code></footer>
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
