import type { RedteamRun } from "../../../src/redteam/run.ts";
import { Icon } from "../shared/icons.tsx";
import { ScrollArea } from "../shared/ScrollArea.tsx";
import { SectionSummary } from "../shared/SectionSummary.tsx";
import { trialTitle } from "./run-summary.ts";

/** Raw conversation, database, and event evidence behind a run's verdict. */
export function RunEvidence({ report }: { report: RedteamRun }) {
  return (
    <details className="technical-disclosure run-disclosure">
      <SectionSummary
        icon="prompts"
        title="Technical evidence"
        description="Conversations, tool events, database snapshots and runtime details."
      />
      <ScrollArea className="run-evidence-scroll" role="region" aria-label="Technical run evidence">
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
          {report.providerConfig && (
            <div>
              <h4>Provider settings at test start</h4>
              <p className="muted">
                {report.providerConfig.name} · {report.provider} · {report.model}
              </p>
              <p className="muted">
                {report.providerConfig.baseUrl} · {report.providerConfig.maxOutputTokens} maximum
                output tokens · temperature {report.providerConfig.temperature ?? "model default"}
              </p>
            </div>
          )}
          {report.runtime && (
            <div>
              <p className="muted">
                {"python" in report.runtime
                  ? `Python ${report.runtime.python} · llmfy ${report.runtime.llmfy}`
                  : `Node ${report.runtime.node} · AI SDK ${report.runtime.ai} · ${report.runtime.databaseObserver}`}
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
                      <strong>{trial.database.observations ? "Latest committed" : "After"}</strong>
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
                              #{observation.sequence} · {observation.final ? "Final" : "During run"}
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
  );
}
