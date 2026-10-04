import type { ProjectPlan } from "../../../src/redteam/plan.ts";
import { known } from "../shared/format.ts";
import { Icon } from "../shared/icons.tsx";
import { TechnicalDisclosure } from "../shared/TechnicalDisclosure.tsx";
import { uniqueObservations } from "../shared/unique.ts";
import { explainPlanValue } from "./plan-explanations.ts";

export function DependencyReview({ plan }: { plan: ProjectPlan }) {
  return (
    <section className="panel inventory-card plan-detail-card">
      <div className="plan-card-intro">
        <div className="category-heading-main">
          <span className="category-icon">
            <Icon name="frameworks" />
          </span>
          <h3>Dependency review</h3>
        </div>
        <p className="muted panel-note">
          {plan.nextProfile
            ? "The managed image pins AI SDK, Zod and SQLite dependencies. Project installers and scripts are not run."
            : "Declarations only. Dependencies have not been resolved or installed."}
        </p>
      </div>
      <dl className="detail-list">
        <div>
          <dt>Status</dt>
          <dd>
            {plan.dependencies.status === "declared" ? "Declarations reviewed" : "Needs attention"}
          </dd>
        </div>
        <div>
          <dt>{plan.nextProfile ? "Managed AI SDK version" : "Declared llmfy version"}</dt>
          <dd>
            {plan.nextProfile
              ? plan.nextProfile.versions.ai
              : known(plan.dependencies.llmfy.version)}
          </dd>
        </div>
        <div>
          <dt>{plan.nextProfile ? "Database setup" : "Matches the tested llmfy example"}</dt>
          <dd>
            {plan.nextProfile
              ? "Automatic · disposable SQLite"
              : plan.dependencies.llmfy.matchesSyntheticBaseline
                ? "Yes"
                : "No"}
          </dd>
        </div>
        <div>
          <dt>{plan.nextProfile ? "Managed Node.js version" : "Python constraint"}</dt>
          <dd>{plan.nextProfile ? "22.18.0" : known(plan.dependencies.requiresPython)}</dd>
        </div>
      </dl>
      {plan.dependencies.issues.length > 0 && (
        <ul className="review-list dependency-issues">
          {uniqueObservations(plan.dependencies.issues).map((issue) => (
            <li className="review-row" key={`${issue.path}-${issue.line ?? ""}-${issue.reason}`}>
              <code className="review-path">
                {issue.path}
                {issue.line ? `:${issue.line}` : ""}
              </code>
              <span className="review-note">{explainPlanValue(issue.reason)}</span>
            </li>
          ))}
        </ul>
      )}
      <TechnicalDisclosure title="Reviewed manifests" scrollable>
        <ul className="review-list">
          {plan.dependencies.manifests.map((manifest) => (
            <li className="review-row" key={manifest.path}>
              <code className="review-path">{manifest.path}</code>
              <span className="review-note">{explainPlanValue(manifest.status)}</span>
            </li>
          ))}
        </ul>
      </TechnicalDisclosure>
      {plan.dependencies.packages.length > 0 && (
        <TechnicalDisclosure
          title={`Declared packages (${plan.dependencies.packages.length})`}
          scrollable
        >
          <ul className="review-list">
            {uniqueObservations(plan.dependencies.packages).map((item) => (
              <li
                className="review-row"
                key={`${item.name}-${item.extras.join(",")}-${item.constraint}-${item.source}`}
              >
                <code className="review-path">
                  {item.name}
                  {item.extras.length > 0 ? `[${item.extras.join(",")}]` : ""}
                  {item.constraint}
                </code>
                <span className="muted review-note">{item.source}</span>
              </li>
            ))}
          </ul>
        </TechnicalDisclosure>
      )}
    </section>
  );
}
