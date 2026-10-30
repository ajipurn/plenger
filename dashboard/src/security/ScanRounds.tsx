import { useState } from "react";
import { Link } from "react-router";
import type { SecurityScan } from "../../../src/dashboard/contract.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber, NumericText } from "../shared/MorphNumber.tsx";
import type { SourceCoverage } from "./coverage.ts";
import { phaseLabel } from "./ui.tsx";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/**
 * One row per round, newest first: what it covered, what it found, its time and tokens.
 * A running scan's current round leads with its latest step.
 */
export function ScanRounds({
  scan,
  coverage,
  limit,
  allPath,
}: {
  scan: SecurityScan;
  coverage: SourceCoverage;
  /** Finished rounds to list; the rest are behind `allPath`. */
  limit?: number;
  allPath?: string;
}) {
  // Motion marks rounds that finish while the page is open, not the ones it opened with.
  const [openedWith] = useState(scan.reviews.length);
  const current = scan.reviews.length;
  const steps = (scan.activity ?? []).filter((entry) => entry.batch === current);
  const latest = steps.at(-1);
  const live = scan.status === "running" && scan.workflow !== "static" && scan.phase !== "reading";
  const rounds = scan.reviews
    .map((review, index) => ({ review, index }))
    .reverse()
    .slice(0, limit);
  if (!live && !rounds.length) return null;
  return (
    <div className="security-rounds">
      <ol aria-label="Rounds">
        {live && (
          <li className="security-round" data-state="current">
            <div className="security-round-row">
              <span className="security-round-name">
                Round <MorphNumber value={current + 1} />
              </span>
              <span className="security-round-detail">
                <NumericText>{latest?.detail ?? phaseLabel[scan.phase]}</NumericText>
              </span>
              {/* Findings are counted when the round finishes. */}
              <span />
              <span className="muted">
                {steps[0] ? roundTime(Date.now() - new Date(steps[0].at).getTime()) : "Starting"}
              </span>
              <span className="muted">
                {latest ? (
                  <>
                    <MorphNumber
                      value={compact.format(
                        Math.max(0, latest.tokens - (scan.coverage?.charged.tokens ?? 0)),
                      )}
                    />{" "}
                    tokens
                  </>
                ) : null}
              </span>
            </div>
          </li>
        )}
        {rounds.map(({ review, index }) => {
          const round = coverage.rounds[index];
          const found = review.findings.filter((item) => item.validation !== "dismissed").length;
          const tokens = review.request.charged?.tokens ?? null;
          return (
            <li
              key={review.id}
              className="security-round"
              data-state={review.status === "completed" ? "finished" : "incomplete"}
              data-arrived={index >= openedWith || undefined}
            >
              <details>
                <summary className="security-round-row">
                  <span className="security-round-name">
                    Round <MorphNumber value={index + 1} />
                  </span>
                  <span className="security-round-detail">
                    <MorphNumber value={round?.files ?? review.scope.files.length} />{" "}
                    {(round?.files ?? review.scope.files.length) === 1 ? "file" : "files"}
                    {round && round.newFiles > 0 && (
                      <span className="muted">
                        {" "}
                        · <MorphNumber value={round.newFiles} /> new
                      </span>
                    )}
                    {review.status !== "completed" && (
                      <span className="security-status scan-failed">{review.status}</span>
                    )}
                  </span>
                  <span>
                    <MorphNumber value={found} /> {found === 1 ? "finding" : "findings"}
                  </span>
                  <span className="muted">{roundTime(review.request.durationMs)}</span>
                  <span className="muted">
                    {tokens === null ? (
                      "Not reported"
                    ) : (
                      <>
                        <MorphNumber value={compact.format(tokens)} /> tokens
                      </>
                    )}
                  </span>
                </summary>
                <ul className="security-round-files">
                  {review.scope.files.map((file) => (
                    <li key={file.path}>
                      <code>{file.path}</code>{" "}
                      <span className="muted">
                        <NumericText>
                          {file.ranges
                            ? `${file.ranges.reduce((sum, range) => sum + range.endLine - range.line + 1, 0)} of ${file.lines} lines`
                            : `${file.lines} lines`}
                        </NumericText>
                      </span>
                    </li>
                  ))}
                  {!review.scope.files.length && <li className="muted">No source was read.</li>}
                </ul>
              </details>
            </li>
          );
        })}
      </ol>
      {allPath && limit !== undefined && scan.reviews.length > limit && (
        <Link className="security-text-link" to={allPath}>
          <span>
            All <MorphNumber value={scan.reviews.length} /> rounds
          </span>
          <Icon name="arrow-right" />
        </Link>
      )}
    </div>
  );
}

/** "42s", "1m 04s", "1h 05m" */
function roundTime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
}
