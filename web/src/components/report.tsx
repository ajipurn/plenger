// Presentational report views. They render API data only and hold no state.

import type {DiffResult, GraphEdge, Report} from '../types';

const COVERAGE_STATES = [
  {value: 'planned', label: 'Direncanakan'},
  {value: 'blocked', label: 'Diblokir'},
  {value: 'executed', label: 'Dijalankan'},
  {value: 'skipped', label: 'Dilewati'},
  {value: 'inconclusive', label: 'Inkonklusif'},
  {value: 'error', label: 'Error'},
  {value: 'not_tested', label: 'Belum diuji'},
] as const;

export function ReportSummary({report}: {report: Report}) {
  return (
    <section className="summary">
      <div>
        <span>Kandidat untuk ditinjau</span>
        <strong>{report.counts?.findings ?? report.findings.length}</strong>
      </div>
      <div>
        <span>Komponen dipetakan</span>
        <strong>{report.counts?.nodes ?? report.nodes.length}</strong>
      </div>
      <div>
        <span>Kandidat prioritas</span>
        <strong>{report.counts?.priority_findings ?? '—'}</strong>
        <span>severity high / critical</span>
      </div>
      <div>
        <span>Status run</span>
        <strong className="small">{report.state}</strong>
        <span>{new Date(report.created_at).toLocaleString('id-ID')}</span>
      </div>
    </section>
  );
}

export function ActiveSuiteResults({report}: {report: Report}) {
  const summary = report.summary;
  return (
    <section>
      <h2>Hasil fixed suite</h2>
      <p>
        Profil: <code>{report.profile}</code>
        {report.profile_digest && (
          <>
            {' '}
            · digest <code>{report.profile_digest}</code>
          </>
        )}
        {report.rubric_hash && (
          <>
            {' '}
            · rubric <code>{report.rubric_hash}</code>
          </>
        )}
      </p>
      <p>
        Kasus yang dipilih: <strong>{report.case_count ?? report.test_results?.length ?? 0}</strong>
        . Hasil yang tercatat: <strong>{report.test_results?.length ?? 0}</strong>. Angka ini adalah
        denominator suite, bukan skor keamanan.
      </p>
      {summary && (
        <p role="status" className="active-summary">
          Gagal (marker/efek teramati): <strong>{summary.fail ?? 0}</strong> · Lolos:{' '}
          <strong>{summary.pass ?? 0}</strong> · Error: <strong>{summary.error ?? 0}</strong> ·
          Inkonklusif: <strong>{summary.inconclusive ?? 0}</strong> · Tidak berjalan:{' '}
          <strong>{summary.not_run ?? 0}</strong>
        </p>
      )}
      {report.case_ids && (
        <p>
          Case IDs yang disetujui:{' '}
          {report.case_ids.map((caseId) => (
            <code key={caseId}>{caseId} </code>
          ))}
        </p>
      )}
      <p role="status">
        Akuntansi target:{' '}
        {report.accounting?.cost_status === 'unknown'
          ? 'unknown (request-only)'
          : (report.accounting?.cost ?? 'tidak tersedia')}{' '}
        · reserved attempts {report.accounting?.reserved_attempts ?? 0}
      </p>
      {report.test_results?.length ? (
        <ul className="test-results">
          {report.test_results.map((item) => (
            <li key={item.case_id}>
              <strong>{item.case_id}</strong>
              <span className={`result-${item.result}`}>{item.result}</span>
              <small>
                {item.reason_code}
                {item.http_status ? ` · HTTP ${item.http_status}` : ''}
              </small>
              {item.evidence.length > 0 && (
                <small className="test-evidence">Bukti: {item.evidence.join(' · ')}</small>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>Run aktif selesai tanpa hasil kasus tersimpan.</p>
      )}
    </section>
  );
}

export function CoverageOverview({coverage}: {coverage: Report['coverage']}) {
  const coverageCounts: Record<string, number> = {};
  for (const item of coverage) {
    coverageCounts[item.state] = (coverageCounts[item.state] ?? 0) + 1;
  }
  return (
    <>
      <h3>Status coverage</h3>
      <dl className="coverage-summary" aria-label="Ringkasan status coverage">
        {COVERAGE_STATES.map(({value, label}) => (
          <div key={value}>
            <dt>{label}</dt>
            <dd>{coverageCounts[value] ?? 0}</dd>
          </div>
        ))}
      </dl>
      <p className="coverage-note">
        Jumlah ini menunjukkan kategori pada setiap status, bukan skor keamanan atau persentase
        coverage.
      </p>
      <div className="coverage">
        {coverage.map((coverage) => (
          <span key={coverage.category}>
            {coverage.category} · {coverage.state}
          </span>
        ))}
      </div>
    </>
  );
}

export function GraphEdgeDetails({edge, labels}: {edge: GraphEdge; labels: Map<string, string>}) {
  return (
    <div
      className="graph-edge-details"
      role="region"
      aria-live="polite"
      aria-labelledby="selected-edge-heading"
    >
      <h4 id="selected-edge-heading">Bukti relasi dipilih</h4>
      <p>Relasi ini berasal dari analisis struktur kode, bukan observasi eksekusi runtime.</p>
      <dl>
        <dt>Dari</dt>
        <dd>{labels.get(edge.source) ?? edge.source}</dd>
        <dt>Ke</dt>
        <dd>{labels.get(edge.target) ?? edge.target}</dd>
        <dt>Jenis relasi</dt>
        <dd>{edge.kind}</dd>
        <dt>Provenance</dt>
        <dd>{edge.provenance ?? 'tidak tersedia'}</dd>
        <dt>Lokasi sumber</dt>
        <dd>
          {edge.source_ref ? `${edge.source_ref.path}:${edge.source_ref.line}` : 'tidak tersedia'}
        </dd>
      </dl>
    </div>
  );
}

export function DiffView({diff}: {diff: DiffResult}) {
  return (
    <div className="diff-result" aria-live="polite">
      <h3>Hasil perbandingan</h3>
      {!diff.comparable ? (
        <p>Run tidak comparable: {diff.reason}.</p>
      ) : diff.items.length === 0 ? (
        <p>Tidak ada perubahan temuan pada dua run ini.</p>
      ) : (
        <ul>
          {diff.items.map((item) => (
            <li key={`${item.status}-${item.fingerprint}`}>
              <span className={`diff-${item.status}`}>{item.status}</span>
              <code>{item.fingerprint}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
