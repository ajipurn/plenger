import { useId, useState } from "react";
import { Link } from "react-router";
import type { CampaignReport } from "../../../src/redteam/campaign.ts";
import { summarizeScope } from "../../../src/redteam/campaign-evidence.ts";
import { COMPARISON_MIN_EVALUABLE } from "../../../src/redteam/constants.ts";
import type { ProjectPlan } from "../../../src/redteam/plan.ts";
import { routes } from "../app/routes.ts";
import { RedteamResults } from "../redteam/RedteamResults.tsx";
import {
  RunAlert,
  RunSection,
  RunStatePill,
  RunStats,
  RunVerdict,
  StatePill,
} from "../redteam/RunLayout.tsx";
import {
  type BackendCheck,
  backendCheckCase,
  describeBackendCheck,
  hasWorkingControl,
  recommendedFix,
} from "../redteam/run-summary.ts";
import { percent, plural } from "../shared/format.ts";
import { Icon } from "../shared/icons.tsx";
import { isActiveRunState } from "../shared/runs.ts";
import { useElementScrollbars } from "../shared/ScrollArea.tsx";
import { SectionSummary } from "../shared/SectionSummary.tsx";
import { Select } from "../shared/ui.tsx";

interface BackendCheckGroup {
  tool: string;
  title: string;
  caseId: ReturnType<typeof backendCheckCase>;
  /** Repetitions in which the handler accepted the prohibited arguments. */
  accepted: number;
  checks: BackendCheck[];
  /** The check shown as evidence: an accepted one when any exists. */
  example: BackendCheck;
}

/** One entry per tool, so a missing safeguard reads the same for 1 or 20 repetitions. */
function groupBackendChecks(report: CampaignReport): BackendCheckGroup[] {
  const groups = new Map<string, BackendCheckGroup>();
  for (const run of report.runs)
    for (const check of run.backendChecks ?? []) {
      const caseId = backendCheckCase(check.tool);
      const group = groups.get(check.tool) ?? {
        tool: check.tool,
        title: report.plan.cases.find((item) => item.id === caseId)?.title ?? check.tool,
        caseId,
        accepted: 0,
        checks: [],
        example: check,
      };
      group.checks.push(check);
      if (check.outcome === "violation_observed") {
        if (!group.accepted) group.example = check;
        group.accepted++;
      }
      groups.set(check.tool, group);
    }
  return [...groups.values()];
}

function formatArguments(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
}

/** Handlers called with prohibited arguments and no model. Shown first when one accepted them. */
function DirectToolChecks({
  groups,
  repetitions,
}: {
  groups: BackendCheckGroup[];
  repetitions: number;
}) {
  const missing = groups.filter((group) => group.accepted > 0).length;
  return (
    <RunSection
      title="Direct tool checks"
      className="campaign-backend"
      aside={
        <span className={`tag ${missing ? "tag-issue" : ""}`}>
          {missing
            ? `${missing} ${plural(missing, "safeguard")} missing`
            : "Tested actions blocked"}
        </span>
      }
    >
      <p className="muted">
        Each original handler was called with prohibited arguments in disposable data, without the
        model. A safeguard missing here stays missing however the model responds. These checks are
        excluded from the model attack rates.
      </p>
      <ol className="campaign-checks" aria-label="Direct tool check results">
        {groups.map((group) => {
          const result = describeBackendCheck(group.example);
          return (
            <li className={`campaign-check run-tone-${result.tone}`} key={group.tool}>
              <div className="campaign-check-heading">
                <h5>{group.title}</h5>
                <code>{group.tool}</code>
              </div>
              <div className="campaign-check-outcome">
                <span className={`run-outcome run-tone-${result.tone}`}>{result.label}</span>
                {repetitions > 1 && (
                  <span className="muted">
                    accepted in {group.accepted} of {group.checks.length}{" "}
                    {plural(group.checks.length, "repetition")}
                  </span>
                )}
              </div>
              <p>{result.evidence}</p>
              <p className="campaign-check-arguments">
                <span>Arguments sent</span>
                {formatArguments(group.example.arguments)}
              </p>
              {group.accepted > 0 && group.caseId && (
                <p className="campaign-check-fix">
                  <strong>Recommended fix</strong>
                  {recommendedFix(group.caseId)}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </RunSection>
  );
}

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
  const backendGroups = groupBackendChecks(report);
  const backendViolations = backendGroups.filter((group) => group.accepted > 0).length;
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
  const minimum = report.plan.policy.minimumEvaluable;
  const weakGate = minimum < COMPARISON_MIN_EVALUABLE;
  const calls = report.budget?.callsAdmitted ?? 0;
  const tokens = report.budget?.accountedTokens ?? 0;
  return (
    <section className="panel run-results" aria-labelledby={`${id}-heading`}>
      <RunVerdict
        tone={tone}
        eyebrow="Repeated security tests"
        title={title}
        titleId={`${id}-heading`}
        description={
          issue
            ? modelViolations && backendViolations
              ? `${modelViolations} ${plural(modelViolations, "model attack")} produced a prohibited change and ${backendViolations} ${plural(backendViolations, "tool handler")} accepted one without the model. Review the evidence below.`
              : modelViolations
                ? `${modelViolations} ${plural(modelViolations, "model attack")} produced a prohibited change. Review the evidence below.`
                : `${backendViolations} ${plural(backendViolations, "tool handler")} accepted a prohibited change when called directly. The model made no prohibited change in these tests, so the policy is enforced only by the prompt. Review the evidence below.`
            : active
              ? "Each repetition starts with a normal task, followed by the selected attacks. The call, token and time limits cover the entire campaign."
              : incomplete
                ? "Some attacks lack usable evidence. Review the missing coverage and execution details before drawing a conclusion."
                : "The selected model made no prohibited change for these inputs. This result does not establish that the application is secure."
        }
        status={
          <>
            <RunStatePill state={report.state} />
            {!active && (
              <StatePill tone={report.gate.exitCode === 0 ? "success" : "error"} icon="gate">
                CI gate {report.gate.exitCode === 0 ? "passed" : "failed"}
              </StatePill>
            )}
          </>
        }
      />
      <RunStats
        live
        items={[
          { label: "Model", value: report.plan.model, note: report.plan.provider },
          {
            label: "Repetitions",
            value: `${finished} / ${report.plan.repetitions}`,
            note: "finished",
            meter: { value: finished, max: report.plan.repetitions },
          },
          {
            label: "Normal tasks",
            value: `${controls} / ${report.plan.repetitions}`,
            note: "passed",
          },
          {
            label: "Model calls",
            value: `${calls} / ${report.plan.limits.maxModelCalls}`,
            note: "admitted",
            meter: { value: calls, max: report.plan.limits.maxModelCalls },
          },
          {
            label: "Tokens",
            value: tokens.toLocaleString(),
            note: `accounted · ${report.plan.limits.maxTokens.toLocaleString()} limit`,
            meter: { value: tokens, max: report.plan.limits.maxTokens },
          },
        ]}
      />
      {(weakGate || error || outdated) && (
        <div className="run-alerts">
          {weakGate && (
            <RunAlert tone="warning">
              <strong>
                The CI gate accepts {minimum} usable {plural(minimum, "test")} per attack.
              </strong>{" "}
              At least {COMPARISON_MIN_EVALUABLE} are needed to estimate a rate, so a passing gate
              at this setting only shows that each attack made no prohibited change in {minimum}{" "}
              {plural(minimum, "test")}. Raise the minimum under CI gate requirements before relying
              on it.
            </RunAlert>
          )}
          {error && (
            <RunAlert tone="error">
              {error}{" "}
              <Link className="run-alert-link" to={routes.providers}>
                Check the saved model connection <Icon name="arrow-right" />
              </Link>
            </RunAlert>
          )}
          {outdated && (
            <RunAlert tone="warning">
              This result belongs to a different source snapshot or target. Run a new campaign to
              assess the current selection.
            </RunAlert>
          )}
        </div>
      )}
      {backendViolations > 0 && (
        <DirectToolChecks groups={backendGroups} repetitions={report.plan.repetitions} />
      )}
      <RunSection
        title="Attacks through the model"
        aside={
          <span className="tag">
            {report.statistics.length} {plural(report.statistics.length, "attack")}
          </span>
        }
      >
        <div className="campaign-table" ref={tableScrollbars}>
          <table>
            <caption className="sr-only">Attacks through the model</caption>
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
                        className={`run-count ${item.counts.violation_observed ? "run-tone-issue" : ""}`}
                      >
                        {item.counts.violation_observed}
                      </span>
                    </td>
                    <td>
                      <span className="run-ratio">
                        <span>
                          {item.evaluable} / {item.planned}
                        </span>
                        <span className="run-stat-meter" aria-hidden="true">
                          <span
                            style={{
                              width: `${(item.evaluable / Math.max(1, item.planned)) * 100}%`,
                            }}
                          />
                        </span>
                      </span>
                    </td>
                    <td className={missing ? "" : "muted"}>{missing}</td>
                    <td>
                      {item.rate === null || !item.interval ? (
                        <span className="muted">Not established</span>
                      ) : !item.comparisonEligible ? (
                        <>
                          <span className="muted">Too few tests to estimate</span>
                          <span className="campaign-cell-note">
                            {item.evaluable} of {COMPARISON_MIN_EVALUABLE} needed ·{" "}
                            {percent(item.interval.low)}–{percent(item.interval.high)}
                          </span>
                        </>
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
        <p className="run-footnote">
          <Icon name="info" />
          <span>
            Negative results require a completed attack and successful normal task. Observed changes
            remain evidence even if a test stops. Missing evidence includes inconclusive, failed and
            unstarted tests. Intervals use the Wilson method; at least {COMPARISON_MIN_EVALUABLE}{" "}
            usable tests per attack are needed to estimate a rate.
          </span>
        </p>
      </RunSection>
      {backendGroups.length > 0 && backendViolations === 0 && (
        <DirectToolChecks groups={backendGroups} repetitions={report.plan.repetitions} />
      )}
      <RunSection
        title="Discovered surfaces"
        className="run-surfaces"
        aside={
          <span className="run-ratio run-surface-ratio">
            <span>
              <strong>
                {scope.exercised} / {scope.discovered}
              </strong>{" "}
              exercised
            </span>
            <span className="run-stat-meter" aria-hidden="true">
              <span
                style={{ width: `${(scope.exercised / Math.max(1, scope.discovered)) * 100}%` }}
              />
            </span>
          </span>
        }
      >
        <p className="muted">
          <span className="sr-only">
            {scope.exercised} / {scope.discovered} discovered surfaces exercised.{" "}
          </span>
          {scope.unsupported} have no qualified adapter for model delivery in this profile.
          {scope.direct > 0 &&
            ` ${scope.direct} ${plural(scope.direct, "was", "were")} exercised by direct tool checks without a model.`}{" "}
          This is separate from the usable test counts above.
          {scope.incomplete
            ? " Discovery was incomplete or its completeness is unknown."
            : " Surfaces not discovered by the scanner remain unknown."}
        </p>
      </RunSection>
      <div className="run-disclosures">
        <details className="technical-disclosure run-disclosure">
          <SectionSummary
            icon="gate"
            title="Coverage and CI gate"
            description="Requirements, scope matrix and suppressions."
            meta={`Exit code ${report.gate.exitCode}`}
          />
          <div className="technical-content campaign-gate">
            <p>
              Exit code <strong>{report.gate.exitCode}</strong> · fail on{" "}
              {report.plan.policy.failOn} · required coverage{" "}
              {percent(report.plan.policy.minCoverage)} · minimum{" "}
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
                      {surface.kind ?? "input"} · {surface.label ?? surface.target} ·{" "}
                      {surface.caseId}
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
          <details className="technical-disclosure run-disclosure campaign-evidence">
            <SectionSummary
              icon="source-files"
              title="Evidence by repetition"
              description="Attack checks, normal task and technical evidence for each run."
              meta={`${report.runs.length} ${plural(report.runs.length, "repetition")}`}
            />
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
      </div>
    </section>
  );
}
