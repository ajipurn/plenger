import { useId } from "react";
import type { ProjectPlan } from "../../src/redteam/plan.ts";
import type { RedteamRun } from "../../src/redteam/run.ts";
import { Icon } from "./icons.tsx";
import {
  backendResult,
  hasWorkingControl,
  modelResult,
  recommendedFix,
  summarizeRun,
  trialTitle,
} from "./run-summary.ts";
import { ScrollArea } from "./ScrollArea.tsx";
import { Button, Select } from "./ui.tsx";

export function RedteamResults({
  report,
  plan,
  runs,
  onSelect,
  onDownload,
  onCancel,
  pending,
}: {
  report: RedteamRun;
  plan: ProjectPlan;
  runs: RedteamRun[];
  onSelect: (id: string) => void;
  onDownload: (run: RedteamRun) => void;
  onCancel: (() => void) | undefined;
  pending: boolean;
}) {
  const id = useId();
  const summary = summarizeRun(report);
  const booking = report.evidenceScope === "isolated-route-sqlite";
  const outdated =
    report.sourceDigest !== plan.sourceDigest || report.target !== plan.selectedTarget;
  return (
    <section className="panel run-results" aria-labelledby={`${id}-heading`}>
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
            {summary.attention} {summary.attention === 1 ? "check" : "checks"} to address
          </span>
        )}
      </div>

      <div className="run-report-toolbar">
        <label htmlFor={`${id}-history`} className="run-history-label">
          Viewing saved test
          <Select
            id={`${id}-history`}
            value={report.id}
            onValueChange={onSelect}
            items={runs.map((run) => ({
              value: run.id,
              label: `${run.model} · ${new Date(run.createdAt).toLocaleString()}`,
            }))}
          />
        </label>
        <div className="run-actions">
          <Button className="button button-secondary" onClick={() => onDownload(report)}>
            <Icon name="download" />
            Export result
          </Button>
          {onCancel && (
            <Button className="button button-secondary" disabled={pending} onClick={onCancel}>
              Stop current test
            </Button>
          )}
        </div>
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
      <details className="technical-disclosure">
        <summary className="disclosure-heading">
          Technical evidence
          <Icon name="chevron" />
        </summary>
        <ScrollArea
          className="run-evidence-scroll"
          role="region"
          aria-label="Technical run evidence"
        >
          <div className="technical-content">
            {!!report.backendChecks?.length && (
              <div className="run-backend-evidence">
                <h4>Direct tool checks · no model</h4>
                <p className="muted">
                  Original handlers called directly with test arguments in a separate database.
                </p>
                {report.backendChecks.map((check) => (
                  <details className="technical-disclosure" key={check.tool}>
                    <summary className="disclosure-heading">
                      {check.tool}
                      <Icon name="chevron" />
                    </summary>
                    <pre className="code-block">
                      {JSON.stringify(
                        {
                          outcome: check.outcome,
                          arguments: check.arguments,
                          before: check.before,
                          after: check.after,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                ))}
              </div>
            )}
            <p className="muted">
              Token admission uses conservative estimates and reconciles provider usage. It is not a
              guaranteed billing cap.
            </p>
            {report.runtime && (
              <div>
                <p className="muted">
                  Node {report.runtime.node} · AI SDK {report.runtime.ai} ·{" "}
                  {report.runtime.databaseObserver}
                </p>
                <pre className="code-block">{report.runtime.image}</pre>
              </div>
            )}
            {report.trials.map((trial) => (
              <div key={trial.id}>
                <h4>{trialTitle(trial)}</h4>
                {trial.conversation?.map((message) => (
                  <div className="run-message" key={message.id}>
                    <strong>{message.role === "user" ? "Test input" : "Model response"}</strong>
                    <p>{message.content}</p>
                  </div>
                ))}
                {trial.database && (
                  <div className="run-database">
                    <h5>
                      SQLite evidence · expected price{" "}
                      {trial.database.expectedAmount.toLocaleString()}
                    </h5>
                    <div className="run-database-columns">
                      <div>
                        <strong>Before</strong>
                        <pre className="code-block">
                          {JSON.stringify(trial.database.before, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <strong>
                          {trial.database.observations ? "Latest committed" : "After"}
                        </strong>
                        <pre className="code-block">
                          {trial.database.after
                            ? JSON.stringify(trial.database.after, null, 2)
                            : "Not observed"}
                        </pre>
                      </div>
                    </div>
                    {!!trial.database.observations?.length && (
                      <details className="technical-disclosure">
                        <summary className="disclosure-heading">
                          Committed snapshots · {trial.database.observations.length}
                          <Icon name="chevron" />
                        </summary>
                        <div className="technical-content">
                          {trial.database.observations.map((observation) => (
                            <div key={observation.sequence}>
                              <strong>
                                #{observation.sequence} ·{" "}
                                {observation.final ? "Final" : "During run"}
                              </strong>
                              {observation.callIds.length > 0 && (
                                <p className="muted">
                                  Active tool calls: {observation.callIds.join(", ")}
                                </p>
                              )}
                              <pre className="code-block">
                                {JSON.stringify(observation.after, null, 2)}
                              </pre>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}
                {trial.workerName && (
                  <p className="muted">
                    <code>{trial.workerName}</code>
                  </p>
                )}
                <ul>
                  {trial.events.map((event) => (
                    <li key={event.sequence}>
                      <code>{event.stage}</code>
                      {event.tool && ` · ${event.tool}`}
                      {event.boundary && ` · ${event.boundary}`}
                      {event.markerPresent !== undefined &&
                        ` · marker ${event.markerPresent ? "present" : "absent"}`}
                      {event.arguments && (
                        <pre className="code-block">{JSON.stringify(event.arguments, null, 2)}</pre>
                      )}
                      {event.result !== undefined && (
                        <pre className="code-block">{JSON.stringify(event.result, null, 2)}</pre>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </ScrollArea>
      </details>
    </section>
  );
}
