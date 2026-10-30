import { useEffect, useId, useRef, useState } from "react";
import { type ImportedReaEvidence, REA_LIMITS } from "../../../src/dashboard/contract.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { errorMessage, useAsyncAction } from "../shared/async.ts";
import { downloadJson } from "../shared/download.ts";
import { MorphNumber, NumericText } from "../shared/MorphNumber.tsx";
import { Button, Input } from "../shared/ui.tsx";

export function ReaEvidencePanel({
  scanId,
  records,
  onChange,
}: {
  scanId: string;
  records: ImportedReaEvidence[];
  onChange: (records: ImportedReaEvidence[]) => void;
}) {
  const api = useApi();
  const inputId = useId();
  const helpId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const { busy, error, setError, run } = useAsyncAction();
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    setLoading(true);
    api
      .reaEvidence(scanId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) onChange(next);
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(errorMessage(failure, "Unable to load imported evidence. Reload the page."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, scanId, onChange, setError]);

  function importFile() {
    if (!api) return;
    setNotice("");
    if (!file) {
      setError("Choose a REA JSON file to import.");
      fileInput.current?.focus();
      return;
    }
    if (file.size > REA_LIMITS.fileBytes) {
      setError(`Choose a REA JSON file smaller than ${REA_LIMITS.fileBytes / 1024 / 1024} MiB.`);
      return;
    }
    void run(async () => {
      let evidence: unknown;
      try {
        evidence = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()),
        );
      } catch {
        throw new Error("Choose a valid UTF-8 JSON file exported by REA.");
      }
      const saved = await api.importReaEvidence({ scanId, filename: file.name, evidence });
      onChange([saved, ...records.filter((item) => item.id !== saved.id)]);
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setNotice("REA evidence imported. Open a finding to include it in a fix prompt.");
    }, "Unable to import the REA file. Try again.");
  }

  function remove(record: ImportedReaEvidence) {
    if (!api) return;
    setNotice("");
    void run(async () => {
      await api.deleteReaEvidence(scanId, record.id);
      onChange(records.filter((item) => item.id !== record.id));
      setNotice(`${record.filename} removed from this scan.`);
    }, "Unable to remove imported evidence. Try again.");
  }

  return (
    <details className="rea-evidence-panel">
      <summary>
        REA evidence{" "}
        <span className="tag">{loading ? "Loading…" : <MorphNumber value={records.length} />}</span>
      </summary>
      <div className="rea-evidence-body">
        <p className="muted">
          Attach JavaScript or Electron analysis to this scan. Imported claims are unverified and do
          not change static findings.
        </p>
        <form
          className="rea-import-form"
          onSubmit={(event) => {
            event.preventDefault();
            importFile();
          }}
        >
          <label htmlFor={inputId}>REA JSON file</label>
          <div className="rea-import-controls">
            <Input
              id={inputId}
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              aria-describedby={helpId}
              disabled={loading || busy}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setError("");
                setNotice("");
              }}
            />
            <Button
              type="submit"
              className="button button-secondary"
              disabled={!api || loading || busy}
            >
              {busy ? "Working…" : "Import evidence"}
            </Button>
          </div>
          <p id={helpId} className="muted">
            Complete analyze-javascript-application output, up to{" "}
            {REA_LIMITS.fileBytes / 1024 / 1024} MiB. Import stays on this device. Each new scan has
            its own attachments.
          </p>
        </form>
        {error && (
          <p className="error-message" role="alert">
            <NumericText>{error}</NumericText>
          </p>
        )}
        <div className="rea-evidence-list">
          {records.map((record) => (
            <article className="rea-evidence-card" key={record.id}>
              <div className="rea-evidence-card-heading">
                <h3>{record.filename}</h3>
                <span className="tag">Unverified import</span>
              </div>
              <p className="muted">
                {record.analysis.artifact.name} ·{" "}
                <MorphNumber value={record.analysis.graph.nodes.length} />{" "}
                {record.analysis.graph.nodes.length === 1 ? "node" : "nodes"} ·{" "}
                <MorphNumber value={record.analysis.graph.edges.length} />{" "}
                {record.analysis.graph.edges.length === 1 ? "relationship" : "relationships"}
              </p>
              <p className="muted">
                Reported coverage: {String(record.analysis.graph.coverage.status)}
                {record.analysis.graph.coverage.truncated ? " · truncated" : ""}. Reported
                confidence: {record.analysis.confidence}.
              </p>
              <details className="rea-evidence-details">
                <summary>View provenance and limitations</summary>
                <dl className="detail-list">
                  <div>
                    <dt>REA evidence ID</dt>
                    <dd>
                      <code>{record.analysis.evidenceId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Reported artifact SHA-256</dt>
                    <dd>
                      <code>{record.analysis.artifact.sha256}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Imported by Plenger</dt>
                    <dd>
                      <MorphNumber
                        value={new Date(record.importedAt).toLocaleString()}
                        variant="text"
                      />
                    </dd>
                  </div>
                </dl>
                <p className="muted">
                  Association with this repository and build has not been checked. REA IDs and
                  hashes are reported values.
                </p>
                {[
                  ...new Set([
                    ...record.analysis.limitations,
                    ...(record.analysis.graph.limitations as string[]),
                  ]),
                ].length > 0 && (
                  <ul>
                    {[
                      ...new Set([
                        ...record.analysis.limitations,
                        ...(record.analysis.graph.limitations as string[]),
                      ]),
                    ].map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </details>
              <div className="rea-evidence-actions">
                <Button
                  className="button button-secondary"
                  onClick={() => downloadJson(`plenger-rea-${record.id}.json`, record)}
                >
                  Export redacted evidence
                </Button>
                <Button
                  className="button button-quiet"
                  disabled={busy || loading}
                  onClick={() => remove(record)}
                  aria-label={`Remove ${record.filename}`}
                >
                  Remove
                </Button>
              </div>
            </article>
          ))}
        </div>
        <p className="muted rea-evidence-status" role="status">
          <NumericText>{notice}</NumericText>
        </p>
      </div>
    </details>
  );
}
