import type { ProjectPlan } from "../../../src/redteam/plan.ts";
import { runBlocker } from "../../../src/redteam/profile.ts";
import { Icon } from "../shared/icons.tsx";
import { uniqueObservations } from "../shared/unique.ts";
import { explainPlanValue } from "./plan-explanations.ts";

export function ReadinessCard({ plan }: { plan: ProjectPlan }) {
  return (
    <div className="panel readiness-card">
      <div className="section-heading readiness-title">
        <div className="category-heading-main">
          <span className="category-icon">
            <Icon name="redteam" />
          </span>
          <div>
            <h3>Preparation summary</h3>
            <p className="muted">The current source review for this project</p>
          </div>
        </div>
        <span
          className={`tag ${plan.preparation.status === "ready" ? "ready-status" : "attention-status"}`}
        >
          {plan.targets.length === 0 && (plan.coverage?.files ?? 0) > 0
            ? "Runtime profile unavailable"
            : plan.preparation.status === "ready"
              ? "Source review ready"
              : "Needs attention"}
        </span>
      </div>
      <dl className="readiness-summary">
        <div className="readiness-fact">
          <dt>Supported targets</dt>
          <dd className="readiness-value">
            <span className="readiness-number">{plan.targets.length}</span>
            <span className="muted readiness-context"> discovered</span>
          </dd>
        </div>
        <div className="readiness-fact">
          <dt>Runtime source snapshot</dt>
          <dd className="readiness-value">
            <span className="readiness-number">{plan.sources.files.length}</span>
            <span className="muted readiness-context"> captured</span>
          </dd>
        </div>
        <div className="readiness-fact">
          <dt>Dynamic testing</dt>
          <dd className="readiness-value readiness-unavailable">
            {plan.fastapiProfile
              ? "FastAPI profile: preparation only"
              : runBlocker(plan)
                ? "Runtime profile unavailable"
                : plan.nextProfile
                  ? "Booking-test preview"
                  : "File-test preview"}
          </dd>
        </div>
      </dl>
      {plan.coverage && (
        <div className="status-banner plan-callout">
          <div className="callout-body">
            <h3>Static review: {plan.coverage.files} source files</h3>
            <p>
              {plan.coverage.httpEntryPoints.length} HTTP entry points and{" "}
              {plan.coverage.toolUsingCalls} tool-using model flows were discovered across{" "}
              {plan.coverage.frameworks.map((framework) => framework.name).join(", ") ||
                "the scanned source"}
              .
              {plan.targets.length === 0
                ? " This project has no candidate for the current Python/llmfy runtime profile. These static observations remain available in Inventory."
                : plan.nextProfile
                  ? " Runtime preparation captures the selected POST handler and its local imports."
                  : " Runtime preparation covers the Python/llmfy profile only."}
            </p>
          </div>
        </div>
      )}
      <dl className="detail-list readiness-details">
        <div>
          <dt>Project</dt>
          <dd>
            <code>{plan.root}</code>
          </dd>
        </div>
        <div>
          <dt>Target selection</dt>
          <dd>
            {plan.selection === "automatic"
              ? "One candidate selected automatically"
              : plan.selection === "explicit"
                ? "Selected by you"
                : plan.selection === "required"
                  ? "Choose a candidate below"
                  : "No supported candidate available"}
          </dd>
        </div>
      </dl>
      {plan.preparation.reasons.length > 0 && (
        <ul className="notice-list readiness-notices">
          {uniqueObservations(plan.preparation.reasons).map((reason) => (
            <li key={reason}>{explainPlanValue(reason)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
