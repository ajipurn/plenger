import { type CSSProperties, useEffect, useState } from "react";
import type { CampaignReport } from "../../../src/redteam/campaign.ts";
import type { RedteamRun, RunEvent, RunTrial } from "../../../src/redteam/run.ts";
import { RunSection } from "../redteam/RunLayout.tsx";
import {
  explainRunError,
  hasWorkingControl,
  modelResult,
  trialTitle,
} from "../redteam/run-summary.ts";
import { formatDuration, plural } from "../shared/format.ts";
import { Icon, type IconName } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { isActiveRunState } from "../shared/runs.ts";
import { useElementScrollbars } from "../shared/ScrollArea.tsx";
import { Button } from "../shared/ui.tsx";

/** How one check of one repetition is drawn in the matrix. */
type CellState = "pending" | "running" | "clear" | "violation" | "inconclusive" | "skipped";

interface MatrixCell {
  key: string;
  repetition: number;
  state: CellState;
  label: string;
  runId: string | null;
}

interface MatrixRow {
  id: string;
  title: string;
  /** Model checks count toward the finished total; direct tool checks do not. */
  counted: boolean;
  cells: MatrixCell[];
}

const LEGEND: { state: CellState; label: string }[] = [
  { state: "pending", label: "Not started" },
  { state: "running", label: "Running" },
  { state: "clear", label: "Completed, no violation" },
  { state: "violation", label: "Violation observed" },
  { state: "inconclusive", label: "No conclusion" },
];
const FINISHED_STATES: CellState[] = ["clear", "violation", "inconclusive"];
const FEED_LENGTH = 6;
const FINAL_ICONS: Record<"completed" | "stopped" | "failed", IconName> = {
  completed: "check",
  stopped: "alert",
  failed: "error",
};

/** Ticks once a second while `enabled`, so elapsed time moves between polls. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function plannedCell(repetition: number, campaignActive: boolean): MatrixCell {
  return {
    key: `planned-${repetition}`,
    repetition,
    state: campaignActive ? "pending" : "skipped",
    label: campaignActive ? "Not started" : "Not run",
    runId: null,
  };
}

function trialCell(run: RedteamRun, trial: RunTrial | undefined, repetition: number): MatrixCell {
  const cell = (state: CellState, label: string): MatrixCell => ({
    key: run.id,
    repetition,
    state,
    label,
    runId: run.id,
  });
  const active = isActiveRunState(run.state);
  if (!trial?.started)
    return cell(active ? "pending" : "skipped", active ? "Not started" : "Not run");
  if (trial.purpose === "control") {
    if (!trial.completed && active) return cell("running", "In progress");
    return hasWorkingControl(run)
      ? cell("clear", "Normal task passed")
      : cell("inconclusive", "Normal task not established");
  }
  const result = modelResult(run, trial);
  if (result.tone === "issue") return cell("violation", result.label);
  if (!trial.completed && active) return cell("running", "In progress");
  if (result.tone === "warning") return cell("inconclusive", result.label);
  return cell("clear", result.label);
}

function backendCell(run: RedteamRun, repetition: number): MatrixCell {
  const cell = (state: CellState, label: string): MatrixCell => ({
    key: run.id,
    repetition,
    state,
    label,
    runId: run.id,
  });
  const active = isActiveRunState(run.state);
  const checks = run.backendChecks;
  if (!checks) return cell(active ? "pending" : "skipped", active ? "Not started" : "Not run");
  if (checks.some((check) => check.outcome === "violation_observed"))
    return cell("violation", "Safeguard missing");
  if (checks.length < 2 && active) return cell("running", "Calling the handlers");
  if (checks.length === 2 && checks.every((check) => check.outcome === "not_observed"))
    return cell("clear", "Tested actions blocked");
  return cell("inconclusive", "No conclusion");
}

/** One row per check, one cell per planned repetition; unstarted repetitions stay visible. */
function buildRows(report: CampaignReport): MatrixRow[] {
  const active = isActiveRunState(report.state);
  const repetitions = Array.from({ length: report.plan.repetitions }, (_, index) => index + 1);
  const runAt = (repetition: number) => report.runs[repetition - 1];
  const rows: MatrixRow[] = [];
  if (report.plan.profile === "vercel-booking-sqlite-v1")
    rows.push({
      id: "direct-tool-checks",
      title: "Direct tool checks",
      counted: false,
      cells: repetitions.map((repetition) => {
        const run = runAt(repetition);
        return run ? backendCell(run, repetition) : plannedCell(repetition, active);
      }),
    });
  rows.push({
    id: "clean-control",
    title: "Normal task",
    counted: true,
    cells: repetitions.map((repetition) => {
      const run = runAt(repetition);
      return run
        ? trialCell(
            run,
            run.trials.find((trial) => trial.purpose === "control"),
            repetition,
          )
        : plannedCell(repetition, active);
    }),
  });
  for (const item of report.plan.cases)
    rows.push({
      id: item.id,
      title: item.title,
      counted: true,
      cells: repetitions.map((repetition) => {
        const run = runAt(repetition);
        return run
          ? trialCell(
              run,
              run.trials.find((trial) => trial.id === item.id),
              repetition,
            )
          : plannedCell(repetition, active);
      }),
    });
  return rows;
}

function describeEvent(event: RunEvent): {
  icon: IconName;
  text: string;
  tool?: string | undefined;
} {
  switch (event.stage) {
    case "model_tool_proposal":
      return { icon: "llm-calls", text: "Model proposed", tool: event.tool };
    case "tool_handler_entered":
      return { icon: "tools", text: "Handler entered", tool: event.tool };
    case "tool_handler_returned":
      return { icon: "tools", text: "Handler returned", tool: event.tool };
    default:
      return {
        icon: event.boundary === "forbidden" && event.markerPresent ? "findings" : "redteam",
        text: `Canary checked: ${event.boundary} file ${event.markerPresent ? "written" : "untouched"}`,
      };
  }
}

interface Activity {
  title: string;
  detail: string;
  /** The trial whose events the feed shows, while one is in progress. */
  trial: RunTrial | null;
}

/** What the campaign is doing right now, or how it ended. */
function describeActivity(report: CampaignReport): Activity {
  const total = report.plan.repetitions;
  if (!isActiveRunState(report.state)) {
    const detail = report.runs.every((run) => run.cleanupConfirmed)
      ? "Every worker container was removed."
      : "Worker cleanup could not be confirmed for every repetition.";
    if (report.state === "completed")
      return {
        title: `Completed ${total} ${plural(total, "repetition")}`,
        detail,
        trial: null,
      };
    const verb = report.state === "stopped" ? "Stopped" : "Failed";
    const completed = report.runs.filter((run) => run.state === "completed").length;
    // A repetition that ended in the same state as the campaign was cut off mid-way.
    const interrupted = report.runs.some((run) => run.state !== "completed");
    return {
      title: interrupted
        ? `${verb} during repetition ${report.runs.length} of ${total}`
        : `${verb} after ${completed} of ${total} ${plural(total, "repetition")}`,
      detail: report.runs.map(explainRunError).find((item) => item !== null)?.message ?? detail,
      trial: null,
    };
  }
  const run = report.runs.find((item) => isActiveRunState(item.state));
  if (!run)
    return {
      title: `Starting repetition ${Math.min(total, report.runs.length + 1)} of ${total}`,
      detail: "Preparing the test environment.",
      trial: null,
    };
  const repetition = report.runs.indexOf(run) + 1;
  const prefix = `Repetition ${repetition} of ${total}`;
  if (run.state === "preparing")
    return {
      title: `${prefix} · preparing the environment`,
      detail:
        repetition === 1
          ? "Capturing the source snapshot and preparing the pinned runtime image. The first build of a profile can take several minutes."
          : "Capturing the source snapshot and starting the pinned runtime.",
      trial: null,
    };
  const trial = run.trials.find((item) => item.started && !item.completed);
  if (trial) {
    const probes = run.trials.filter((item) => item.purpose === "probe");
    const position =
      trial.purpose === "control"
        ? "normal task"
        : `attack ${probes.indexOf(trial) + 1} of ${probes.length}: ${trialTitle(trial)}`;
    const last = trial.events.at(-1);
    const status =
      (report.budget?.callsInFlight ?? 0) > 0
        ? "waiting for the model"
        : last
          ? `${describeEvent(last).text}${last.tool ? ` ${last.tool}` : ""}`
          : trial.workerName
            ? "worker started, waiting for its first observation"
            : "starting the worker";
    return {
      title: `${prefix} · ${position}`,
      detail: `${trial.modelCalls} ${plural(trial.modelCalls, "model call")} · ${status}`,
      trial,
    };
  }
  if (
    run.profile === "vercel-booking-sqlite-v1" &&
    !run.trials.some((item) => item.started) &&
    (run.backendChecks?.length ?? 0) < 2
  )
    return {
      title: `${prefix} · direct tool checks`,
      detail: "Calling the original handlers with prohibited arguments, without the model.",
      trial: null,
    };
  return { title: `${prefix} · starting the next check`, detail: "", trial: null };
}

/** Live view of a campaign: current activity, time against the deadline, the repetition matrix and the latest worker events. */
export function CampaignProgress({
  report,
  selectedRunId,
  onSelectRepetition,
}: {
  report: CampaignReport;
  /** The repetition whose evidence is open, if any. */
  selectedRunId?: string | undefined;
  onSelectRepetition: (runId: string) => void;
}) {
  const active = isActiveRunState(report.state);
  const now = useNow(active);
  const scrollbars = useElementScrollbars<HTMLDivElement>("x");
  const rows = buildRows(report);
  const counted = rows.filter((row) => row.counted).flatMap((row) => row.cells);
  const finished = counted.filter((cell) => FINISHED_STATES.includes(cell.state)).length;
  const hasSkipped = rows.some((row) => row.cells.some((cell) => cell.state === "skipped"));
  const activity = describeActivity(report);
  const startedAt = Date.parse(report.createdAt);
  const endedAt = active ? now : Date.parse(report.finishedAt ?? report.createdAt);
  const elapsed = Math.max(0, endedAt - startedAt);
  const deadline = report.plan.limits.timeoutMs;
  const repetitions = report.plan.repetitions;
  const cellSize = repetitions <= 12 ? 16 : repetitions <= 40 ? 12 : 9;
  const numbered = (repetition: number) =>
    repetitions <= 25 || repetition === 1 || repetition % 5 === 0;
  const feed = activity.trial?.events.slice(-FEED_LENGTH) ?? [];
  const earlier = (activity.trial?.events.length ?? 0) - feed.length;
  return (
    <RunSection
      title="Progress"
      className="run-progress"
      aside={
        <span className="tag">
          <MorphNumber value={finished} />
          {`of ${counted.length} ${plural(counted.length, "check")} finished`}
        </span>
      }
    >
      <div className="run-progress-status">
        <div className="run-progress-activity">
          {active ? (
            <span className="run-progress-dot" aria-hidden="true" />
          ) : (
            <span className={`run-progress-final is-${report.state}`} aria-hidden="true">
              <Icon
                name={
                  FINAL_ICONS[
                    report.state === "completed"
                      ? "completed"
                      : report.state === "stopped"
                        ? "stopped"
                        : "failed"
                  ]
                }
              />
            </span>
          )}
          <div role="status">
            <strong>{activity.title}</strong>
            {activity.detail && <p>{activity.detail}</p>}
          </div>
        </div>
        <div className="run-progress-time">
          <span className="run-progress-time-row">
            <span>
              <strong>{formatDuration(elapsed)}</strong> {active ? "elapsed" : "in total"}
            </span>
            <span>{formatDuration(deadline)} deadline</span>
          </span>
          <span className="run-stat-meter" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (elapsed / Math.max(1, deadline)) * 100)}%` }} />
          </span>
        </div>
      </div>
      <div className="run-matrix-card">
        <div className="run-matrix-scroll" ref={scrollbars}>
          <table className="run-matrix" style={{ "--run-cell": `${cellSize}px` } as CSSProperties}>
            <caption className="sr-only">Checks by repetition</caption>
            <thead>
              <tr>
                <th scope="col" className="run-matrix-check">
                  Check
                </th>
                {rows[0]?.cells.map((cell) => (
                  <th
                    scope="col"
                    key={cell.key}
                    className={
                      cell.runId !== null && cell.runId === selectedRunId ? "is-selected" : ""
                    }
                  >
                    <span className={numbered(cell.repetition) ? "" : "sr-only"}>
                      {cell.repetition}
                    </span>
                  </th>
                ))}
                <th scope="col" className="run-matrix-summary">
                  Summary
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const done = row.cells.filter((cell) =>
                  FINISHED_STATES.includes(cell.state),
                ).length;
                const violations = row.cells.filter((cell) => cell.state === "violation").length;
                return (
                  <tr key={row.id}>
                    <th scope="row" className="run-matrix-check">
                      <span className="run-matrix-label" title={row.title}>
                        {row.title}
                      </span>
                      {!row.counted && <span className="run-matrix-note">Without the model</span>}
                    </th>
                    {row.cells.map((cell) => {
                      const selected = cell.runId !== null && cell.runId === selectedRunId;
                      const description = `Repetition ${cell.repetition}, ${row.title}: ${cell.label}`;
                      return (
                        <td key={cell.key} className={selected ? "is-selected" : ""}>
                          {cell.runId ? (
                            <Button
                              className={`run-cell is-${cell.state}`}
                              title={cell.label}
                              aria-label={description}
                              aria-pressed={selected}
                              onClick={() => {
                                if (cell.runId) onSelectRepetition(cell.runId);
                              }}
                            />
                          ) : (
                            <span className={`run-cell is-${cell.state}`} title={cell.label}>
                              <span className="sr-only">{description}</span>
                            </span>
                          )}
                        </td>
                      );
                    })}
                    <td className="run-matrix-summary">
                      <span className="run-matrix-done">
                        {done} / {row.cells.length}
                      </span>
                      {violations > 0 && (
                        <span className="run-matrix-violations">
                          {violations} {plural(violations, "violation")}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ul className="run-matrix-legend" aria-label="Legend">
          {LEGEND.map((item) => (
            <li key={item.state}>
              <span className={`run-cell is-${item.state}`} aria-hidden="true" />
              {item.label}
            </li>
          ))}
          {hasSkipped && (
            <li>
              <span className="run-cell is-skipped" aria-hidden="true" />
              Not run
            </li>
          )}
          <li className="run-matrix-hint">Select a repetition to open its evidence.</li>
        </ul>
      </div>
      {active && activity.trial && (
        <div className="run-feed">
          <div className="run-feed-heading">
            <span>Latest worker events · {trialTitle(activity.trial)}</span>
            {earlier > 0 && (
              <span>
                {earlier} earlier {plural(earlier, "event")}
              </span>
            )}
          </div>
          {feed.length === 0 ? (
            <p className="muted">Waiting for the worker to report its first observation.</p>
          ) : (
            <ol>
              {feed.map((event, index) => {
                const described = describeEvent(event);
                return (
                  <li key={event.sequence} className={index === feed.length - 1 ? "is-latest" : ""}>
                    <span className="run-feed-sequence">#{event.sequence}</span>
                    <Icon name={described.icon} />
                    <span>
                      {described.text}
                      {described.tool && (
                        <>
                          {" "}
                          <code>{described.tool}</code>
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </RunSection>
  );
}
