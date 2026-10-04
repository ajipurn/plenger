import type { Finding, Rule } from "../../../src/rules/model.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { SourceRef } from "../shared/SourceRef.tsx";
import { uniqueObservations } from "../shared/unique.ts";
import { FindingTitle } from "./FindingTitle.tsx";

export function FindingDetail({ finding, rule }: { finding: Finding; rule: Rule | undefined }) {
  return (
    <article className="finding-detail">
      <div className="finding-detail-header">
        <div className="finding-meta">
          <span className={`badge ${finding.severity}`}>{finding.severity}</span>
          <span className="tag">{finding.confidence} confidence</span>
          <span className="finding-score muted">
            Score <MorphNumber value={finding.score} />
          </span>
        </div>
        <h3>
          <FindingTitle title={finding.title} />
        </h3>
      </div>
      <section className="finding-source-context">
        <h4 className="detail-section-title">
          <Icon name="source-files" /> Source location
        </h4>
        <SourceRef location={finding.location} includeColumn />
        {finding.snippet && (
          <pre className="code-block">
            <code>{finding.snippet}</code>
          </pre>
        )}
      </section>
      <EvidenceList finding={finding} />
      <section className="detail-section">
        <h4>Why it matters</h4>
        <p className="finding-description">
          {rule?.description ?? "Review the source evidence and notes for this observation."}
        </p>
        <dl className="detail-list">
          <div>
            <dt>Subject</dt>
            <dd>
              {finding.subject.name}{" "}
              <span className="muted">({finding.subject.kind.replaceAll("_", " ")})</span>
            </dd>
          </div>
          <div>
            <dt>Exposure</dt>
            <dd>
              {finding.exposed
                ? "Reachable from a network entry point"
                : "Network exposure not observed"}
            </dd>
          </div>
        </dl>
      </section>
      {finding.notes.length > 0 && (
        <section className="detail-section">
          <h4>Review notes</h4>
          <ul>
            {uniqueObservations(finding.notes).map((note) => (
              <li key={note}>
                <FindingTitle title={note} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {rule && (
        <>
          <section className="detail-section remediation-panel">
            <h4 className="detail-section-title">
              <Icon name="check" /> Suggested remediation
            </h4>
            <p>{rule.remediation}</p>
          </section>
          {(rule.owasp.length > 0 || rule.cwe.length > 0) && (
            <section className="detail-section">
              <h4>Reference mapping</h4>
              <div className="capabilities">
                {rule.owasp.map((mapping) => (
                  <span className="tag" key={mapping}>
                    {mapping}
                  </span>
                ))}
                {rule.cwe.map((cwe) => (
                  <span className="tag" key={cwe}>
                    CWE-{cwe}
                  </span>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </article>
  );
}

function EvidenceList({ finding }: { finding: Finding }) {
  if (finding.evidence.length === 0) return null;
  return (
    <section className="detail-section">
      <h4>Source trace</h4>
      <ol className="evidence-list finding-evidence-trace">
        {uniqueObservations(finding.evidence).map((evidence) => (
          <li key={JSON.stringify([evidence.location, evidence.message, evidence.snippet])}>
            <p>
              <FindingTitle title={evidence.message} />
            </p>
            <SourceRef location={evidence.location} />
            {evidence.snippet && (
              <details className="finding-trace-code">
                <summary>
                  <Icon name="chevron" /> Code context
                </summary>
                <pre className="code-block">
                  <code>{evidence.snippet}</code>
                </pre>
              </details>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
