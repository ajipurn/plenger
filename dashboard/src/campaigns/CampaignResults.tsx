import { useId, useState } from "react";
import { Link } from "react-router";
import type { CampaignReport } from "../../../src/redteam/campaign.ts";
import { summarizeScope } from "../../../src/redteam/campaign-evidence.ts";
import type { ProjectPlan } from "../../../src/redteam/plan.ts";
import { routes } from "../app/routes.ts";
import { RedteamResults } from "../redteam/RedteamResults.tsx";
import { hasWorkingControl } from "../redteam/run-summary.ts";
import { percent, plural } from "../shared/format.ts";
import { Icon } from "../shared/icons.tsx";
import { isActiveRunState } from "../shared/runs.ts";
import { useElementScrollbars } from "../shared/ScrollArea.tsx";
import { Select } from "../shared/ui.tsx";

/** Campaign totals stay separate from the evidence for each model invocation. */
export function CampaignResults({ report, plan }: { report: CampaignReport; plan: ProjectPlan }) {
  const id = useId();
  const [selected, setSelected] = useState("");
  const tableScrollbars = useElementScrollbars<HTMLDivElement>("x");
  const run = report.runs.find((item) => item.id === selected) ?? report.runs.at(-1);
  const active = isActiveRunState(report.state);
  const modelViolations = report.statistics.reduce(
    (sum, item) => sum + item.counts.violation_observed,
    0,
  );
  const backendViolations = report.runs
    .flatMap((item) => item.backendChecks ?? [])
    .filter((item) => item.outcome === "violation_observed").length;
  const issue = modelViolations + backendViolations > 0;
  const incomplete = report.gate.reasons.some((item) => item.kind !== "finding");
  const title = issue
    ? "A tested policy boundary was crossed"
    : active
      ? "Security tests are running"
      : incomplete
        ? "The test did not establish a complete result"
        : "No violations observed in these tests";
  const tone = issue ? "issue" : active || incomplete ? "warning" : "neutral";
  const finished = report.runs.filter((item) => !!item.finishedAt).length;
  const controls = report.runs.filter(hasWorkingControl).length;
  const error = report.runs.find((item) => item.error)?.error;
  const outdated =
    report.plan.sourceDigest !== plan.sourceDigest || report.plan.target !== plan.selectedTarget;
  const scope = summarizeScope(report);
  return (
    <section className="panel run-results" aria-labelledby={`${id}-heading`}>
      <div className={`run-verdict run-tone-${tone}`}>
        <span className="run-verdict-icon">
          <Icon name={issue ? "findings" : "redteam"} />
        </span>
        <div>
          <p className="eyebrow">Repeated security tests</p>
          <h3 id={`${id}-heading`}>{title}</h3>
          <p>
            {issue
              ? `${modelViolations} ${plural(modelViolations, "model attack")} and ${backendViolations} ${plural(backendViolations, "direct tool check")} produced a prohibited change. Review the evidence below.`
              : active
                ? "Each repetition starts with a normal task, followed by the selected attacks. The call, token and time limits cover the entire campaign."
                : incomplete
                  ? "Some attacks lack usable evidence. Review the missing coverage and execution details before drawing a conclusion."
                  : "The selected model made no prohibited change for these inputs. This result does not establish that the application is secure."}
          </p>
        </div>
      </div>
      <div className="run-metadata" role="status">
        <span>
          Process: <strong>{report.state}</strong>
        </span>
        <span>
          {report.plan.provider} · <strong>{report.plan.model}</strong>
        </span>
        <span>
          {finished} / {report.plan.repetitions} repetitions finished
        </span>
        <span>{controls} normal tasks passed</span>
        <span>
          {report.budget?.callsAdmitted ?? 0} / {report.plan.limits.maxModelCalls} model calls
        </span>
        <span>{(report.budget?.accountedTokens ?? 0).toLocaleString()} accounted tokens</span>
      </div>
      {outdated && (
        <p className="run-context-note">
          This result belongs to a different source snapshot or target. Run a new campaign to assess
          the current selection.
        </p>
      )}
      {error && (
        <p className="run-context-note">
          {error} <Link to={routes.providers}>Check the saved model connection</Link>.
        </p>
      )}
      <div className="campaign-table" ref={tableScrollbars}>
        <table>
          <caption>Attacks through the model</caption>
          <thead>
            <tr>
              <th scope="col">Attack</th>
              <th scope="col">Violations</th>
              <th scope="col">Usable tests</th>
              <th scope="col">Missing evidence</th>
              <th scope="col">Observed rate · 95% interval</th>
            </tr>
          </thead>
          <tbody>
            {report.statistics.map((item) => {
              const missing = item.counts.inconclusive + item.counts.error + item.counts.skipped;
              return (
                <tr key={item.caseId}>
                  <th scope="row">
                    {report.plan.cases.find((c) => c.id === item.caseId)?.title ?? item.caseId}
                  </th>
                  <td>
                    <span
                      className={`run-outcome ${item.counts.violation_observed ? "run-tone-issue" : ""}`}
                    >
                      {item.counts.violation_observed}
                    </span>
                  </td>
                  <td>
                    {item.evaluable} / {item.planned}
                  </td>
                  <td>{missing}</td>
                  <td>
                    {item.rate === null || !item.interval ? (
                      "Not established"
                    ) : (
                      <>
                        <strong>{percent(item.rate)}</strong>
                        <span className="campaign-cell-note">
                          {percent(item.interval.low)}–{percent(item.interval.high)}
                        </span>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted campaign-explanation">
        Negative results require a completed attack and successful normal task. Observed changes
        remain evidence even if a test stops. Missing evidence includes inconclusive, failed and
        unstarted tests. Intervals use the Wilson method; at least 20 usable tests per attack are
        needed for comparison.
      </p>
      <p className="run-context-note">
        <strong>
          {scope.exercised} / {scope.discovered} discovered surfaces exercised.
        </strong>{" "}
        {scope.unsupported} have no qualified adapter in this profile. This is separate from the
        usable test counts above.
        {scope.incomplete
          ? " Discovery was incomplete or its completeness is unknown."
          : " Surfaces not discovered by the scanner remain unknown."}
      </p>
      {backendViolations > 0 && (
        <div className="run-context-note">
          <strong>Direct tool checks found a missing policy boundary.</strong> Original handlers
          accepted prohibited test arguments in disposable data, independently of the model. These
          checks are excluded from the model attack rates.
        </div>
      )}
      <details className="technical-disclosure">
        <summary className="disclosure-heading">
          Coverage and CI gate <Icon name="chevron" />
        </summary>
        <div className="technical-content campaign-gate">
          <p>
            Exit code <strong>{report.gate.exitCode}</strong> · fail on {report.plan.policy.failOn}{" "}
            · required coverage {percent(report.plan.policy.minCoverage)} · minimum{" "}
            {report.plan.policy.minimumEvaluable} usable tests per attack.
          </p>
          {report.gate.reasons.length ? (
            <ul>
              {report.gate.reasons.map((reason) => (
                <li key={`${reason.kind}:${reason.message}`}>{reason.message}</li>
              ))}
            </ul>
          ) : (
            <p>The configured requirements passed for the selected scope.</p>
          )}
          <p className="muted">
            The matrix retains discovered input, tool, MCP, web and retrieval scenarios, including
            unsupported and unselected entries. A successful input test does not qualify the other
            tools or production resources.
          </p>
          <ul className="campaign-scope-list">
            {report.plan.scope.map((surface) => {
              const stats = report.statistics.find((item) => item.caseId === surface.caseId);
              const tested = surface.selected && surface.supported && !!stats?.evaluable;
              return (
                <li key={surface.id}>
                  <strong>
                    {surface.kind ?? "input"} · {surface.label ?? surface.target} · {surface.caseId}
                  </strong>
                  <span>
                    {tested
                      ? `${stats.evaluable} usable tests`
                      : surface.selected
                        ? "Required evidence missing"
                        : "Outside this campaign"}
                    {surface.reason ? ` · ${surface.reason}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          {report.plan.policy.suppressions.map((item) => (
            <p key={item.caseId}>
              Suppressed {item.caseId}: {item.reason}
            </p>
          ))}
        </div>
      </details>
      {run && (
        <details className="technical-disclosure campaign-evidence">
          <summary className="disclosure-heading">
            Evidence by repetition <Icon name="chevron" />
          </summary>
          <label className="run-history-label" htmlFor={`${id}-repetition`}>
            Repetition
            <Select
              id={`${id}-repetition`}
              value={run.id}
              onValueChange={setSelected}
              items={report.runs.map((item, index) => ({
                value: item.id,
                label: `${index + 1} · ${item.state} · ${hasWorkingControl(item) ? "normal task passed" : "normal task not established"}`,
              }))}
            />
          </label>
          <RedteamResults embedded report={run} plan={plan} />
        </details>
      )}
    </section>
  );
}
