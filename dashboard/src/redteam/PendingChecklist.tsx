import type { ProjectPlan } from "../../../src/redteam/plan.ts";
import { Icon } from "../shared/icons.tsx";
import { uniqueObservations } from "../shared/unique.ts";
import { explainPendingItem } from "./plan-explanations.ts";

export function PendingChecklist({ plan }: { plan: ProjectPlan }) {
  if (plan.pending.length === 0) return null;
  return (
    <section className="panel pending-card">
      <div className="plan-card-intro">
        <div className="category-heading-main">
          <span className="category-icon">
            <Icon name="checklist" />
          </span>
          <div>
            <h3>Remaining runtime support</h3>
            <p className="muted panel-note">
              Work beyond the managed run preview. Offline review alone does not establish runtime
              compatibility.
            </p>
          </div>
        </div>
      </div>
      <ul className="pending-checklist">
        {uniqueObservations(plan.pending).map((item) => (
          <li key={item}>
            <span className="pending-step" aria-hidden="true" />
            <span>{explainPendingItem(item)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
