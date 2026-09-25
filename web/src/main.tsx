import {useEffect, useRef, useState, type FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {Button} from '@base-ui/react/button';
import {Checkbox} from '@base-ui/react/checkbox';
import {engineStateSummary, snapshotWorkingTreeLabel, type EngineState} from './view-utils';
import {request} from './api';
import {
  ActiveSuiteResults,
  CoverageOverview,
  DiffView,
  GraphEdgeDetails,
  ReportSummary,
} from './components/report';
import type {
  Ref,
  Node,
  GraphEdge,
  GraphPage,
  Evidence,
  Lifecycle,
  Finding,
  TestResult,
  Assessment,
  Snapshot,
  Report,
  RunSummary,
  RunHistoryPage,
  BudgetPreview,
  DiffItem,
  DiffResult,
  Plan,
  Approval,
  AssessmentConsentPreview,
} from './types';
import './style.css';

const EMPTY_GRAPH: GraphPage = {snapshot_id: null, nodes: [], edges: [], next_offset: null};
const ACTIVE_APPROVAL_ACTOR = 'browser-user';
const ACTIVE_APPROVAL_TTL_MINUTES = 5;

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
  const [assessmentProvider, setAssessmentProvider] = useState<'deterministic' | 'manual' | 'jev'>(
    'deterministic',
  );
  const [assessmentConsent, setAssessmentConsent] = useState(false);
  const [assessmentConsentPreview, setAssessmentConsentPreview] =
    useState<AssessmentConsentPreview | null>(null);
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

  async function loadHistory(id: string, append = false, generation = sessionGeneration.current) {
    if (generation !== sessionGeneration.current) return;
    setHistoryBusy(true);
    try {
      const offset = append ? (historyNextOffset ?? 0) : 0;
      const data = await request<RunHistoryPage>(`projects/${id}/runs?limit=50&offset=${offset}`);
      if (generation !== sessionGeneration.current) return;
      setRuns((current) => (append ? [...current, ...data.items] : data.items));
      setHistoryNextOffset(typeof data.next_offset === 'number' ? data.next_offset : null);
      if (!append) {
        const pendingStatic = data.items.find(
          (run) =>
            !run.plan_id &&
            run.profile === 'deterministic' &&
            ['queued', 'running'].includes(run.state),
        );
        const pendingActive = data.items.find(
          (run) => Boolean(run.plan_id) && ['queued', 'running', 'cancelling'].includes(run.state),
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
      const offset = append ? (assessmentNextOffset ?? 0) : 0;
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
        findingSeverity ||
          findingValidation ||
          findingLifecycle ||
          findingKind ||
          findingSourcePath.trim(),
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
      const offset = append ? (graph.next_offset ?? 0) : 0;
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
        page.nodes.length > 0 ||
        page.edges.length > 0 ||
        graphKind ||
        graphSourcePath.trim() ||
        (fallbackNodes.length === 0 && fallbackEdges.length === 0)
      ) {
        setGraph(page);
        setSelectedGraphEdgeId(null);
      } else {
        setGraph({
          snapshot_id: fallbackSnapshotId,
          nodes: fallbackNodes,
          edges: fallbackEdges,
          next_offset: null,
        });
        setSelectedGraphEdgeId(null);
      }
    } catch (exception) {
      if (canApplyRefresh(generation, runId) && !append) {
        setGraph({
          snapshot_id: fallbackSnapshotId,
          nodes: fallbackNodes,
          edges: fallbackEdges,
          next_offset: null,
        });
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
          loadFindings(
            id,
            data.report.run_id,
            false,
            data.report.findings as Finding[],
            generation,
          ),
          loadGraph(
            id,
            data.report.run_id,
            false,
            data.report.nodes as Node[],
            data.report.edges as GraphEdge[],
            data.report.snapshot_id,
            generation,
          ),
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
          setMessage(
            run.state === 'queued' ? 'Scan masuk antrean…' : 'Memeriksa kode dalam sandbox…',
          );
          return;
        }
        setStaticRun(null);
        if (['completed', 'completed_with_errors'].includes(run.state)) {
          await refresh(session.project_id);
          if (canApplySession(generation)) await loadHistory(session.project_id, false, generation);
        } else {
          setError(
            `Scan ${run.state}. Periksa kesiapan sandbox dan konfigurasi melalui plenger doctor.`,
          );
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
            run.state === 'queued'
              ? 'Pengujian aktif masuk antrean…'
              : `Pengujian aktif: ${run.state}…`,
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
      setError(
        'Akui dahulu bahwa biaya target internal tidak tersedia; plan akan memakai request-only guard.',
      );
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
          case_ids: activeCases
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
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
          // Consent is granted through the dedicated acknowledged endpoint only.
          consent: false,
          data_classes: assessmentConsentPreview?.data_classes ?? [
            'metadata',
            'code_excerpt',
            'response',
          ],
        }),
      });
      await refresh(session.project_id, report.run_id);
      if (!canApplySession(generation)) return;
      setMessage(
        'Hasil assessment disimpan untuk ditinjau. Assessment tidak mengubah status authority temuan.',
      );
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
      setAssessmentConsentPreview((current) => (current ? {...current, granted: true} : current));
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
      setAssessmentConsentPreview((current) => (current ? {...current, granted: false} : current));
      setMessage(
        'Consent hosted dicabut. Assessment Jev berikutnya akan meminta persetujuan lagi.',
      );
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
        {state === 'open' && (
          <Button disabled={busy} onClick={() => void updateFinding(finding, 'acknowledged')}>
            Tandai sudah ditinjau
          </Button>
        )}
        {state !== 'suppressed' && state !== 'resolved' && (
          <Button disabled={busy} onClick={() => void updateFinding(finding, 'suppressed')}>
            Sembunyikan sementara
          </Button>
        )}
        {state !== 'resolved' && (
          <Button disabled={busy} onClick={() => void updateFinding(finding, 'resolved')}>
            Tandai terselesaikan
          </Button>
        )}
        {(state === 'resolved' || state === 'suppressed') && (
          <Button disabled={busy} onClick={() => void updateFinding(finding, 'open')}>
            Buka kembali
          </Button>
        )}
      </div>
    );
  };

  const reportHasPartialCoverage = Boolean(
    report &&
      (report.state !== 'completed' ||
        report.coverage.some((item) =>
          ['blocked', 'error', 'inconclusive', 'not_tested', 'planned', 'skipped'].includes(
            item.state,
          ),
        )),
  );

  const assessmentPanel =
    findings.length > 0 ? (
      <section className="assessment-panel" aria-labelledby="assessment-heading">
        <h2 id="assessment-heading">Assessment bukti</h2>
        <p>
          Assessment membantu reviewer menilai bukti yang sudah ada. Hasilnya tidak menaikkan
          authority temuan dan bukan pengganti verifikasi manusia.
        </p>
        <div className="assessment-controls">
          <label htmlFor="assessment-provider">
            Metode penilaian
            <select
              id="assessment-provider"
              value={assessmentProvider}
              onChange={(event) =>
                setAssessmentProvider(event.target.value as 'deterministic' | 'manual' | 'jev')
              }
            >
              <option value="deterministic">Deterministic lokal</option>
              <option value="manual">Manual reviewer</option>
              <option value="jev">Jev (memerlukan consent)</option>
            </select>
          </label>
          {assessmentProvider === 'jev' && assessmentConsentPreview && (
            <div className="assessment-consent">
              <p>
                Jev akan menerima data tersamarkan ke <code>{assessmentConsentPreview.domain}</code>
                : {assessmentConsentPreview.data_classes.join(', ')}.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={assessmentConsent || assessmentConsentPreview.granted}
                  disabled={busy || assessmentConsentPreview.granted}
                  onChange={(event) => {
                    if (event.target.checked) void grantAssessmentConsent();
                  }}
                />{' '}
                {assessmentConsentPreview.granted
                  ? 'Consent tersimpan untuk hash konfigurasi ini.'
                  : 'Saya menyetujui dan menyimpan consent untuk konfigurasi ini.'}
              </label>
              {assessmentConsentPreview.granted && (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void revokeAssessmentConsent()}
                >
                  Cabut consent hosted
                </Button>
              )}
            </div>
          )}
        </div>
        {assessmentHistoryBusy && <p role="status">Memuat riwayat assessment…</p>}
        <p role="status" className="status-region">
          {!assessmentHistoryBusy && assessmentHistory.length === 0
            ? 'Belum ada hasil assessment. Pilih “Nilai bukti” pada temuan untuk memulai.'
            : ''}
        </p>
        {assessmentNextOffset !== null && (
          <Button
            type="button"
            disabled={assessmentHistoryBusy || busy}
            onClick={() => report && void loadAssessmentHistory(report.run_id, true)}
          >
            Muat riwayat assessment berikutnya
          </Button>
        )}
      </section>
    ) : null;

  return (
    <>
      <a className="skip" href="#main">
        Lewati ke hasil
      </a>
      <header className="app-header">
        <div className="header-inner">
          <a href="/" className="brand">
            <span className="brand-mark" aria-hidden="true">
              ✳
            </span>
            <span className="brand-name">
              plenger<small>Analisis lokal</small>
            </span>
          </a>
          {session && (
            <nav className="page-nav" aria-label="Navigasi dashboard">
              <a href="#overview">Ringkasan</a>
              <a href="#findings">Temuan</a>
              <a href="#graph-heading">Peta kode</a>
              <a href="#history-heading">Riwayat</a>
              <a href="#active-heading">Pengujian aktif</a>
            </nav>
          )}
          <span className="release-badge">Pratinjau</span>
          {session && (
            <Button className="button-subtle" onClick={logout}>
              Tutup sesi
            </Button>
          )}
        </div>
      </header>
      <main id="main">
        <div className="hero">
          <p className="eyebrow">
            KEAMANAN REPOSITORI <span aria-hidden="true">/</span> DI PERANGKATMU
          </p>
          <h1>
            Telusuri kode.
            <br />
            <span>Tinjau buktinya.</span>
          </h1>
          <p className="intro">
            Lihat apa yang ditemukan, dari mana asalnya, dan bagian mana yang belum diperiksa. Mulai
            dari hasil statis, lalu pilih pengujian aktif saat diperlukan.
          </p>
        </div>
        <p className="live-status" role="status" aria-live="polite">
          {message}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!session ? (
          <section className="pair">
            <h2>Pasangkan browser</h2>
            <p>
              Masukkan kode dari terminal. Kode berlaku 60 detik dan hanya dapat digunakan sekali.
            </p>
            <form onSubmit={pair}>
              <label htmlFor="code">Kode pairing</label>
              <input
                id="code"
                name="code"
                type="password"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button disabled={busy} type="submit">
                {busy ? 'Memasangkan…' : 'Pasangkan browser'}
              </Button>
            </form>
          </section>
        ) : (
          <>
            <div className="toolbar" id="overview">
              <h2>Hasil analisis</h2>
              <Button
                className="button-primary"
                disabled={busy || !!staticRun || !!activePlanRun}
                onClick={startScan}
              >
                {staticRun ? 'Scan berjalan…' : 'Jalankan scan statis'}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  void refresh(session.project_id, selectedRunId ?? undefined);
                  void loadHistory(session.project_id);
                }}
              >
                Muat ulang
              </Button>
              {report && <Button onClick={download}>Unduh JSON</Button>}
            </div>
            <label className="fixture-choice">
              <Checkbox.Root
                className="ui-checkbox"
                checked={fixture}
                onCheckedChange={setFixture}
                disabled={!!staticRun || !!activePlanRun}
              >
                <Checkbox.Indicator>✓</Checkbox.Indicator>
              </Checkbox.Root>{' '}
              Proyek ini adalah fixture sintetis
            </label>
            {!report ? (
              <section>
                <h3>Belum ada scan</h3>
                <p>
                  Pilih Jalankan scan statis atau gunakan perintah berikut pada direktori proyek.
                </p>
                <code>plenger scan --project . --profile deterministic</code>
              </section>
            ) : (
              <>
                {report.fixture && (
                  <p className="fixture">
                    Fixture sintetis · hasil ini berasal dari kode demonstrasi.
                  </p>
                )}
                <ReportSummary report={report} />
                {report.active && <ActiveSuiteResults report={report} />}
                {report.view_truncated && (
                  <p>
                    Overview dibatasi 100 item per daftar. Temuan, peta, dan riwayat assessment
                    dimuat dari endpoint terpaginasikan; unduh JSON untuk laporan lengkap.
                  </p>
                )}
                <section className="findings-panel" id="findings">
                  <h2>Temuan &amp; bukti</h2>
                  <div className="findings-toolbar">
                    <label htmlFor="finding-severity">
                      Severity
                      <select
                        id="finding-severity"
                        value={findingSeverity}
                        onChange={(event) => setFindingSeverity(event.target.value)}
                      >
                        <option value="">Semua severity</option>
                        <option value="critical">critical</option>
                        <option value="high">high</option>
                        <option value="medium">medium</option>
                        <option value="low">low</option>
                        <option value="info">info</option>
                        <option value="unknown">unknown</option>
                      </select>
                    </label>
                    <label htmlFor="finding-validation">
                      Validasi
                      <select
                        id="finding-validation"
                        value={findingValidation}
                        onChange={(event) => setFindingValidation(event.target.value)}
                      >
                        <option value="">Semua status</option>
                        <option value="candidate">candidate</option>
                        <option value="supported">supported</option>
                        <option value="confirmed">confirmed</option>
                        <option value="disputed">disputed</option>
                      </select>
                    </label>
                    <label htmlFor="finding-lifecycle">
                      Workflow
                      <select
                        id="finding-lifecycle"
                        value={findingLifecycle}
                        onChange={(event) => setFindingLifecycle(event.target.value)}
                      >
                        <option value="">Semua lifecycle</option>
                        <option value="open">open</option>
                        <option value="acknowledged">acknowledged</option>
                        <option value="suppressed">suppressed</option>
                        <option value="resolved">resolved</option>
                      </select>
                    </label>
                    <label htmlFor="finding-kind">
                      Jenis
                      <input
                        id="finding-kind"
                        list="finding-kind-options"
                        value={findingKind}
                        onChange={(event) => setFindingKind(event.target.value)}
                        placeholder="contoh: code atau dynamic_code_execution"
                      />
                    </label>
                    <datalist id="finding-kind-options">
                      <option value="code" />
                      <option value="dependency" />
                      <option value="secret" />
                      <option value="mixed" />
                      <option value="dynamic_code_execution" />
                    </datalist>
                    <label htmlFor="finding-source-path">
                      Path
                      <input
                        id="finding-source-path"
                        value={findingSourcePath}
                        onChange={(event) => setFindingSourcePath(event.target.value)}
                        placeholder="src/..."
                      />
                    </label>
                    <Button
                      disabled={findingsBusy || busy}
                      onClick={() =>
                        void loadFindings(
                          session!.project_id,
                          report.run_id,
                          false,
                          report.findings,
                        )
                      }
                    >
                      Terapkan filter
                    </Button>
                    {findingsCursor && (
                      <Button
                        disabled={findingsBusy || busy}
                        onClick={() => void loadFindings(session!.project_id, report.run_id, true)}
                      >
                        Muat temuan berikutnya
                      </Button>
                    )}
                    {findingsBusy && <span role="status">Memuat temuan…</span>}
                  </div>
                  <p role="status" className="status-region">
                    {!findingsBusy && !findings.length
                      ? findingSeverity ||
                        findingValidation ||
                        findingLifecycle ||
                        findingKind ||
                        findingSourcePath.trim()
                        ? 'Tidak ada temuan untuk filter ini. Ubah atau kosongkan filter.'
                        : 'Tidak ada kandidat pada pola yang diperiksa. Bagian lain belum dinilai.'
                      : ''}
                  </p>
                  {findings.map((finding) => {
                    const assessments = assessmentHistory.filter(
                      (item) => item.finding_id === finding.id,
                    );
                    return (
                      <article key={finding.id}>
                        <div className="finding-top">
                          <span className="badge" data-severity={finding.severity}>
                            {finding.severity} · {finding.validation_state}
                            {finding.kind ? ` · ${finding.kind}` : ''}
                          </span>
                          <code>
                            {finding.source_ref.path}:{finding.source_ref.line}
                          </code>
                        </div>
                        <h3>{finding.title}</h3>
                        <p className="finding-state">
                          Status workflow: <strong>{finding.lifecycle_state ?? 'open'}</strong>.
                          Status ini bukan bukti bahwa aplikasi sudah aman.
                        </p>
                        {finding.suppression && (
                          <p className="finding-state">
                            Disembunyikan sampai{' '}
                            {new Date(finding.suppression.expires_at).toLocaleDateString('id-ID')}:{' '}
                            {finding.suppression.reason}
                          </p>
                        )}
                        {finding.suppression_state === 'expired' && (
                          <p className="finding-state">
                            Suppression sebelumnya sudah kedaluwarsa; temuan kembali terlihat untuk
                            review.
                          </p>
                        )}
                        {finding.evidence_expired && (
                          <p className="error">
                            Bukti sudah kedaluwarsa dan tidak dapat diverifikasi ulang dari
                            penyimpanan lokal.
                          </p>
                        )}
                        {lifecycleActions(finding)}
                        <div className="finding-actions">
                          <Button
                            disabled={
                              busy ||
                              (assessmentProvider === 'jev' &&
                                !(assessmentConsent || Boolean(assessmentConsentPreview?.granted)))
                            }
                            onClick={() => void assessFinding(finding)}
                          >
                            {assessingFinding === finding.id ? 'Menilai…' : 'Nilai bukti'}
                          </Button>
                        </div>
                        {assessments.length > 0 && (
                          <div className="assessment-results">
                            <h4>Riwayat assessment</h4>
                            {assessments.map((assessment) => (
                              <div className="assessment-result" key={assessment.id}>
                                <strong>
                                  {assessment.evaluator} · {assessment.state}
                                  {assessment.cached ? ' · cache' : ''}
                                </strong>
                                <span>{assessment.reason_code}</span>
                                {assessment.cached && (
                                  <span>
                                    Hasil ini berasal dari assessment tersimpan; bukan penilaian
                                    baru.
                                  </span>
                                )}
                                {assessment.resolved_model && (
                                  <span>Model: {assessment.resolved_model}</span>
                                )}
                                {assessment.answers &&
                                  Object.keys(assessment.answers).length > 0 && (
                                    <pre>{JSON.stringify(assessment.answers, null, 2)}</pre>
                                  )}
                              </div>
                            ))}
                          </div>
                        )}
                        <details>
                          <summary>Lihat bukti statis</summary>
                          {finding.evidence_integrity !== 'verified' && (
                            <p className="error">
                              Integritas bukti: {finding.evidence_integrity ?? 'belum diperiksa'}.
                              Hasil ini perlu diperiksa ulang.
                            </p>
                          )}
                          <p>{finding.evidence.observed}</p>
                          <dl>
                            <dt>Sumber</dt>
                            <dd>{finding.evidence.source}</dd>
                            <dt>Digest bukti tersamarkan</dt>
                            <dd className="mono">{finding.evidence.sha256_redacted}</dd>
                            <dt>Retensi sampai</dt>
                            <dd>{finding.evidence.retention_until ?? 'Tidak ditentukan'}</dd>
                          </dl>
                          {finding.evidence_refs
                            ?.filter((evidence) => evidence.id !== finding.evidence.id)
                            .map((evidence, index) => (
                              <div className="evidence-extra" key={evidence.id}>
                                <h4>Bukti tambahan {index + 1}</h4>
                                <p>{evidence.observed}</p>
                                <dl>
                                  <dt>Sumber</dt>
                                  <dd>{evidence.source}</dd>
                                  <dt>Digest bukti tersamarkan</dt>
                                  <dd className="mono">{evidence.sha256_redacted}</dd>
                                </dl>
                              </div>
                            ))}
                        </details>
                      </article>
                    );
                  })}
                </section>
                {assessmentPanel}
                <section>
                  <h2>Batas pemeriksaan</h2>
                  <p>
                    Profil: {report.profile}.{' '}
                    {report.active
                      ? 'Coverage fixed suite ditampilkan berdasarkan kasus yang dipilih.'
                      : 'OWASP belum diuji pada scan statis.'}{' '}
                    Hasil ini bukan sertifikasi keamanan.
                  </p>
                  <p role="status">
                    Panggilan hosted:{' '}
                    {assessmentConsentPreview === null
                      ? 'status belum dimuat.'
                      : assessmentConsentPreview.granted
                        ? 'consent tersimpan; data hanya dikirim saat Anda menjalankan Jev.'
                        : 'tidak aktif; tidak ada pengiriman otomatis.'}
                  </p>
                  {reportHasPartialCoverage && (
                    <p className="partial-notice" role="status">
                      Hasil ini parsial atau memiliki kasus yang belum teruji. Temuan yang tidak
                      terlihat pada run ini tidak otomatis terselesaikan.
                    </p>
                  )}
                  {report.snapshot && (
                    <p>
                      Snapshot <code>{report.snapshot.manifest_digest ?? 'tidak tersedia'}</code> ·
                      Commit Git <code>{report.snapshot.commit ?? 'tidak tersedia'}</code> · Working
                      tree {snapshotWorkingTreeLabel(report.snapshot.dirty)}.
                    </p>
                  )}
                  <ul>
                    {report.limitations.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <CoverageOverview coverage={report.coverage} />
                </section>
                <section className="graph-panel" aria-labelledby="graph-heading">
                  <h2 id="graph-heading">Peta definisi</h2>
                  <p>Relasi berikut diamati dari struktur kode; bukan bukti eksekusi runtime.</p>
                  <div className="graph-filters">
                    <label htmlFor="graph-kind">
                      Jenis komponen
                      <select
                        id="graph-kind"
                        value={graphKind}
                        onChange={(event) => setGraphKind(event.target.value)}
                      >
                        <option value="">Semua jenis</option>
                        <option value="file">file</option>
                        <option value="symbol">symbol</option>
                        <option value="endpoint">endpoint</option>
                        <option value="agent">agent</option>
                        <option value="tool">tool</option>
                        <option value="llm_call">llm_call</option>
                        <option value="retriever">retriever</option>
                        <option value="store">store</option>
                      </select>
                    </label>
                    <label htmlFor="graph-source-path">
                      Path sumber
                      <input
                        id="graph-source-path"
                        value={graphSourcePath}
                        onChange={(event) => setGraphSourcePath(event.target.value)}
                        placeholder="src/..."
                      />
                    </label>
                    <Button
                      type="button"
                      disabled={graphBusy || busy}
                      onClick={() => void loadGraph(session!.project_id, report.run_id)}
                    >
                      Terapkan filter peta
                    </Button>
                  </div>
                  {graphBusy && <p role="status">Memuat peta…</p>}
                  <p role="status" className="status-region">
                    {!graphBusy && graph.nodes.length === 0 && graph.edges.length === 0
                      ? 'Belum ada relasi definisi pada input yang didukung.'
                      : ''}
                  </p>
                  {graph.nodes.length > 0 && (
                    <p className="graph-count">Komponen pada halaman ini: {graph.nodes.length}</p>
                  )}
                  {graph.nodes.length > 0 && (
                    <>
                      <h3>Komponen</h3>
                      <ul className="graph graph-nodes">
                        {graph.nodes.map((node) => (
                          <li key={node.id}>
                            <code>{node.label}</code>
                            <span>
                              {node.kind}
                              {node.provenance ? ` · ${node.provenance}` : ''} ·{' '}
                              {node.source_ref.path}:{node.source_ref.line}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {graph.edges.length > 0 && (
                    <>
                      <h3>Relasi</h3>
                      <ul className="graph graph-edges">
                        {graph.edges.map((edge) => (
                          <li key={edge.id}>
                            <Button
                              type="button"
                              className="graph-edge"
                              aria-pressed={selectedGraphEdgeId === edge.id}
                              onClick={() =>
                                setSelectedGraphEdgeId((current) =>
                                  current === edge.id ? null : edge.id,
                                )
                              }
                            >
                              <code>{label.get(edge.source) ?? edge.source}</code>
                              <span>
                                {' '}
                                → {edge.kind}
                                {edge.provenance ? ` · ${edge.provenance}` : ''}
                                {edge.source_ref
                                  ? ` · ${edge.source_ref.path}:${edge.source_ref.line}`
                                  : ''}{' '}
                                →{' '}
                              </span>
                              <code>{label.get(edge.target) ?? edge.target}</code>
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {selectedGraphEdge && (
                    <GraphEdgeDetails edge={selectedGraphEdge} labels={label} />
                  )}
                  {graph.nodes.length > 0 && graph.edges.length === 0 && (
                    <p>Halaman ini belum memuat relasi antar-komponen.</p>
                  )}
                  {graph.next_offset !== null && (
                    <Button
                      disabled={graphBusy || busy}
                      onClick={() => void loadGraph(session!.project_id, report.run_id, true)}
                    >
                      Muat peta berikutnya
                    </Button>
                  )}
                </section>
                <section>
                  <h2>Kemampuan engine</h2>
                  <ul className="engines">
                    {Object.entries(report.engine_states).map(([name, state]) => (
                      <li key={name}>
                        <strong>{name}</strong>
                        <span>{engineStateSummary(name, state)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              </>
            )}
            <section className="history-panel" aria-labelledby="history-heading">
              <h2 id="history-heading">Riwayat pemeriksaan</h2>
              <p>Pilih hasil lama untuk ditinjau atau bandingkan dengan run yang sedang dibuka.</p>
              <div className="history-grid">
                <label htmlFor="history-run">
                  Hasil yang dibuka
                  <select
                    id="history-run"
                    value={selectedRunId ?? ''}
                    onChange={(event) => void selectRun(event.target.value)}
                    disabled={historyBusy || runs.length === 0}
                  >
                    <option value="">Belum ada hasil</option>
                    {runs.map((run) => (
                      <option key={run.id} value={run.id}>
                        {new Date(run.created_at).toLocaleString('id-ID')} · {run.profile} ·{' '}
                        {run.state}
                      </option>
                    ))}
                  </select>
                </label>
                <label htmlFor="history-base">
                  Bandingkan dengan
                  <select
                    id="history-base"
                    value={baseRunId}
                    onChange={(event) => {
                      setBaseRunId(event.target.value);
                      setDiff(null);
                    }}
                    disabled={historyBusy || runs.length < 2}
                  >
                    <option value="">Pilih basis pembanding</option>
                    {runs
                      .filter((run) => run.id !== selectedRunId)
                      .map((run) => (
                        <option key={run.id} value={run.id}>
                          {new Date(run.created_at).toLocaleString('id-ID')} · {run.state}
                        </option>
                      ))}
                  </select>
                </label>
                <Button
                  disabled={
                    historyBusy || !baseRunId || !selectedRunId || baseRunId === selectedRunId
                  }
                  onClick={() => void compareRuns()}
                >
                  Bandingkan run
                </Button>
              </div>
              {historyBusy && <p role="status">Memuat riwayat…</p>}
              {!historyBusy && runs.length === 0 && (
                <p>Belum ada pemeriksaan. Jalankan scan statis untuk membuat hasil pertama.</p>
              )}
              {historyNextOffset !== null && (
                <Button
                  type="button"
                  disabled={historyBusy || busy}
                  onClick={() => void loadHistory(session.project_id, true)}
                >
                  Muat riwayat berikutnya
                </Button>
              )}
              {diff && <DiffView diff={diff} />}
            </section>
            <section className="active-panel" aria-labelledby="active-heading">
              <h2 id="active-heading">Pengujian aktif berizin</h2>
              <p>
                Hanya target local loopback HTTP atau staging HTTPS dengan path/method eksplisit dan
                kasus fixed suite yang dipilih. Tidak ada target production atau discovery otomatis.
              </p>
              <div className="active-grid">
                <label>
                  Lingkungan
                  <select
                    value={activeEnvironment}
                    onChange={(event) =>
                      setActiveEnvironment(event.target.value as 'local' | 'staging')
                    }
                    disabled={!!activePlan || !!activePlanRun}
                  >
                    <option value="local">Local loopback</option>
                    <option value="staging">Staging HTTPS</option>
                  </select>
                </label>
                <label>
                  Base URL target
                  <input
                    value={activeBaseUrl}
                    onChange={(event) => setActiveBaseUrl(event.target.value)}
                    disabled={!!activePlan || !!activePlanRun}
                  />
                </label>
                <label>
                  Path yang diizinkan
                  <input
                    value={activePath}
                    onChange={(event) => setActivePath(event.target.value)}
                    disabled={!!activePlan || !!activePlanRun}
                  />
                </label>
                <label>
                  Case IDs
                  <input
                    value={activeCases}
                    onChange={(event) => setActiveCases(event.target.value)}
                    disabled={!!activePlan || !!activePlanRun}
                  />
                </label>
              </div>
              <label className="active-cost-ack">
                <input
                  type="checkbox"
                  checked={activeCostAcknowledged}
                  onChange={(event) => setActiveCostAcknowledged(event.target.checked)}
                  disabled={!!activePlanRun || !!activePlan}
                />{' '}
                Saya memahami biaya internal target tidak dapat diukur oleh plenger; gunakan
                request-only guard dan tampilkan biaya sebagai unknown.
              </label>
              <div className="active-actions">
                <Button
                  disabled={
                    busy || !!activePlanRun || !!activePlan || !report || !activeCostAcknowledged
                  }
                  onClick={createActivePlan}
                >
                  Buat plan
                </Button>
                {activePlan && (
                  <>
                    <span className="mono">Plan {activePlan.plan_digest}</span>
                    <Button
                      disabled={busy || !!activeApproval || !activeAcknowledged}
                      onClick={approveActivePlan}
                    >
                      Setujui scope sekali pakai
                    </Button>
                    <Button disabled={busy || !!activePlanRun} onClick={revokeActivePlan}>
                      Cabut plan aktif
                    </Button>
                  </>
                )}
                {activeApproval && (
                  <Button disabled={busy || !!activePlanRun} onClick={startActivePlan}>
                    Jalankan fixed suite
                  </Button>
                )}
                {activePlanRun && <Button onClick={cancelActivePlan}>Cancel run</Button>}
              </div>
              {activePlan?.preview && (
                <div className="active-preview" aria-labelledby="active-plan-preview-title">
                  <h3 id="active-plan-preview-title">Scope untuk persetujuan</h3>
                  <dl className="plan-details">
                    <div>
                      <dt>Project</dt>
                      <dd>
                        <code>{activePlan.preview.project_id}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Digest plan</dt>
                      <dd>
                        <code>{activePlan.plan_digest}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Digest scope</dt>
                      <dd>
                        <code>{activePlan.scope_digest}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Target</dt>
                      <dd>
                        {activePlan.preview.target_ref} · {activePlan.preview.environment} ·{' '}
                        {activePlan.preview.base_origin}
                      </dd>
                    </div>
                    <div>
                      <dt>Revision target</dt>
                      <dd>
                        <code>{activePlan.preview.target_revision}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Alamat target yang diizinkan</dt>
                      <dd>{activePlan.preview.allowed_ips.join(', ') || 'Tidak ada'}</dd>
                    </div>
                    <div>
                      <dt>Path dan method</dt>
                      <dd>
                        <ul>
                          {activePlan.preview.allowed_paths.map((path) => (
                            <li key={path}>
                              <code>{activePlan.preview?.allowed_methods.join(', ')}</code> {path}
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                    <div>
                      <dt>Profil autentikasi</dt>
                      <dd>{activePlan.preview.auth_profile_ref ?? 'Tidak ada'}</dd>
                    </div>
                    <div>
                      <dt>Respons target</dt>
                      <dd>
                        Maksimum {activePlan.preview.max_response_bytes} byte · observability{' '}
                        {activePlan.preview.observability} · output{' '}
                        <code>{activePlan.preview.output_path}</code> · trace{' '}
                        <code>{activePlan.preview.trace_path ?? 'Tidak ada'}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Profil dan suite</dt>
                      <dd>
                        <code>{activePlan.preview.profile}</code>
                        <br />
                        Digest profil <code>{activePlan.preview.profile_digest}</code>
                        <br />
                        {activePlan.preview.case_count} case terpilih
                        <ul>
                          {activePlan.preview.case_ids.map((caseId) => (
                            <li key={caseId}>
                              <code>{caseId}</code>
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                    <div>
                      <dt>Digest rubric</dt>
                      <dd>
                        <code>{activePlan.preview.rubric_hash}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Snapshot kode</dt>
                      <dd>
                        <code>{activePlan.preview.snapshot_digest}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Identitas autentikasi target</dt>
                      <dd>{activePlan.preview.auth_identity}</dd>
                    </div>
                    <div>
                      <dt>Kelas data</dt>
                      <dd>{activePlan.preview.data_classes.join(', ') || 'Tidak ada'}</dd>
                    </div>
                    <div>
                      <dt>Budget</dt>
                      <dd>
                        <ul>
                          <li>
                            Maksimum {activePlan.preview.budget.max_cases} case dan{' '}
                            {activePlan.preview.budget.max_attempts} attempt
                          </li>
                          <li>Concurrency {activePlan.preview.budget.concurrency}</li>
                          <li>
                            Batas waktu request {activePlan.preview.budget.request_timeout_seconds}{' '}
                            detik
                          </li>
                          <li>Batas durasi {activePlan.preview.budget.wall_time_seconds} detik</li>
                          <li>
                            Guard biaya {activePlan.preview.budget.cost_guard}
                            {activePlan.preview.budget.cost_guard === 'request_only'
                              ? ' · biaya target unknown'
                              : ''}{' '}
                            · acknowledgment{' '}
                            {activePlan.preview.budget.cost_acknowledged
                              ? 'diberikan'
                              : 'tidak diberikan'}
                          </li>
                        </ul>
                      </dd>
                    </div>
                    <div>
                      <dt>Persetujuan</dt>
                      <dd>
                        {ACTIVE_APPROVAL_ACTOR} · berlaku {ACTIVE_APPROVAL_TTL_MINUTES} menit ·
                        sekali pakai
                      </dd>
                    </div>
                  </dl>
                  <label className="active-approval-ack">
                    <input
                      type="checkbox"
                      checked={activeAcknowledged}
                      onChange={(event) => setActiveAcknowledged(event.target.checked)}
                      disabled={!!activeApproval}
                    />{' '}
                    Saya sudah meninjau digest rubric, target dan IP, path/method, revision, case,
                    snapshot, identitas, kelas data, budget, serta masa berlaku persetujuan.
                  </label>
                </div>
              )}
              {activeRunState && (
                <p role="status">
                  Status active run: <strong>{activeRunState}</strong>
                </p>
              )}
            </section>
            {report && (
              <footer>
                Run <code>{report.run_id}</code>
                <br />
                Snapshot <code>{report.snapshot_id}</code>
              </footer>
            )}
          </>
        )}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
