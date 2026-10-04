import { EmptyState } from "../shared/EmptyState.tsx";
import { Button } from "../shared/ui.tsx";

export function NeedsScan({
  onScan,
  available,
  label,
}: {
  onScan: () => void;
  available: boolean;
  label: string;
}) {
  return (
    <EmptyState
      as="section"
      className="empty-state panel"
      icon="scan"
      title={`${label} starts with a scan`}
      description="Scan the selected project to inspect its agent inventory and source findings."
      descriptionClassName="muted"
    >
      <Button
        type="button"
        className="button button-primary"
        disabled={!available}
        onClick={onScan}
      >
        Scan project
      </Button>
    </EmptyState>
  );
}
