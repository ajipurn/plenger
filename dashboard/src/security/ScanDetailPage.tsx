import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  canContinue,
  EXPLORE_STOPS,
  type ExploreSessionRecord,
  findingValidation,
  type ImportedReaEvidence,
  type ReviewFinding,
  type ReviewPath,
  remainingBudget,
  SCAN_BUDGET_LIMITS,
  SCAN_DEPTHS,
  type ScanReply,
  SECURITY_POLL_MS,
  type SecurityScan,
  type SecurityWorkspace,
  type StaticReviewFinding,
} from "../../../src/dashboard/contract.ts";
import { SessionLinkError } from "../api/client.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { ReaEvidencePanel } from "../findings/ReaEvidencePanel.tsx";
import { errorMessage } from "../shared/async.ts";
import { downloadJson } from "../shared/download.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber, NumericText } from "../shared/MorphNumber.tsx";
import { Button } from "../shared/ui.tsx";
import { ContinueScan } from "./ContinueScan.tsx";
import { CoverageOverview, FolderCoverage } from "./CoverageOverview.tsx";
import { scanSourceCoverage } from "./coverage.ts";
import { RUNNING_SCAN_REASON } from "./running-scan.ts";
import { costDescription, hasBilling, ScanBilling, usdCounterLabel } from "./ScanBilling.tsx";
import { ScanProgress } from "./ScanProgress.tsx";
import { ScanRounds } from "./ScanRounds.tsx";
import {
  closureLabel,
  date,
  dismissalLabel,
  FindingsTable,
  legacyScanLabel,
  roundStatusLabel,
  ScanDuration,
  ScanStatus,
} from "./ui.tsx";
import { useSecurityEvents } from "./useSecurityEvents.ts";

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
  // Which end of the run was requested; cleared when the status changes, so a paused scan
  // can still be stopped and a scan continued on this page can pause or stop again.
  const [stopping, setStopping] = useState<"pause" | "stop" | null>(null);
  const [continuing, setContinuing] = useState(false);
  const scanStatus = scan?.status;
  useEffect(() => {
    if (scanStatus !== "running") setStopping(null);
  }, [scanStatus]);
  const [rea, setRea] = useState<ImportedReaEvidence[]>([]);
  const [billing, setBilling] = useState(false);
  const billingTrigger = useRef<HTMLButtonElement>(null);
  // Bumped to load the scan again: the service saved it, or the page restarted it.
  const [version, setVersion] = useState(0);
  const live = useSecurityEvents(api, scan?.status === "running", (event) => {
    if (event.id !== id) return;
    if (event.type === "scan") setVersion((value) => value + 1);
    else setScan((current) => current && withReply(current, event.reply));
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version loads the scan again
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
          // Pushed events replace polling; without them, poll while the scan runs.
          if (next.status === "running" && !live)
            timer = setTimeout(() => void load(), SECURITY_POLL_MS);
        }
      } catch (failure) {
        if (stopped) return;
        setError(errorMessage(failure, "Unable to load scan."));
        // A failed load of a live page tries again, slower; a lost session does not.
        if (!(failure instanceof SessionLinkError) && !live)
          timer = setTimeout(() => void load(), SECURITY_POLL_MS * 5);
      }
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, id, version, live]);
  if (!scan)
    return (
      <div className="security-empty" role={error ? "alert" : "status"}>
        {error || "Loading scan…"}
      </div>
    );
  const repository = data.repositories.find((item) => item.id === scan.repositoryId);
  const names = new Map(data.repositories.map((item) => [item.id, item.name]));
  const findings = scan.findings
    .filter((finding) => findingValidation(finding) !== "dismissed")
    .map((item) => ({
      ...item,
      status:
        data.findings.find(
          (current) => current.id === item.id || current.aliases?.includes(item.id),
        )?.status ?? item.status,
    }));
  const sourceCoverage = scanSourceCoverage(scan);
  // AI scans that know their eligible files show coverage first and list it by round.
  const coverage = scan.workflow !== "static" && sourceCoverage.total > 0;
  const outputs = params.get("tab") === "outputs";
  const coverageTab = coverage && params.get("tab") === "coverage";
  const running = scan.status === "running";
  // A paused scan can continue or be stopped for good; it is not finished yet.
  const paused = scan.status === "paused";
  const unfinished = running || paused;
  // Pause waits for the running round to end; Stop still ends the scan at once meanwhile.
  const pausing = running && (scan.pausing === true || stopping === "pause");
  // One scan runs at a time, so this one or another blocks starting a scan here.
  const anyRunning = data.scans.some((item) => item.status === "running");
  const projectContext = params.get("project") === scan.repositoryId;
  const projectPath = `/projects/${encodeURIComponent(scan.repositoryId)}`;
  const scanPath = `/scans/${encodeURIComponent(scan.id)}`;
  const findingsPath = projectContext
    ? `${scanPath}?project=${encodeURIComponent(scan.repositoryId)}`
    : scanPath;
  const outputsPath = `${findingsPath}${projectContext ? "&" : "?"}tab=outputs`;
  const coveragePath = `${findingsPath}${projectContext ? "&" : "?"}tab=coverage`;
  // A continued scan loads again, and the workspace sees that it runs.
  async function continued(next: SecurityScan) {
    setScan(next);
    setVersion((value) => value + 1);
    await onRefresh();
  }
  // A paused scan continues from the header under what is left of its limit; the paused
  // card below can set another limit first.
  async function continuePaused() {
    if (!api || !scan || continuing) return;
    setContinuing(true);
    try {
      await continued(await api.continueSecurityScan(scan.id, remainingBudget(scan) ?? undefined));
    } catch (failure) {
      setError(errorMessage(failure, "Unable to continue this scan."));
    } finally {
      setContinuing(false);
    }
  }
  // Pause ends the run after its round and Stop at once; only a paused scan can continue.
  // Stop also ends a paused scan, which then can no longer continue. Stop stays available
  // while a pause waits, and a pause saves nothing until it takes effect, so only Stop
  // refreshes the workspace.
  async function stop(kind: "pause" | "stop") {
    if (
      !api ||
      stopping === "stop" ||
      stopping === kind ||
      !(running || (kind === "stop" && paused))
    )
      return;
    setStopping(kind);
    try {
      if (kind === "pause") await api.pauseSecurityScan(scan?.id ?? "");
      else {
        await api.cancelSecurityScan(scan?.id ?? "");
        // A paused scan sends this page no events, so it loads again to show it stopped.
        if (paused) setVersion((value) => value + 1);
        await onRefresh();
      }
    } catch (failure) {
      setError(
        errorMessage(failure, kind === "pause" ? "Unable to pause scan." : "Unable to stop scan."),
      );
      setStopping(null);
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
            <span className="muted security-scan-duration">
              <ScanDuration scan={scan} />
            </span>
          </div>
          {/* The details panel waits for the scan to finish, so a running scan names its source here. */}
          <p className="muted security-scan-facts">
            {legacyScanLabel(scan) && <span>{legacyScanLabel(scan)}</span>}
            {scan.workflow !== "static" && (
              <span>
                {SCAN_DEPTHS[scan.depth].label}
                {scan.mode === "explore" ? " · Explore" : ""}
              </span>
            )}
            {running && scan.provider && (
              <span>
                {scan.provider.model} via {scan.provider.name}
              </span>
            )}
            {running && (
              <span>
                <code>{scan.revision.commit?.slice(0, 12) ?? "Local files"}</code>
              </span>
            )}
            <span>
              Started <MorphNumber value={date(scan.startedAt)} variant="text" />
            </span>
          </p>
          {scan.parentScanId && (
            <p className="muted">
              Continued from{" "}
              <Link to={`/scans/${encodeURIComponent(scan.parentScanId)}`}>saved static scan</Link>.
            </p>
          )}
        </div>
        <div className="security-scan-actions">
          {paused && (
            <Button
              className="button button-success"
              {...(anyRunning ? { title: RUNNING_SCAN_REASON } : {})}
              disabled={anyRunning || continuing || stopping !== null}
              onClick={() => void continuePaused()}
            >
              <Icon name="play" /> {continuing ? "Continuing…" : "Continue scan"}
            </Button>
          )}
          {running && scan.depth === "full" && (
            <Button
              className="button button-warning"
              disabled={stopping !== null || pausing}
              onClick={() => void stop("pause")}
            >
              <Icon name="pause" /> {pausing ? "Pausing after this round…" : "Pause scan"}
            </Button>
          )}
          {unfinished && (
            <Button
              className="button button-danger"
              disabled={stopping === "stop" || continuing}
              onClick={() => void stop("stop")}
            >
              <Icon name="stop" /> {stopping === "stop" ? "Stopping…" : "Stop scan"}
            </Button>
          )}
          <Button
            className="button button-secondary"
            onClick={() => downloadJson(`plenger-scan-${scan.id}.json`, scan)}
          >
            <Icon name="download" /> {unfinished ? "Export snapshot" : "Export JSON"}
          </Button>
          {!unfinished && (
            <Button
              className="button button-primary"
              {...(anyRunning ? { title: RUNNING_SCAN_REASON } : {})}
              disabled={anyRunning}
              onClick={() => onNewScan(scan.repositoryId)}
            >
              <Icon name="scan" /> Scan again
            </Button>
          )}
        </div>
      </header>
      {coverage && (
        <CoverageOverview
          scan={scan}
          coverage={sourceCoverage}
          findings={findings.length}
          note={!running && scan.coverage ? coverageNote(scan, sourceCoverage) : null}
        />
      )}
      <div
        className="security-detail-layout security-scan-layout"
        data-running={running || undefined}
      >
        <section className="security-detail-main">
          <nav className="security-subnav" aria-label="Scan detail">
            <Link aria-current={!outputs && !coverageTab ? "page" : undefined} to={findingsPath}>
              <Icon name="findings" /> Findings
              {(!running || findings.length > 0) && (
                <span className="security-count">
                  <MorphNumber value={findings.length} />
                </span>
              )}
            </Link>
            {coverage && (
              <Link aria-current={coverageTab ? "page" : undefined} to={coveragePath}>
                <Icon name="inventory" /> Coverage
              </Link>
            )}
            <Link aria-current={outputs ? "page" : undefined} to={outputsPath}>
              <Icon name="source-files" /> Outputs
            </Link>
          </nav>
          {/* The Coverage tab lists every round, the current one included. */}
          {running && !coverageTab && (
            <ScanProgress
              scan={scan}
              coverage={sourceCoverage}
              stopping={stopping === "stop"}
              pausing={pausing}
              roundsPath={coveragePath}
            />
          )}
          {!running && scan.workflow === "static" && (
            <section className="security-continue-scan" aria-labelledby="static-scan-result">
              <h2 id="static-scan-result">
                {scan.staticCompletedAt
                  ? "Static analysis complete"
                  : "Static analysis did not finish"}
              </h2>
              <p>
                AI discovery and validation were not run, so static candidates are Unvalidated. Scan
                again to run the full review.
              </p>
            </section>
          )}
          {canContinue(scan) && (
            <ContinueScan scan={scan} disabled={anyRunning} onContinued={continued} />
          )}
          {scan.status === "cancelled" && (
            <section
              className="security-continue-scan"
              data-tone="warning"
              aria-labelledby="scan-stopped"
            >
              <h2 id="scan-stopped">
                <Icon name="alert" /> Scan stopped
              </h2>
              <p className="muted">
                This scan stopped before the review finished and cannot continue. Findings from
                completed rounds are kept. Start a new scan to review the rest.
              </p>
            </section>
          )}
          {/* A stopped or paused scan says so above; older stopped scans kept a message. */}
          {scan.error && scan.status !== "cancelled" && scan.status !== "paused" && (
            <div role="alert" className="security-review-error">
              <Icon name="alert" />
              <div>
                <strong>
                  {scan.workflow === "static"
                    ? "Static analysis could not complete"
                    : "AI review could not complete"}
                </strong>
                <p>
                  {scan.workflow === "static"
                    ? "Review the error details and local folder before starting another scan."
                    : "The AI portion of this scan is incomplete. Review the details before starting another scan."}
                </p>
                <details className="security-error-details">
                  <summary>Show error details</summary>
                  <p>
                    <NumericText>{scan.error}</NumericText>
                  </p>
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
              <NumericText>{error}</NumericText>
            </p>
          )}
          {outputs ? (
            <div className="security-outputs">
              {scan.reviews.length ? (
                scan.reviews.map((review, index) => (
                  <section key={review.id} className="security-output-batch">
                    <h2>
                      Round <MorphNumber value={index + 1} />
                    </h2>
                    <RoundCoverageSummary coverage={sourceCoverage.rounds[index]} review={review} />
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
                                  {cite.path}:<MorphNumber value={String(cite.line)} />
                                </code>{" "}
                                {cite.message}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ))}
                    </div>
                    {!!review.scope.validation?.length && (
                      <details className="security-output-coverage">
                        <summary>Static validation source</summary>
                        <ul>
                          {review.scope.validation.map((file) => (
                            <li key={file.path}>
                              <code>{file.path}</code>
                              <NumericText>
                                {file.ranges
                                  ? `: ${file.ranges.map((range) => `${range.line}–${range.endLine}`).join(", ")}`
                                  : " (whole file)"}
                              </NumericText>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <TracedPaths paths={review.paths ?? []} findings={review.findings} />
                    <DismissedCandidates
                      findings={[...review.findings, ...(review.staticFindings ?? [])]}
                    />
                    <details className="security-output-coverage">
                      <summary>Source coverage and limitations</summary>
                      <p className="muted">
                        Captured{" "}
                        <MorphNumber value={date(review.scope.capturedAt)} variant="text" />. Source
                        may include working tree changes.
                        <NumericText>
                          {review.scope.budget
                            ? ` Up to ${Math.round(review.scope.budget.contextBytes / 1024)} KiB of source per round${review.scope.budget.inputTokens ? ` for a ${review.scope.budget.inputTokens.toLocaleString()}-token model window` : ""}.`
                            : ""}
                        </NumericText>
                      </p>
                      {review.generation && (
                        <p className="muted">
                          Prompt <code>{review.generation.promptDigest.slice(0, 12)}</code> ·{" "}
                          <NumericText>
                            {samplingText("Discovery", review.generation.discovery)}
                          </NumericText>
                          <NumericText>
                            {review.generation.validation
                              ? ` · ${samplingText("validation", review.generation.validation)}`
                              : ""}
                          </NumericText>
                        </p>
                      )}
                      <ul>
                        {review.scope.files.map((file) => (
                          <li key={file.path}>
                            <code>{file.path}</code> ·{" "}
                            <NumericText>
                              {file.ranges
                                ? `${file.ranges.reduce((sum, range) => sum + range.endLine - range.line + 1, 0)} of ${file.lines} lines, function excerpt`
                                : `${file.lines} lines`}
                            </NumericText>
                          </li>
                        ))}
                      </ul>
                      {review.scope.related?.length ? (
                        <>
                          <h4>Validation context</h4>
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
                    ? "Model outputs appear after each round finishes."
                    : scan.workflow === "static"
                      ? "AI discovery and validation were not run. Scan again to produce model outputs."
                      : "This scan has no AI outputs. Start a new scan with a saved provider to generate STRIDE and source analysis."}
                </p>
              )}
              {scan.reviews.length > 1 && (
                <p className="muted">
                  Each round is reviewed independently. Paths that cross rounds may need additional
                  context.
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
          ) : coverageTab ? (
            <div className="security-coverage-tab">
              <FolderCoverage scanId={scan.id} coverage={sourceCoverage} />
              <section aria-labelledby="scan-rounds">
                <h2 id="scan-rounds">Rounds</h2>
                <ScanRounds scan={scan} coverage={sourceCoverage} />
                {!scan.reviews.length && !running && <p className="muted">No round finished.</p>}
              </section>
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
        {!running && (
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
                    {scan.provider?.name ?? "None"}
                    <small>{scan.provider?.model}</small>
                  </dd>
                </div>
                <div>
                  <dt>Usage</dt>
                  <dd>
                    {scan.tokens === null ? (
                      "Not reported by provider"
                    ) : (
                      <>
                        <MorphNumber value={scan.tokens} /> tokens
                      </>
                    )}
                    <small>
                      {scan.workflow === "static" ? (
                        "Static analysis does not use a model."
                      ) : (
                        <>
                          <MorphNumber value={scan.modelCalls} /> model calls
                          {scan.tokensComplete === false &&
                            " · Some responses did not report usage."}
                        </>
                      )}
                    </small>
                  </dd>
                </div>
                <div>
                  <dt>Estimated cost</dt>
                  <dd>
                    {scan.cost ? (
                      <MorphNumber value={usdCounterLabel(scan.cost.totalUsd)} />
                    ) : scan.workflow === "static" ? (
                      "No model usage"
                    ) : (
                      "Unavailable"
                    )}
                    <small>
                      {scan.cost
                        ? costDescription(scan.cost)
                        : scan.workflow === "static"
                          ? "Static analysis runs locally without a provider."
                          : "Requires saved model prices and complete token usage."}
                    </small>
                  </dd>
                </div>
              </dl>
              {hasBilling(scan.reviews) && (
                <Button
                  ref={billingTrigger}
                  className="security-meta-action"
                  onClick={() => setBilling(true)}
                >
                  Usage by request <Icon name="arrow-right" />
                </Button>
              )}
            </section>
            <section>
              <h2>
                <Icon name="clock" /> Timeline
              </h2>
              <dl>
                <div>
                  <dt>Started</dt>
                  <dd>
                    <MorphNumber value={date(scan.startedAt)} variant="text" />
                  </dd>
                </div>
                <div>
                  <dt>Finished</dt>
                  <dd>
                    <MorphNumber
                      value={scan.finishedAt ? date(scan.finishedAt) : "Unavailable"}
                      variant="text"
                    />
                  </dd>
                </div>
              </dl>
            </section>
          </aside>
        )}
      </div>
      <ScanBilling
        reviews={scan.reviews}
        open={billing}
        onOpenChange={setBilling}
        returnFocus={() => billingTrigger.current}
      />
    </div>
  );
}

/** The scan with the reply a pushed event reports, or without one once it ends. */
function withReply(scan: SecurityScan, reply: ScanReply | null): SecurityScan {
  const { reply: _ended, ...rest } = scan;
  return reply ? { ...rest, reply } : rest;
}

/** "Discovery claude-x, default temperature, up to 8,192 output tokens" */
function samplingText(
  label: string,
  sampling: NonNullable<SecurityScan["reviews"][number]["generation"]>["discovery"],
): string {
  return `${label} ${sampling.model}, ${sampling.temperature === null ? "default temperature" : `temperature ${sampling.temperature}`}, ${sampling.maxOutputTokens === null ? "model output limit" : `up to ${sampling.maxOutputTokens.toLocaleString()} output tokens`}`;
}

// Complete and Quick scans describe what they read instead.
const STOP_TEXT: Record<
  Exclude<NonNullable<NonNullable<SecurityScan["coverage"]>["stop"]>, "complete" | "quick">,
  string
> = {
  budget: "stopped at the limit",
  limit: `stopped at ${SCAN_BUDGET_LIMITS.fullBatches} rounds`,
  explored: "the last round read nothing new",
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
        <MorphNumber value={closed} /> of <MorphNumber value={paths.length} /> closed. The static
        scan traced these paths; the closures are the review's account.
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
                    {path.at.path}:<MorphNumber value={String(path.at.line)} />
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
                        {cite.path}:<MorphNumber value={String(cite.line)} />
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
 * Candidates validation dismissed, which the findings table leaves out: what each
 * dismissal rests on and the lines it cites. Earlier reviews saved no basis.
 */
function DismissedCandidates({ findings }: { findings: (ReviewFinding | StaticReviewFinding)[] }) {
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
              {"static" in finding && <p className="muted">Static rule {finding.static.ruleId}</p>}
              <p>{finding.validationReason}</p>
              {repeated && <p className="muted">Repeats the candidate {repeated.title}.</p>}
              {dismissal?.evidence.length ? (
                <ul>
                  {dismissal.evidence.map((cite) => (
                    <li key={JSON.stringify(cite)}>
                      <code>
                        {cite.path}:<MorphNumber value={String(cite.line)} />
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
          <h4>{session.phase === "discovery" ? "Discovery session" : "Validation session"}</h4>
          <p className="muted">
            Stopped {EXPLORE_STOPS[session.stop]} · <MorphNumber value={session.modelCalls} />{" "}
            {session.modelCalls === 1 ? "model call" : "model calls"} ·{" "}
            <NumericText>
              {Object.entries(session.toolCalls)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, count]) => `${name} ${count}`)
                .join(", ") || "no tool calls"}
            </NumericText>{" "}
            · <MorphNumber value={Math.round(session.bytesReturned / 1024)} /> KiB returned
            <NumericText>
              {session.cutReplies ? ` · ${session.cutReplies} reply cut at the output limit` : ""}
            </NumericText>
            <NumericText>
              {session.rejected?.length
                ? ` · ${session.rejected.length} ${session.rejected.length === 1 ? "submission" : "submissions"} rejected`
                : ""}
            </NumericText>
          </p>
          <ul>
            {session.reads.map((read) => (
              <li key={read.path}>
                <code>{read.path}</code> ·{" "}
                <NumericText>
                  {read.ranges
                    ? read.ranges.map((range) => `${range.line}-${range.endLine}`).join(", ")
                    : "whole file"}
                </NumericText>
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
                  · <MorphNumber value={search.matches} />{" "}
                  {search.matches === 1 ? "match" : "matches"}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CoverageCounts({
  coverage,
}: {
  coverage: Pick<ReturnType<typeof scanSourceCoverage>, "read" | "partial" | "unread">;
}) {
  return (
    <>
      <MorphNumber value={coverage.read} /> read · <MorphNumber value={coverage.partial} /> partial
      · <MorphNumber value={coverage.unread} /> unread
    </>
  );
}

function RoundCoverageSummary({
  coverage,
  review,
}: {
  coverage: ReturnType<typeof scanSourceCoverage>["rounds"][number] | undefined;
  review: SecurityScan["reviews"][number];
}) {
  if (!coverage) return null;
  return (
    <>
      <p className="muted">
        Cumulative: <CoverageCounts coverage={coverage} />
      </p>
      <p className="muted">
        This round: <MorphNumber value={coverage.files} /> {coverage.files === 1 ? "file" : "files"}{" "}
        {review.mode === "explore" ? "read" : "included"}
        {coverage.newFiles > 0 && (
          <>
            {" "}
            · <MorphNumber value={coverage.newFiles} /> new
          </>
        )}
        {coverage.revisitedFiles > 0 && (
          <>
            {" "}
            · <MorphNumber value={coverage.revisitedFiles} /> revisited
          </>
        )}{" "}
        · {roundStatusLabel[review.status]}
        {review.validator ? ` · validation by ${review.validator.model}` : ""}
      </p>
    </>
  );
}

/**
 * Why a finished scan stopped and what it charged. `done` marks a scan that finished what
 * it set out to do, so a Quick scan with most files unread does not read as cut short.
 */
function coverageNote(
  scan: SecurityScan,
  source: ReturnType<typeof scanSourceCoverage>,
): { text: string; done: boolean } {
  const coverage = scan.coverage;
  const explore = scan.mode === "explore";
  const completed = scan.status === "completed";
  const readAll = source.unread === 0 && source.partial === 0;
  if (coverage?.stop === "quick") {
    const rest = source.unread;
    let text = `Quick scan complete: one round read ${explore ? "the files the model chose" : "the most important files"}.`;
    if (rest > 0)
      text += ` Full coverage reads the other ${rest.toLocaleString()} ${rest === 1 ? "file" : "files"}.`;
    return { text, done: completed };
  }
  const parts: string[] = [];
  if (coverage?.stop)
    parts.push(
      coverage.stop === "complete"
        ? readAll
          ? "every file was read in full"
          : source.unread > 0
            ? "some files were not read"
            : "some files were read in part"
        : STOP_TEXT[coverage.stop],
    );
  if (coverage && scan.budget)
    parts.push(
      scan.budget.kind === "tokens"
        ? `${coverage.charged.tokens.toLocaleString()} of ${scan.budget.tokens.toLocaleString()} tokens charged`
        : `USD ${(coverage.charged.usd ?? 0).toFixed(2)} of ${scan.budget.usd.toFixed(2)} charged`,
    );
  else if (coverage && scan.depth === "full")
    parts.push(`${coverage.charged.tokens.toLocaleString()} tokens charged, no limit`);
  const note = parts.join(" · ");
  return {
    text: note.charAt(0).toUpperCase() + note.slice(1),
    done:
      completed && (coverage?.stop === "explored" || (coverage?.stop === "complete" && readAll)),
  };
}
