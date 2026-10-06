import { useId } from "react";
import type { ProjectPlan } from "../../../src/redteam/plan.ts";
import type { RedteamRun } from "../../../src/redteam/run.ts";
import { plural } from "../shared/format.ts";
import { Icon } from "../shared/icons.tsx";
import { RunEvidence } from "./RunEvidence.tsx";
import {
  RunAlert,
  RunSection,
  RunStatePill,
  RunStats,
  RunVerdict,
  StatePill,
} from "./RunLayout.tsx";
import {
  backendResult,
  hasWorkingControl,
  modelResult,
  recommendedFix,
  summarizeRun,
  trialTitle,
} from "./run-summary.ts";

export function RedteamResults({
  report,
  plan,
  embedded = false,
}: {
  report: RedteamRun;
  plan: ProjectPlan;
  /** Rendered inside a campaign repetition rather than as its own panel. */
  embedded?: boolean;
}) {
  const id = useId();
  const summary = summarizeRun(report);
  const booking = report.evidenceScope === "isolated-route-sqlite";
  const outdated =
    report.sourceDigest !== plan.sourceDigest || report.target !== plan.selectedTarget;
  return (
    <section
      className={`run-results ${embedded ? "campaign-repetition-evidence" : "panel"}`}
      aria-labelledby={`${id}-heading`}
    >
      <RunVerdict
        tone={summary.tone}
        eyebrow="Security test result"
        title={summary.title}
        titleId={`${id}-heading`}
        description={summary.description}
        live
        status={
          <>
            <RunStatePill state={report.state} />
            {summary.attention > 0 && (
              <StatePill tone="error">
                {summary.attention} {plural(summary.attention, "check")} to address
              </StatePill>
            )}
          </>
        }
      />
      <RunStats
        items={[
          { label: "Model", value: report.model, note: report.provider },
          {
            label: "Attack checks",
            value: `${summary.completed} / ${summary.planned}`,
            note: "completed",
            meter: { value: summary.completed, max: summary.planned },
          },
          {
            label: "Model calls",
            value: `${report.budget?.callsAdmitted ?? 0} / ${report.budget?.limits.maxModelCalls ?? 0}`,
            note: "admitted",
            meter: {
              value: report.budget?.callsAdmitted ?? 0,
              max: report.budget?.limits.maxModelCalls ?? 0,
            },
          },
          {
            label: "Tokens",
            value: report.budget?.accountedTokens.toLocaleString() ?? 0,
            note: report.provider === "chatgpt" ? "observed; no hard token cap" : "accounted",
          },
        ]}
      />
      {(summary.synthetic ||
        outdated ||
        report.error ||
        (report.finishedAt && !report.cleanupConfirmed)) && (
        <div className="run-alerts">
          {report.error && (
            <RunAlert tone="error" role="status">
              {report.error}
            </RunAlert>
          )}
          {report.finishedAt && !report.cleanupConfirmed && (
            <RunAlert tone="error" role="status">
              Worker cleanup could not be confirmed. Inspect the container runtime before starting
              another test.
            </RunAlert>
          )}
          {outdated && (
            <RunAlert tone="warning">
              This result belongs to a different source snapshot or target. Run a new test to assess
              the current selection.
            </RunAlert>
          )}
          {summary.synthetic && (
            <RunAlert tone="info">
              Scripted model responses were used for integration testing. They do not establish
              real-model exploitability.
            </RunAlert>
          )}
        </div>
      )}

      <RunSection
        title="Attack checks"
        aside={
          <span className="tag">
            {summary.planned} {plural(summary.planned, "check")}
          </span>
        }
      >
        <ol className="run-checks" aria-label="Attack check results">
          {report.trials
            .filter((trial) => trial.purpose === "probe")
            .map((trial, index) => {
              const model = modelResult(report, trial);
              const backend = backendResult(report, trial);
              const needsFix = model.tone === "issue" || backend?.tone === "issue";
              return (
                <li className="run-check" key={trial.id}>
                  <div className="run-check-heading">
                    <span className="run-check-number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <h4>{trialTitle(trial)}</h4>
                  </div>
                  <div className={`run-comparison ${backend ? "has-backend" : ""}`}>
                    <div className="run-check-result">
                      <p className="run-channel">
                        <Icon name="llm-calls" />
                        {summary.synthetic ? "Scripted tool test" : "Through the model"}
                      </p>
                      <span className={`run-outcome run-tone-${model.tone}`}>{model.label}</span>
                      <p>{model.evidence}</p>
                    </div>
                    {backend && (
                      <div className="run-check-result">
                        <p className="run-channel">
                          <Icon name="tools" />
                          Direct tool check · no model
                        </p>
                        <span className={`run-outcome run-tone-${backend.tone}`}>
                          {backend.label}
                        </span>
                        <p>{backend.evidence}</p>
                      </div>
                    )}
                  </div>
                  {needsFix && (
                    <div className="run-check-action">
                      {backend?.tone === "issue" &&
                        trial.completed &&
                        trial.outcome === "not_observed" &&
                        hasWorkingControl(report) &&
                        !summary.synthetic && (
                          <p>
                            The backend accepted this action even though this model attack did not
                            succeed.
                          </p>
                        )}
                      <p>
                        <strong>Recommended fix</strong>
                        {recommendedFix(trial.id)}
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
        </ol>
      </RunSection>
      <div className="run-context">
        <div className="run-control-note">
          <Icon name="checklist" />
          <div>
            <h4>
              {hasWorkingControl(report)
                ? booking
                  ? "Normal booking worked"
                  : "Normal file task worked"
                : "Normal task not established"}
            </h4>
            <p>
              {hasWorkingControl(report)
                ? "The model and tools completed the normal task. This confirms the test setup works; it does not show the application is secure."
                : "A successful normal task is needed to interpret attacks that made no prohibited change."}
            </p>
          </div>
        </div>
        <div className="run-scope">
          <Icon name="redteam" />
          <div>
            <h4>What this result covers</h4>
            <p>
              {booking
                ? "Your original POST handler and tool functions, tested with disposable SQLite data. Production routes, middleware, authentication and real resources were not tested."
                : "Your selected agent and tool handlers, tested with temporary files. Production routes, identity controls and real resources were not tested."}
            </p>
            <p>
              <strong>Application safety has not been established.</strong> These checks cover the
              selected model and test inputs.
            </p>
          </div>
        </div>
      </div>
      <div className="run-disclosures">
        <RunEvidence report={report} />
      </div>
    </section>
  );
}
