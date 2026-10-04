import type { RefObject } from "react";
import type { DashboardScanSummary } from "../../../src/dashboard/contract.ts";
import { NeedsScan } from "../overview/NeedsScan.tsx";
import { formatDateTime, plural } from "../shared/format.ts";
import { Icon } from "../shared/icons.tsx";
import { projectName } from "../shared/paths.ts";
import { Button } from "../shared/ui.tsx";

export function HistoryView({
  history,
  available,
  clearTrigger,
  onScan,
  onOpen,
  onClear,
}: {
  history: DashboardScanSummary[];
  available: boolean;
  clearTrigger: RefObject<HTMLButtonElement | null>;
  onScan: () => void;
  onOpen: (item: DashboardScanSummary) => void;
  onClear: () => void;
}) {
  return (
    <section className="panel history-panel">
      <div className="section-heading">
        <div>
          <h2>Saved scans</h2>
          <p className="muted">Select a captured result to revisit its findings and inventory.</p>
        </div>
        <div className="history-actions">
          <span className="tag">
            {history.length} {plural(history.length, "scan")}
          </span>
          <Button
            ref={clearTrigger}
            className="button button-secondary"
            disabled={!available}
            onClick={onClear}
          >
            <Icon name="trash" /> Clear saved data
          </Button>
        </div>
      </div>
      {history.length === 0 ? (
        <NeedsScan onScan={onScan} available={available} label="Scan history" />
      ) : (
        <div className="history-list">
          {history.map((item) => (
            <Button
              type="button"
              key={item.id}
              className="history-row"
              disabled={!available}
              onClick={() => onOpen(item)}
            >
              <span className="history-icon">
                <Icon name="history" />
              </span>
              <span>
                <strong>{projectName(item.project)}</strong>
                <span className="muted break-path">{item.project}</span>
              </span>
              <span className="history-date">{formatDateTime(item.createdAt)}</span>
              <span className="tag">{item.findings} findings</span>
              <Icon name="chevron" />
            </Button>
          ))}
        </div>
      )}
      <p className="panel-footnote history-summary">
        Saved locally across refreshes and restarts. These are captured results; rescan your project
        to review current source code.
      </p>
    </section>
  );
}
