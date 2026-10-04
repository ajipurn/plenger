import { useId } from "react";
import type { ProjectPlan } from "../../../src/redteam/plan.ts";
import type { RedteamRun } from "../../../src/redteam/run.ts";
import { plural } from "../shared/format.ts";
import { Icon } from "../shared/icons.tsx";
import { RunEvidence } from "./RunEvidence.tsx";
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
      <div className={`run-verdict run-tone-${summary.tone}`}>
        <span className="run-verdict-icon">
          <Icon name={summary.tone === "issue" ? "findings" : "redteam"} />
        </span>
        <div role="status" aria-live="polite">
          <p className="eyebrow">Security test result</p>
          <h3 id={`${id}-heading`}>{summary.title}</h3>
          <p>{summary.description}</p>
        </div>
        {summary.attention > 0 && (
          <span className="run-outcome run-tone-issue">
            {summary.attention} {plural(summary.attention, "check")} to address
          </span>
        )}
      </div>

      <div className="run-metadata">
        <span>
          Process: <strong>{report.state}</strong>
        </span>
        <span>
          {report.provider} · <strong>{report.model}</strong>
        </span>
        <span>
          {summary.completed} / {summary.planned} attack checks completed
        </span>
        <span>
          {report.budget?.callsAdmitted ?? 0} / {report.budget?.limits.maxModelCalls ?? 0} model
          calls
        </span>
        <span>{report.budget?.accountedTokens.toLocaleString() ?? 0} accounted tokens</span>
      </div>
      {summary.synthetic && (
        <p className="run-context-note">
          Scripted model responses were used for integration testing. They do not establish
          real-model exploitability.
        </p>
      )}
      {outdated && (
        <p className="run-context-note">
          This result belongs to a different source snapshot or target. Run a new test to assess the
          current selection.
        </p>
      )}
      {report.error && (
        <p role="status" className="error-message">
          {report.error}
        </p>
      )}
      {report.finishedAt && !report.cleanupConfirmed && (
        <p role="status" className="error-message">
          Worker cleanup could not be confirmed. Inspect the container runtime before starting
          another test.
        </p>
      )}

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
                      {recommendedFix(trial)}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
      </ol>

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
      <RunEvidence report={report} />
    </section>
  );
}
