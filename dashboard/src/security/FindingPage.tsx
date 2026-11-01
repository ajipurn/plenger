import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  FINDING_STATUSES,
  type FindingStatus,
  findingValidation,
  type ImportedReaEvidence,
  type SecurityFinding,
  type SecurityWorkspace,
} from "../../../src/dashboard/contract.ts";
import type { SavedProvider } from "../../../src/redteam/provider-config.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { FixPromptGenerator } from "../findings/FixPromptGenerator.tsx";
import { errorMessage } from "../shared/async.ts";
import { DetailDrawer } from "../shared/DetailDrawer.tsx";
import { MorphNumber, NumericText } from "../shared/MorphNumber.tsx";
import { notifySuccess } from "../shared/toast.tsx";
import { Button, Select } from "../shared/ui.tsx";
import { date, Empty, originLabel, statusLabel, validationLabel } from "./ui.tsx";

export function FindingPage({
  data,
  providers,
  onRefresh,
}: {
  data: SecurityWorkspace;
  providers: SavedProvider[];
  onRefresh: () => Promise<void>;
}) {
  const api = useApi();
  const { id } = useParams();
  const [params] = useSearchParams();
  const occurrenceScan = params.get("scan");
  const current = data.findings.find((item) => item.id === id || item.aliases?.includes(id ?? ""));
  const [occurrence, setOccurrence] = useState<SecurityFinding | null>(null);
  const [loadingOccurrence, setLoadingOccurrence] = useState(Boolean(occurrenceScan));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fix, setFix] = useState(false);
  const [rea, setRea] = useState<ImportedReaEvidence[]>([]);
  const fixTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    setOccurrence(null);
    if (api && occurrenceScan)
      void api
        .securityScan(occurrenceScan)
        .then((scan) => {
          if (active) {
            setOccurrence(scan.findings.find((item) => item.id === id) ?? null);
            setLoadingOccurrence(false);
          }
        })
        .catch(() => {
          if (active) {
            setError("Unable to load this finding's scan occurrence.");
            setLoadingOccurrence(false);
          }
        });
    return () => {
      active = false;
    };
  }, [api, occurrenceScan, id]);
  const finding = occurrenceScan ? occurrence : current;
  const sourceScanId = finding?.sourceScanId;
  useEffect(() => {
    let active = true;
    setRea([]);
    if (api && sourceScanId)
      void api
        .reaEvidence(sourceScanId)
        .then((next) => {
          if (active) setRea(next);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [api, sourceScanId]);
  if (loadingOccurrence)
    return (
      <p className="security-empty" role="status">
        Loading finding occurrence…
      </p>
    );
  if (!finding)
    return (
      <Empty
        title="Finding not found"
        description="Return to the findings list or open a saved scan."
        action={
          <Link className="button button-primary" to="/findings">
            All findings
          </Link>
        }
      />
    );
  const repository = data.repositories.find((item) => item.id === finding.repositoryId);
  const scan = data.scans.find((item) => item.id === finding.scanId);
  const projectContext = params.get("project") === finding.repositoryId;
  const projectPath = `/projects/${encodeURIComponent(finding.repositoryId)}`;
  async function changeStatus(status: FindingStatus) {
    if (!api || !finding) return;
    setBusy(true);
    setError("");
    try {
      await api.setFindingStatus(finding.id, status);
      await onRefresh();
      notifySuccess(`Status set to ${statusLabel[status]}.`);
    } catch (failure) {
      setError(errorMessage(failure, "Unable to update finding status."));
    } finally {
      setBusy(false);
    }
  }
  const findingStatus = current?.status ?? finding.status;
  return (
    <>
      <div className="security-detail-actions">
        <Link to={projectContext ? projectPath : "/findings"} className="muted">
          ‹ {projectContext ? (repository?.name ?? "Project") : "All findings"}
        </Link>
        <div>
          <Link
            className="button button-secondary"
            to={`/scans/${finding.scanId}${projectContext ? `?project=${encodeURIComponent(finding.repositoryId)}` : ""}`}
          >
            View scan
          </Link>
          <Button ref={fixTrigger} className="button button-primary" onClick={() => setFix(true)}>
            Fix with a coding agent
          </Button>
        </div>
      </div>
      <div className="security-detail-layout security-finding-layout">
        <article className="security-finding-document">
          <div className="security-finding-title">
            <h1>{finding.title}</h1>
            <span className="security-status">{statusLabel[findingStatus]}</span>
          </div>
          <p className="muted security-finding-updated">
            Updated{" "}
            <MorphNumber value={date(current?.updatedAt ?? finding.updatedAt)} variant="text" />
          </p>
          {error && (
            <p role="alert" className="error-message">
              <NumericText>{error}</NumericText>
            </p>
          )}
          {[
            { label: "Summary", text: finding.summary },
            { label: "Root cause", text: finding.rootCause },
            { label: "Attack path", text: finding.attackPath },
            { label: "Validation", text: finding.validation },
            { label: "Remediation", text: finding.remediation },
          ].map((section) => (
            <section key={section.label}>
              <h2>{section.label}</h2>
              <p>{section.text}</p>
            </section>
          ))}
          <section className="security-finding-evidence">
            <h2>Source evidence</h2>
            {finding.evidence.map((cite) => (
              <div
                className="security-source-evidence"
                key={JSON.stringify(cite)}
                id={`source-${finding.evidence.indexOf(cite)}`}
              >
                <code>
                  {cite.path}:<MorphNumber value={String(cite.line)} />
                  {cite.endLine > cite.line && (
                    <>
                      –<MorphNumber value={String(cite.endLine)} />
                    </>
                  )}
                </code>
                <p className="muted">{cite.message}</p>
                {cite.snippet && (
                  <pre className="code-block">
                    <code>{cite.snippet}</code>
                  </pre>
                )}
              </div>
            ))}
          </section>
          {!!finding.provenance?.length && (
            <section>
              <h2>Finding provenance</h2>
              {finding.provenance.map((entry) => (
                <div key={`${entry.origin}:${entry.sourceFindingId}:${entry.reviewId}`}>
                  <h3>
                    {entry.origin === "static" ? `Static rule ${entry.ruleId ?? ""}` : "AI review"}
                  </h3>
                  <p className="muted">
                    Source scan: {entry.sourceScanId}
                    {entry.reviewId ? ` · Review: ${entry.reviewId}` : ""}
                  </p>
                  {entry.review && (
                    <p>
                      {validationLabel[entry.review.validation]}: {entry.review.validationReason}
                    </p>
                  )}
                  {entry.review?.dismissal?.evidence.map((cite) => (
                    <p key={JSON.stringify(cite)}>
                      <code>
                        {cite.path}:<MorphNumber value={String(cite.line)} />
                      </code>{" "}
                      {cite.message}
                    </p>
                  ))}
                </div>
              ))}
            </section>
          )}
          <details className="security-raw-evidence">
            <summary>Full finding evidence</summary>
            <pre className="code-block">
              <code>{JSON.stringify(finding, null, 2)}</code>
            </pre>
          </details>
        </article>
        <aside className="security-detail-meta" aria-label="Finding metadata">
          <dl>
            <div>
              <dt>Reported severity</dt>
              <dd>
                <span className={`badge ${finding.severity}`}>{finding.severity}</span>
              </dd>
            </div>
            <div>
              <dt>
                <label htmlFor="finding-status">Status</label>
              </dt>
              <dd>
                <Select
                  label="Finding status"
                  id="finding-status"
                  value={findingStatus}
                  disabled={busy}
                  items={FINDING_STATUSES.map((value) => ({ value, label: statusLabel[value] }))}
                  onValueChange={(value) => void changeStatus(value)}
                />
              </dd>
            </div>
            <div>
              <dt>Observed revision</dt>
              <dd>
                <code>{scan?.revision.commit?.slice(0, 12) ?? "Working tree"}</code>
              </dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>
                <Link to={projectPath}>{repository?.name ?? "Project"}</Link>
              </dd>
            </div>
            <div>
              <dt>Detected</dt>
              <dd>
                <MorphNumber value={date(finding.detectedAt)} variant="text" />
              </dd>
            </div>
            <div>
              <dt>Affected locations</dt>
              <dd className="security-location-links">
                {finding.evidence.map((cite) => (
                  <a key={JSON.stringify(cite)} href={`#source-${finding.evidence.indexOf(cite)}`}>
                    <code>
                      {cite.path}:<MorphNumber value={String(cite.line)} />
                    </code>
                  </a>
                ))}
              </dd>
            </div>
            <div>
              <dt>Origin</dt>
              <dd>{originLabel(finding)}</dd>
            </div>
            <div>
              <dt>Validation</dt>
              <dd>{validationLabel[findingValidation(finding)]}</dd>
            </div>
            {finding.cwe && (
              <div>
                <dt>Weakness</dt>
                <dd>
                  <a
                    href={`https://cwe.mitre.org/data/definitions/${finding.cwe.slice(4)}.html`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {finding.cwe}
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </aside>
      </div>
      <DetailDrawer
        open={fix}
        onOpenChange={setFix}
        className="inventory-detail-panel security-drawer"
        headingClassName="findings-drawer-heading security-drawer-heading"
        eyebrow="Remediation"
        title="Fix with a coding agent"
        description="Generate a prompt from this finding, then copy it into your coding agent."
        descriptionClassName="muted"
        closeLabel="Close fix prompt"
        returnFocus={() => fixTrigger.current}
      >
        <div className="finding-detail">
          <FixPromptGenerator
            key={`${finding.scanId}:${finding.id}`}
            scanId={finding.sourceScanId}
            fingerprint={finding.sourceFindingId}
            {...(finding.reviewId ? { reviewId: finding.reviewId } : {})}
            providers={providers}
            reaEvidence={rea}
          />
        </div>
      </DetailDrawer>
    </>
  );
}
