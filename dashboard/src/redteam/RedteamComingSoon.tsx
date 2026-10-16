import { Link } from "react-router";
import { EmptyState } from "../shared/EmptyState.tsx";
import { Icon } from "../shared/icons.tsx";

/** The Red-team route stays reachable while its testing controls are unavailable. */
export function RedteamComingSoon() {
  return (
    <EmptyState
      as="section"
      className="panel empty-state redteam-coming-soon"
      icon="redteam"
      iconClassName="empty-state-symbol"
      title="Coming soon"
      description="Red-team testing is temporarily unavailable. You can still scan projects and review source findings."
      descriptionClassName="muted"
    >
      <Link to="/findings" className="button button-secondary">
        Back to findings <Icon name="arrow-right" />
      </Link>
    </EmptyState>
  );
}
