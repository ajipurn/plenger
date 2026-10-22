import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  canContinue,
  EXPLORE_STOPS,
  type ExploreSessionRecord,
  type ImportedReaEvidence,
  type ReviewFinding,
  type ReviewPath,
  SCAN_BUDGET_LIMITS,
  SCAN_DEPTHS,
  SECURITY_POLL_MS,
  type SecurityScan,
  type SecurityWorkspace,
} from "../../../src/dashboard/contract.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { ReaEvidencePanel } from "../findings/ReaEvidencePanel.tsx";
import { errorMessage } from "../shared/async.ts";
import { downloadJson } from "../shared/download.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { Button } from "../shared/ui.tsx";
import { ContinueScan } from "./ContinueScan.tsx";
import { costLabel, ScanBilling } from "./ScanBilling.tsx";
import { ScanProgress } from "./ScanProgress.tsx";
import {
  closureLabel,
  date,
  dismissalLabel,
  FindingsTable,
  ScanDuration,
  ScanStatus,
} from "./ui.tsx";

export function ScanDetailPage({
  data,
  onRefresh,
  onNewScan,
}: {
  data: SecurityWorkspace;
  onRefresh: () => Promise<void>;
  onNewScan: (id: string) => void;
}) {
  const api = useApi();
  const { id } = useParams();
  const [params] = useSearchParams();
  const [scan, setScan] = useState<SecurityScan | null>(null);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [rea, setRea] = useState<ImportedReaEvidence[]>([]);
  // Bumped when the page restarts a scan, so polling resumes while it runs.
  const [polling, setPolling] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new polling value restarts this effect after a continue
  useEffect(() => {
    if (!api || !id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await api.securityScan(id);
        if (!stopped) {
          setScan(next);
          setError("");
          if (next.status === "running") timer = setTimeout(() => void load(), SECURITY_POLL_MS);
        }
      } catch (failure) {
        if (!stopped) setError(errorMessage(failure, "Unable to load scan."));
      }
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, id, polling]);
  if (!scan)
    return (
      <div className="security-empty" role={error ? "alert" : "status"}>
        {error || "Loading scan…"}
      </div>
    );
  const repository = data.repositories.find((item) => item.id === scan.repositoryId);
  const names = new Map(data.repositories.map((item) => [item.id, item.name]));
  const findings = scan.findings.map((item) => ({
    ...item,
    status: data.findings.find((current) => current.id === item.id)?.status ?? item.status,
  }));
  const outputs = params.get("tab") === "outputs";
  const running = scan.status === "running";
  const projectContext = params.get("project") === scan.repositoryId;
  const projectPath = `/projects/${encodeURIComponent(scan.repositoryId)}`;
  const scanPath = `/scans/${encodeURIComponent(scan.id)}`;
  const findingsPath = projectContext
    ? `${scanPath}?project=${encodeURIComponent(scan.repositoryId)}`
    : scanPath;
  const outputsPath = `${findingsPath}${projectContext ? "&" : "?"}tab=outputs`;
  async function cancel() {
    if (!api || !running || cancelling) return;
    setCancelling(true);
    try {
      await api.cancelSecurityScan(scan?.id ?? "");
      await onRefresh();
    } catch (failure) {
      setError(errorMessage(failure, "Unable to cancel scan."));
      setCancelling(false);
    }
  }
  return (
    <div className="security-scan-page">
      <Link
        to={projectContext ? `${projectPath}?tab=scans` : "/scans"}
        className="security-back-link"
      >
        <Icon name="chevron" /> {projectContext ? (repository?.name ?? "Project") : "All scans"}
      </Link>
      <header className="security-scan-heading">
        <div className="security-scan-identity">
          <div>
            <h1>{repository?.name ?? "Project"}</h1>
            <ScanStatus scan={scan} />
          </div>
          <p className="muted">
            Local source scan <span aria-hidden="true">·</span> Started {date(scan.startedAt)}
          </p>
        </div>
        <div className="security-scan-actions">
          {running && (
            <Button
              className="button button-secondary"
              disabled={cancelling}
              onClick={() => void cancel()}
            >
              <Icon name="close" /> {cancelling ? "Cancelling…" : "Cancel scan"}
            </Button>
          )}
          <Button
            className="button button-secondary"
            onClick={() => downloadJson(`plenger-scan-${scan.id}.json`, scan)}
          >
            <Icon name="download" /> {running ? "Export snapshot" : "Export JSON"}
          </Button>
          {!running && (
            <Button
              className="button button-primary"
              disabled={data.scans.some((item) => item.status === "running")}
              onClick={() => onNewScan(scan.repositoryId)}
            >
              <Icon name="scan" /> Scan again
            </Button>
          )}
        </div>
      </header>
      <dl className="security-scan-summary" aria-label="Scan summary">
        <div>
          <dt>
            <Icon name="clock" /> {running ? "Elapsed time" : "Duration"}
          </dt>
          <dd>
            <ScanDuration scan={scan} />
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="findings" /> Saved findings
          </dt>
          <dd>
            {running && !findings.length ? "Pending" : <MorphNumber value={findings.length} />}
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="inventory" /> Coverage
          </dt>
          <dd>
            {scan.coverage && scan.coverage.eligibleFiles > 0
              ? `${scan.coverage.sentFiles.toLocaleString()} of ${scan.coverage.eligibleFiles.toLocaleString()} files`
              : SCAN_DEPTHS[scan.depth].label}
          </dd>
          {scan.coverage && (
            <p className="muted security-scan-summary-note">{coverageNote(scan)}</p>
          )}
        </div>
      </dl>
      <div className="security-detail-layout security-scan-layout">
        <section className="security-detail-main">
          <nav className="security-subnav" aria-label="Scan detail">
            <Link aria-current={!outputs ? "page" : undefined} to={findingsPath}>
              <Icon name="findings" /> Findings
              {(!running || findings.length > 0) && (
                <span className="security-count">
                  <MorphNumber value={findings.length} />
                </span>
              )}
            </Link>
            <Link aria-current={outputs ? "page" : undefined} to={outputsPath}>
              <Icon name="source-files" /> Outputs
            </Link>
          </nav>
          {running && <ScanProgress scan={scan} cancelling={cancelling} />}
          {canContinue(scan) && (
            <ContinueScan
              scan={scan}
              disabled={data.scans.some((item) => item.status === "running")}
              onContinued={async (next) => {
                setScan(next);
                setPolling((value) => value + 1);
                await onRefresh();
              }}
            />
          )}
          {scan.error && (
            <div role="alert" className="security-review-error">
              <Icon name="alert" />
              <div>
                <strong>
                  {scan.status === "cancelled" ? "Scan cancelled" : "AI review could not complete"}
                </strong>
                <p>
                  The AI portion of this scan is incomplete. Review the details before starting
                  another scan.
                </p>
                <details className="security-error-details">
                  <summary>Show error details</summary>
                  <p>{scan.error}</p>
                </details>
                {findings.some((finding) => finding.origin === "static") && (
                  <p className="muted">
                    The static scan finished. Its findings remain available below.
                  </p>
                )}
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="error-message security-inline-error">
              {error}
            </p>
          )}
          <ScanBilling reviews={scan.reviews} />
          {outputs ? (
            <div className="security-outputs">
              {scan.reviews.length ? (
                scan.reviews.map((review, index) => (
                  <section key={review.id} className="security-output-batch">
                    <h2>
                      {review.mode === "explore" ? "Exploring review" : "Source batch"} {index + 1}
                    </h2>
                    <p className="muted">
                      {review.scope.files.length} of {review.scope.eligibleFiles} source files{" "}
                      {review.mode === "explore" ? "read" : "included"} ·{" "}
                      {review.scope.omittedFiles} {review.mode === "explore" ? "unread" : "omitted"}{" "}
                      · {review.status}
                      {review.validator ? ` · second review by ${review.validator.model}` : ""}
                    </p>
                    <p>{review.summary}</p>
                    {review.reason && <p className="security-output-failure">{review.reason}</p>}
                    <h3>Architecture</h3>
                    <p>{review.architecture}</p>
                    <div className="security-output-model">
                      <div>
                        <h3>Assets</h3>
                        <ul>
                          {[...new Set(review.assets)].map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <h3>Trust boundaries</h3>
                        <ul>
                          {[...new Set(review.trustBoundaries)].map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                    <h3>STRIDE threat model</h3>
                    <div className="security-stride-list">
                      {review.stride.map((entry) => (
                        <details key={entry.category}>
                          <summary>
                            <span>{entry.category}</span>
                            <span className={`security-status stride-${entry.status}`}>
                              {entry.status === "identified"
                                ? "Threat identified"
                                : entry.status === "not-observed"
                                  ? "Not observed"
                                  : "Needs context"}
                            </span>
                          </summary>
                          <p>{entry.analysis}</p>
                          <h4>Mitigation</h4>
                          <p>{entry.mitigation}</p>
                          <ul>
                            {entry.evidence.map((cite) => (
                              <li key={JSON.stringify(cite)}>
                                <code>
                                  {cite.path}:{cite.line}
                                </code>{" "}
                                {cite.message}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ))}
                    </div>
                    <TracedPaths paths={review.paths ?? []} findings={review.findings} />
                    <DismissedCandidates findings={review.findings} />
                    <details className="security-output-coverage">
                      <summary>Source coverage and limitations</summary>
                      <p className="muted">
                        Captured {date(review.scope.capturedAt)}. Source may include working tree
                        changes.
                        {review.scope.budget
                          ? ` Batch budget ${Math.round(review.scope.budget.contextBytes / 1024)} KiB${review.scope.budget.inputTokens ? ` for a ${review.scope.budget.inputTokens.toLocaleString()}-token model window` : ""}.`
                          : ""}
                      </p>
                      {review.generation && (
                        <p className="muted">
                          Prompt <code>{review.generation.promptDigest.slice(0, 12)}</code> ·{" "}
                          {samplingText("Discovery", review.generation.discovery)}
                          {review.generation.validation
                            ? ` · ${samplingText("second review", review.generation.validation)}`
                            : ""}
                        </p>
                      )}
                      <ul>
                        {review.scope.files.map((file) => (
                          <li key={file.path}>
                            <code>{file.path}</code> ·{" "}
                            {file.ranges
                              ? `${file.ranges.reduce((sum, range) => sum + range.endLine - range.line + 1, 0)} of ${file.lines} lines, function excerpt`
                              : `${file.lines} lines`}
                          </li>
                        ))}
                      </ul>
                      {review.scope.related?.length ? (
                        <>
                          <h4>Second review context</h4>
                          <ul>
                            {review.scope.related.map((file) => (
                              <li key={file.path}>
                                <code>{file.path}</code> ·{" "}
                                {file.relation === "imported" ? "imported by" : "calls"}{" "}
                                <code>{file.via}</code>
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                      {review.exploration?.length ? (
                        <ExplorationLog sessions={review.exploration} />
                      ) : null}
                      <ul>
                        {[...new Set(review.limitations)].map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </details>
                  </section>
                ))
              ) : (
                <p className="muted">
                  {scan.status === "running"
                    ? "Model outputs appear after each source batch finishes."
                    : "This scan has no AI outputs. Start a new scan with a saved provider to generate STRIDE and source analysis."}
                </p>
              )}
              {scan.reviews.length > 1 && (
                <p className="muted">
                  Source batches are reviewed independently. Paths crossing batch boundaries may
                  need additional context.
                </p>
              )}
              {scan.sourceScanId && (
                <ReaEvidencePanel
                  key={scan.sourceScanId}
                  scanId={scan.sourceScanId}
                  records={rea}
                  onChange={setRea}
                />
              )}
            </div>
          ) : findings.length ? (
            <FindingsTable
              findings={findings}
              names={names}
              scanId={scan.id}
              {...(projectContext ? { projectId: scan.repositoryId } : {})}
            />
          ) : (
            !running && (
              <div className="security-scan-result-empty">
                <Icon name={scan.status === "completed" ? "checklist" : "info"} />
                <h2>
                  {scan.status === "completed" ? "No reportable findings" : "No findings saved"}
                </h2>
                <p className="muted">
                  {scan.status === "completed"
                    ? "Review the source coverage and limitations to understand what was checked."
                    : "This scan did not finish. Its empty finding list does not establish that the project is secure."}
                </p>
                <Link className="security-text-link" to={outputsPath}>
                  View scan outputs <Icon name="arrow-right" />
                </Link>
              </div>
            )
          )}
        </section>
        <aside className="security-detail-meta security-scan-meta" aria-label="Scan details">
          <section>
            <h2>
              <Icon name="folder" /> Source
            </h2>
            <dl>
              <div>
                <dt>Project</dt>
                <dd>
                  <Link to={projectPath}>{repository?.name ?? "Project"}</Link>
                </dd>
              </div>
              <div>
                <dt>Revision</dt>
                <dd>
                  <code>{scan.revision.commit?.slice(0, 12) ?? "Local files"}</code>
                  {scan.revision.dirty && <small>Includes uncommitted changes</small>}
                </dd>
              </div>
              <div className="security-meta-path">
                <dt>Local folder</dt>
                <dd>
                  <code>{repository?.path ?? "Unavailable"}</code>
                </dd>
              </div>
            </dl>
            {scan.environment.notes && (
              <details className="security-scan-context">
                <summary>Review context</summary>
                <p>{scan.environment.notes}</p>
              </details>
            )}
          </section>
          <section>
            <h2>
              <Icon name="models" /> Model &amp; usage
            </h2>
            <dl>
              <div>
                <dt>Provider</dt>
                <dd>
                  {scan.provider?.name ?? "Offline scan"}
                  <small>{scan.provider?.model}</small>
                </dd>
              </div>
              <div>
                <dt>Usage</dt>
                <dd>
                  {scan.tokens === null ? (
                    running ? (
                      "Not reported yet"
                    ) : (
                      "Not reported by provider"
                    )
                  ) : (
                    <>
                      <MorphNumber value={scan.tokens} /> tokens
                    </>
                  )}
                  <small>
                    {running ? (
                      "Reported usage updates when a source batch finishes."
                    ) : (
                      <>
                        <MorphNumber value={scan.modelCalls} /> model calls
                      </>
                    )}
                  </small>
                </dd>
              </div>
              <div>
                <dt>Estimated cost</dt>
                <dd>
                  {scan.cost ? <MorphNumber value={costLabel(scan.cost)} /> : "Unavailable"}
                  <small>
                    {scan.cost
                      ? scan.cost.complete
                        ? "USD · Saved model prices"
                        : "Partial estimate. Usage is missing or could not be priced."
                      : "Requires saved model prices and complete token usage."}
                  </small>
                </dd>
              </div>
            </dl>
          </section>
          <section>
            <h2>
              <Icon name="clock" /> Timeline
            </h2>
            <dl>
              <div>
                <dt>Started</dt>
                <dd>{date(scan.startedAt)}</dd>
              </div>
              <div>
                <dt>Finished</dt>
                <dd>
                  {scan.finishedAt
                    ? date(scan.finishedAt)
                    : running
                      ? "In progress"
                      : "Unavailable"}
                </dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}

/** "Discovery claude-x, default temperature, up to 8,192 output tokens" */
function samplingText(
  label: string,
  sampling: NonNullable<SecurityScan["reviews"][number]["generation"]>["discovery"],
): string {
  return `${label} ${sampling.model}, ${sampling.temperature === null ? "default temperature" : `temperature ${sampling.temperature}`}, ${sampling.maxOutputTokens === null ? "model output limit" : `up to ${sampling.maxOutputTokens.toLocaleString()} output tokens`}`;
}

const STOP_TEXT: Record<NonNullable<NonNullable<SecurityScan["coverage"]>["stop"]>, string> = {
  complete: "all source that fits a batch was sent",
  budget: "stopped at the limit",
  limit: `stopped at ${SCAN_BUDGET_LIMITS.fullBatches} batches`,
  quick: "one batch",
  explored: "the last exploring review read nothing new",
};

/**
 * The paths the static scan traced to an effect, and how the review closed each: the
 * list is the host's observation, the closure the model's account.
 */
function TracedPaths({ paths, findings }: { paths: ReviewPath[]; findings: ReviewFinding[] }) {
  if (!paths.length) return null;
  const closed = paths.filter((path) => path.closure !== "unclosed").length;
  return (
    <>
      <h3>Traced paths</h3>
      <p className="muted">
        {closed} of {paths.length} closed. The static scan traced these paths; the closures are the
        review's account.
      </p>
      <div className="security-stride-list">
        {paths.map((path) => {
          const finding = findings.find((item) => item.id === path.findingId);
          return (
            <details key={path.id}>
              <summary>
                <span>
                  {path.label}{" "}
                  <code>
                    {path.at.path}:{path.at.line}
                  </code>
                </span>
                <span className="security-status">{closureLabel[path.closure]}</span>
              </summary>
              <p className="muted">
                Reaches{" "}
                {path.effects
                  .map((effect) => `${effect.kind} at ${effect.path}:${effect.line}`)
                  .join(", ") || "an effect"}
                .
              </p>
              <p>{path.reason}</p>
              {finding && (
                <p className="muted">
                  Reported as {finding.title} · {finding.validation}
                </p>
              )}
              {path.evidence.length ? (
                <ul>
                  {path.evidence.map((cite) => (
                    <li key={JSON.stringify(cite)}>
                      <code>
                        {cite.path}:{cite.line}
                      </code>{" "}
                      {cite.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </details>
          );
        })}
      </div>
    </>
  );
}

/**
 * Candidates the second review dismissed, which the findings table leaves out: what each
 * dismissal rests on and the lines it cites. Earlier reviews saved no basis.
 */
function DismissedCandidates({ findings }: { findings: ReviewFinding[] }) {
  const dismissed = findings.filter((finding) => finding.validation === "dismissed");
  if (!dismissed.length) return null;
  return (
    <>
      <h3>Dismissed candidates</h3>
      <div className="security-stride-list">
        {dismissed.map((finding) => {
          const dismissal = finding.dismissal;
          const repeated = findings.find((item) => item.id === dismissal?.duplicateOf);
          return (
            <details key={finding.id}>
              <summary>
                <span>{finding.title}</span>
                <span className="security-status">
                  {dismissal ? dismissalLabel[dismissal.basis] : "Dismissed"}
                </span>
              </summary>
              <p>{finding.validationReason}</p>
              {repeated && <p className="muted">Repeats the candidate {repeated.title}.</p>}
              {dismissal?.evidence.length ? (
                <ul>
                  {dismissal.evidence.map((cite) => (
                    <li key={JSON.stringify(cite)}>
                      <code>
                        {cite.path}:{cite.line}
                      </code>{" "}
                      {cite.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </details>
          );
        })}
      </div>
    </>
  );
}

/** What each exploring session read and searched, and why it stopped. */
function ExplorationLog({ sessions }: { sessions: ExploreSessionRecord[] }) {
  return (
    <div className="security-exploration-log">
      {sessions.map((session) => (
        <div key={session.phase}>
          <h4>{session.phase === "discovery" ? "Discovery session" : "Second review session"}</h4>
          <p className="muted">
            Stopped {EXPLORE_STOPS[session.stop]} · {session.modelCalls}{" "}
            {session.modelCalls === 1 ? "model call" : "model calls"} ·{" "}
            {Object.entries(session.toolCalls)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, count]) => `${name} ${count}`)
              .join(", ") || "no tool calls"}{" "}
            · {Math.round(session.bytesReturned / 1024)} KiB returned
            {session.cutReplies ? ` · ${session.cutReplies} reply cut at the output limit` : ""}
            {session.rejected?.length
              ? ` · ${session.rejected.length} ${session.rejected.length === 1 ? "submission" : "submissions"} rejected`
              : ""}
          </p>
          <ul>
            {session.reads.map((read) => (
              <li key={read.path}>
                <code>{read.path}</code> ·{" "}
                {read.ranges
                  ? read.ranges.map((range) => `${range.line}-${range.endLine}`).join(", ")
                  : "whole file"}
              </li>
            ))}
          </ul>
          {session.searches.length ? (
            <ul>
              {session.searches.map((search) => (
                <li key={JSON.stringify(search)}>
                  Search <code>{search.query}</code>
                  {search.prefix ? (
                    <>
                      {" "}
                      under <code>{search.prefix}</code>
                    </>
                  ) : null}{" "}
                  · {search.matches} {search.matches === 1 ? "match" : "matches"}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Depth and mode, why batches stopped, and what the limit charged. */
function coverageNote(scan: SecurityScan): string {
  const coverage = scan.coverage;
  const explore = scan.mode === "explore";
  const parts: string[] = [SCAN_DEPTHS[scan.depth].label, ...(explore ? ["Explore"] : [])];
  if (scan.changes)
    parts.push(
      `changes since ${scan.changes.base} (${scan.changes.commit.slice(0, 7)}): ${scan.changes.files} ${scan.changes.files === 1 ? "file" : "files"} changed${scan.changes.removed ? `, ${scan.changes.removed} removed` : ""}`,
    );
  if (coverage?.stop)
    parts.push(
      explore && coverage.stop === "complete"
        ? "every file was read"
        : explore && coverage.stop === "quick"
          ? "the files the model chose to read"
          : STOP_TEXT[coverage.stop],
    );
  if (coverage && scan.budget)
    parts.push(
      scan.budget.kind === "tokens"
        ? `${coverage.charged.tokens.toLocaleString()} of ${scan.budget.tokens.toLocaleString()} tokens charged`
        : `USD ${(coverage.charged.usd ?? 0).toFixed(2)} of ${scan.budget.usd.toFixed(2)} charged`,
    );
  return parts.join(" · ");
}
