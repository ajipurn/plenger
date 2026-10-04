import type { ProjectPlan } from "../../../src/redteam/plan.ts";
import { Icon } from "../shared/icons.tsx";
import { TechnicalDisclosure } from "../shared/TechnicalDisclosure.tsx";
import { uniqueObservations } from "../shared/unique.ts";
import { explainPlanValue } from "./plan-explanations.ts";

export function SourceCoverage({ plan }: { plan: ProjectPlan }) {
  return (
    <section className="panel inventory-card plan-detail-card">
      <div className="plan-card-intro">
        <div className="category-heading-main">
          <span className="category-icon">
            <Icon name="source-files" />
          </span>
          <h3>Source coverage</h3>
        </div>
      </div>
      <dl className="detail-list">
        <div>
          <dt>Captured files</dt>
          <dd>{plan.sources.files.length}</dd>
        </div>
        <div>
          <dt>Supported source</dt>
          <dd>
            {plan.nextProfile
              ? "Selected TypeScript/JavaScript import closure"
              : "Python files only"}
          </dd>
        </div>
        <div>
          <dt>Data and configuration files</dt>
          <dd>
            {plan.nextProfile
              ? "SQLite is created automatically for each check"
              : "Not included in this review"}
          </dd>
        </div>
        <div>
          <dt>Source limit reached</dt>
          <dd>{plan.sources.truncated ? "Yes" : "No"}</dd>
        </div>
      </dl>
      {plan.sources.files.length > 0 && (
        <TechnicalDisclosure title="Captured source files" scrollable>
          <ul className="review-list">
            {plan.sources.files.map((file) => (
              <li className="review-row" key={file.path}>
                <code className="review-path">{file.path}</code>
                <span className="muted review-meta">{file.bytes.toLocaleString()} bytes</span>
              </li>
            ))}
          </ul>
        </TechnicalDisclosure>
      )}
      {plan.sources.omitted.length > 0 && (
        <TechnicalDisclosure title={`Omitted files (${plan.sources.omitted.length})`} scrollable>
          <ul className="review-list">
            {uniqueObservations(plan.sources.omitted).map((file) => (
              <li className="review-row" key={`${file.path}-${file.reason}`}>
                <code className="review-path">{file.path}</code>
                <span className="review-note">{explainPlanValue(file.reason)}</span>
              </li>
            ))}
          </ul>
        </TechnicalDisclosure>
      )}
      {plan.sources.excludedDirs.length > 0 && (
        <TechnicalDisclosure
          title={`Excluded directories (${plan.sources.excludedDirs.length})`}
          scrollable
        >
          <ul className="review-list">
            {uniqueObservations(plan.sources.excludedDirs).map((directory) => (
              <li className="review-row" key={`${directory.path}-${directory.reason}`}>
                <code className="review-path">{directory.path}</code>
                <span className="review-note">{explainPlanValue(directory.reason)}</span>
              </li>
            ))}
          </ul>
        </TechnicalDisclosure>
      )}
    </section>
  );
}
