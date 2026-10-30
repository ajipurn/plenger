import { useEffect, useState } from "react";
import { SCAN_DEPTHS, type SecurityScan } from "../../../src/dashboard/contract.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber, NumericText } from "../shared/MorphNumber.tsx";
import { folderCoverage, type ScanPace, type SourceCoverage, scanPace } from "./coverage.ts";
import { usdCounterLabel } from "./ScanBilling.tsx";

/**
 * How much of the source the rounds covered, where a running scan is heading, and one
 * cell per round the scan may run.
 */
export function CoverageOverview({
  scan,
  coverage,
  findings,
  note,
}: {
  scan: SecurityScan;
  coverage: SourceCoverage;
  findings: number;
  /** Why a finished scan stopped and what it charged. */
  note: string | null;
}) {
  const running = scan.status === "running";
  const pace = running ? scanPace(scan, coverage) : null;
  return (
    <section className="security-coverage" aria-label="Source coverage">
      <div className="security-coverage-heading">
        <p className="security-coverage-total">
          <strong>
            <MorphNumber value={coverage.total - coverage.unread} />
          </strong>
          {/* Its own line box, so the smaller numbers align with their text. */}
          <span>
            of <MorphNumber value={coverage.total} /> files covered
          </span>
        </p>
        {running && (
          <p className="muted">
            <MorphNumber value={findings} /> {findings === 1 ? "finding" : "findings"} so far
            {scan.tokens !== null && (
              <>
                {" "}
                · <MorphNumber value={scan.tokens} /> tokens
              </>
            )}
            {scan.cost && (
              <>
                {" "}
                · <MorphNumber value={usdCounterLabel(scan.cost.totalUsd)} />
              </>
            )}
          </p>
        )}
      </div>
      <CoverageBar
        segments={[coverage.read, coverage.partial]}
        total={coverage.total}
        className="security-coverage-bar"
      />
      <ul className="security-coverage-legend">
        <li data-state="read">
          <MorphNumber value={coverage.read} /> read
        </li>
        <li data-state="partial">
          <MorphNumber value={coverage.partial} /> partial
        </li>
        <li data-state="unread">
          <MorphNumber value={coverage.unread} /> unread
        </li>
      </ul>
      {pace ? (
        <PaceNote pace={pace} coverage={coverage} rounds={SCAN_DEPTHS[scan.depth].batches} />
      ) : (
        note && (
          <p className="security-coverage-note muted">
            <NumericText>{note}</NumericText>
          </p>
        )
      )}
      <RoundStrip scan={scan} coverage={coverage} />
    </section>
  );
}

/** Read and partial segments on one track, drawn in file units so no inline style is needed. */
function CoverageBar({
  segments: [read, partial],
  total,
  className,
}: {
  segments: [number, number];
  total: number;
  className: string;
}) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${Math.max(total, 1)} 1`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect width={read} height="1" data-state="read" />
      <rect x={read} width={partial} height="1" data-state="partial" />
    </svg>
  );
}

function PaceNote({
  pace,
  coverage,
  rounds,
}: {
  pace: ScanPace;
  coverage: SourceCoverage;
  rounds: number;
}) {
  if (pace.roundsNeeded === null)
    return (
      <p className="security-coverage-note muted">
        Recent rounds revisited files without covering new ones.
      </p>
    );
  const perRound = `About ${pace.newFiles < 10 ? pace.newFiles.toFixed(1) : Math.round(pace.newFiles)} new files per round.`;
  if (pace.roundsNeeded > pace.roundsLeft)
    return (
      <p className="security-coverage-note" data-tone="warning">
        <Icon name="alert" />
        <span>
          <NumericText>
            {`${perRound} At this pace the ${pace.limit === "rounds" ? `${rounds}-round limit` : "spending limit"} stops the scan near ${pace.projected} of ${coverage.total} files, in about ${waitText(pace.roundsLeft * pace.roundMs)}.`}
          </NumericText>
        </span>
      </p>
    );
  return (
    <p className="security-coverage-note muted">
      <NumericText>
        {`${perRound} The ${coverage.unread} unread files need about ${pace.roundsNeeded} more ${pace.roundsNeeded === 1 ? "round" : "rounds"}, roughly ${waitText(pace.roundsNeeded * pace.roundMs)}.`}
      </NumericText>
    </p>
  );
}

/** "3 min", "1 h 20 min" */
function waitText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

/** One cell per round the scan may run: finished, with findings, incomplete, current or left. */
function RoundStrip({ scan, coverage }: { scan: SecurityScan; coverage: SourceCoverage }) {
  const limit = SCAN_DEPTHS[scan.depth].batches;
  if (limit < 2) return null;
  const running = scan.status === "running" && scan.workflow !== "static";
  const cells = scan.reviews.map((review, index) => {
    const found = review.findings.filter((item) => item.validation !== "dismissed").length;
    const files = coverage.rounds[index]?.files ?? review.scope.files.length;
    return {
      state: review.status !== "completed" ? "incomplete" : found ? "found" : "finished",
      title: `Round ${index + 1} · ${files} ${files === 1 ? "file" : "files"} · ${found} ${found === 1 ? "finding" : "findings"}${review.status === "completed" ? "" : ` · ${review.status}`}`,
    };
  });
  if (running && cells.length < limit)
    cells.push({ state: "current", title: `Round ${cells.length + 1} · in progress` });
  const states = new Set(cells.map((cell) => cell.state));
  return (
    <div className="security-round-strip">
      <p>
        <span>Rounds</span>
        <span className="muted">
          {running ? "Round " : ""}
          <MorphNumber value={cells.length} />{" "}
          {running ? "" : cells.length === 1 ? "round " : "rounds "}
          of up to <MorphNumber value={limit} />
        </span>
      </p>
      <ol aria-hidden="true">
        {Array.from({ length: limit }, (_, index) => {
          const cell = cells[index];
          // Indexes are the rounds themselves, which never reorder.
          // biome-ignore lint/suspicious/noArrayIndexKey: one cell per round number
          return <li key={index} data-state={cell?.state ?? "left"} title={cell?.title} />;
        })}
      </ol>
      {(states.has("found") || states.has("incomplete")) && (
        <ul className="security-round-legend">
          <li data-state="finished">Finished</li>
          {states.has("found") && <li data-state="found">Found findings</li>}
          {states.has("incomplete") && <li data-state="incomplete">Did not complete</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * Each folder's eligible files, read, partial and unread. The list comes from the scan's
 * saved static scan; without one, only the files the rounds covered are listed.
 */
export function FolderCoverage({ scanId, coverage }: { scanId: string; coverage: SourceCoverage }) {
  const api = useApi();
  // Undefined while loading, null when the scan has no saved list.
  const [eligible, setEligible] = useState<string[] | null>();
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    api
      .scanSourceFiles(scanId, controller.signal)
      .then((files) => {
        if (!controller.signal.aborted) setEligible(files.paths);
      })
      .catch(() => {
        if (!controller.signal.aborted) setEligible(null);
      });
    return () => controller.abort();
  }, [api, scanId]);
  const folders = folderCoverage(coverage.files, eligible ?? null);
  const largest = Math.max(1, ...folders.map((folder) => folder.read + folder.partial));
  return (
    <section className="security-folder-coverage" aria-labelledby="folder-coverage">
      <h2 id="folder-coverage">Coverage by folder</h2>
      <p className="muted">
        <NumericText>
          {coverage.unread === 0
            ? "Every eligible file was covered."
            : eligible === null
              ? `${coverage.unread} ${coverage.unread === 1 ? "file was" : "files were"} not read. This scan has no saved file list, so only covered files are listed.`
              : `${coverage.unread} of ${coverage.total} files have not been read.`}
        </NumericText>
      </p>
      {folders.length ? (
        <ul>
          {folders.map((folder) => (
            <li key={folder.folder}>
              <code>{folder.folder === "." ? "Project root" : `${folder.folder}/`}</code>
              <CoverageBar
                segments={[folder.read, folder.partial]}
                total={eligible ? folder.read + folder.partial + folder.unread : largest}
                className="security-folder-bar"
              />
              <span className="muted">
                <NumericText>
                  {[
                    folder.read && `${folder.read} read`,
                    folder.partial && `${folder.partial} partial`,
                    folder.unread && `${folder.unread} unread`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </NumericText>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No round has covered a file yet.</p>
      )}
    </section>
  );
}
