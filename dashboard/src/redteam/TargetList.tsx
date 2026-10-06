import type { ProjectPlan } from "../../../src/redteam/plan.ts";
import { Icon } from "../shared/icons.tsx";
import { SourceRef } from "../shared/SourceRef.tsx";
import { TechnicalDisclosure } from "../shared/TechnicalDisclosure.tsx";
import { Button } from "../shared/ui.tsx";
import { uniqueObservations } from "../shared/unique.ts";
import { explainPlanValue } from "./plan-explanations.ts";

export function TargetList({
  plan,
  disabled,
  onPlan,
}: {
  plan: ProjectPlan;
  disabled: boolean;
  onPlan: (target: string) => void;
}) {
  return (
    <section className="panel targets-card">
      <div className="panel-intro targets-intro">
        <div className="section-heading plan-section-heading">
          <div>
            <h3>Discovered targets</h3>
            <p className="muted">Entry points captured from source</p>
          </div>
          <span className="category-count">{plan.targets.length}</span>
        </div>
        {plan.selection === "required" && (
          <p className="panel-note">
            Select a candidate below to create a plan for that entry point.
          </p>
        )}
        {plan.targets.length === 0 && (
          <p className="muted panel-note">
            {plan.coverage?.httpEntryPoints.length
              ? "HTTP entry points were found, but their runtime adapters are not available yet. No project code has been run."
              : "No llmfy targets were discovered in the captured Python source."}
          </p>
        )}
      </div>
      {plan.targets.length > 0 && (
        <div className="candidate-list">
          {plan.targets.map((target) => (
            <article
              className={`candidate-row ${target.id === plan.selectedTarget ? "is-selected" : ""}`}
              key={target.id}
            >
              <div className="candidate-main candidate-body">
                <div className="section-heading candidate-heading">
                  <h4>{target.symbol ?? "Unresolved entry point"}</h4>
                </div>
                <div className="candidate-location">
                  <SourceRef location={target.location} />
                </div>
                <p className="muted candidate-kind">
                  {target.kind === "factory"
                    ? "Agent factory"
                    : target.kind === "function"
                      ? "Agent entry function"
                      : target.kind === "route"
                        ? "Next.js POST handler"
                        : "Unresolved entry point"}
                </p>
                {target.reasons.length > 0 && (
                  <ul className="notice-list candidate-notices">
                    {uniqueObservations(target.reasons).map((reason) => (
                      <li key={reason}>{explainPlanValue(reason)}</li>
                    ))}
                  </ul>
                )}
                {target.status === "candidate" &&
                  target.packs.map((pack) =>
                    pack.status === "bound" ? (
                      <p className="muted candidate-kind" key={pack.profile}>
                        File-canary tests apply through{" "}
                        {pack.tools.map((tool, index) => (
                          <span key={tool}>
                            {index > 0 && ", "}
                            <code>{tool}</code>
                          </span>
                        ))}
                        .
                      </p>
                    ) : (
                      <ul className="notice-list candidate-notices" key={pack.profile}>
                        {pack.reasons.map((reason) => (
                          <li key={reason}>{explainPlanValue(reason)}</li>
                        ))}
                      </ul>
                    ),
                  )}
              </div>
              <div className="target-actions">
                <span
                  className={`tag target-status ${target.id === plan.selectedTarget ? "ready-status" : ""}`}
                >
                  {target.id === plan.selectedTarget
                    ? "Selected"
                    : target.status === "candidate"
                      ? "Candidate"
                      : "Not supported yet"}
                </span>
                {target.status === "candidate" && (
                  <Button
                    type="button"
                    className="button button-secondary"
                    disabled={disabled}
                    onClick={() => onPlan(target.id)}
                    aria-label={`${target.id === plan.selectedTarget ? "Review selected target" : "Review this target"}: ${target.symbol ?? target.id}`}
                  >
                    {target.id === plan.selectedTarget && <Icon name="check" />}
                    {target.id === plan.selectedTarget
                      ? "Review selected target"
                      : "Review this target"}
                  </Button>
                )}
              </div>
              <TechnicalDisclosure className="target-disclosure" title="Technical target details">
                <p className="target-shape">
                  <code>
                    {target.kind}
                    {target.async ? " · async" : ""} · ({target.parameters.join(", ")})
                  </code>
                </p>
                <code className="target-id">{target.id}</code>
              </TechnicalDisclosure>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
