import { type RefObject, useId, useMemo, useState } from "react";
import type { DashboardScanSummary } from "../../../src/dashboard/contract.ts";
import { NeedsScan } from "../overview/NeedsScan.tsx";
import { EmptyState } from "../shared/EmptyState.tsx";
import { formatDateTime, formatRelativeTime, plural } from "../shared/format.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { Pagination, usePagination } from "../shared/Pagination.tsx";
import { pathSegments, projectName } from "../shared/paths.ts";
import { SearchField } from "../shared/SearchField.tsx";
import { Button } from "../shared/ui.tsx";

const pageSize = 20;

export function HistoryView({
  history,
  currentId,
  available,
  clearTrigger,
  onScan,
  onOpen,
  onClear,
}: {
  history: DashboardScanSummary[];
  /** The saved scan currently open in the workspace, if any. */
  currentId: string | null;
  available: boolean;
  clearTrigger: RefObject<HTMLButtonElement | null>;
  onScan: () => void;
  onOpen: (item: DashboardScanSummary) => void;
  onClear: () => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const scans = useMemo(() => {
    const search = query.trim().toLowerCase();
    return search ? history.filter((item) => item.project.toLowerCase().includes(search)) : history;
  }, [history, query]);
  const pagination = usePagination(scans, pageSize);
  const projects = new Set(history.map((item) => item.project)).size;
  return (
    <section className="stack history-stack" aria-labelledby={`${id}-heading`}>
      <div className="section-heading view-section-intro">
        <div>
          <h2 id={`${id}-heading`}>
            Saved scans
            {history.length > 0 && (
              <span className="heading-count">
                <MorphNumber value={history.length} />
              </span>
            )}
          </h2>
          <p className="muted">
            {history.length > 0
              ? `Captured results from ${projects} ${plural(projects, "project")}, kept on this device across refreshes and restarts.`
              : "Captured results stay on this device across refreshes and restarts."}
          </p>
        </div>
        <Button
          ref={clearTrigger}
          className="button button-secondary"
          disabled={!available}
          onClick={onClear}
        >
          <Icon name="trash" /> Clear saved data
        </Button>
      </div>
      {history.length === 0 ? (
        <NeedsScan onScan={onScan} available={available} label="Scan history" />
      ) : (
        <div className="panel history-panel">
          <div className="history-toolbar">
            <SearchField
              id={`${id}-search`}
              label="Search saved scans"
              placeholder="Search by project name or path…"
              value={query}
              onChange={(value) => {
                setQuery(value);
                pagination.reset();
              }}
            />
            <span className="muted">Rescan a project to review its current source.</span>
          </div>
          {scans.length === 0 ? (
            <EmptyState
              className="empty-state compact history-empty"
              icon="search"
              iconClassName="empty-state-symbol"
              title="No saved scans match"
              titleLevel="h3"
              description="Try another project name or part of its path."
            >
              <Button className="button button-secondary" onClick={() => setQuery("")}>
                Clear search
              </Button>
            </EmptyState>
          ) : (
            <table className="history-table">
              <caption className="sr-only">Saved scans, newest first</caption>
              <colgroup>
                <col className="history-project-column" />
                <col className="history-date-column" />
                <col className="history-files-column" />
                <col className="history-findings-column" />
                <col className="history-open-column" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Scanned</th>
                  <th scope="col" className="history-number-cell">
                    Source files
                  </th>
                  <th scope="col" className="history-number-cell">
                    Findings
                  </th>
                  <th scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pagination.visible.map((item) => {
                  const current = item.id === currentId;
                  const directory = pathSegments(item.project).slice(0, -1).join("/");
                  return (
                    <tr
                      key={item.id}
                      className={`history-row ${current ? "is-selected" : ""}`}
                      aria-current={current ? "true" : undefined}
                      onClick={(event) => {
                        // The name button handles its own click; the rest of the row delegates.
                        if (!available || (event.target as HTMLElement).closest("button")) return;
                        onOpen(item);
                      }}
                    >
                      <td className="history-project-cell">
                        <span className="history-icon" aria-hidden="true">
                          <Icon name="history" />
                        </span>
                        <span className="history-project">
                          <Button
                            className="history-open"
                            disabled={!available}
                            onClick={() => onOpen(item)}
                            aria-label={`${current ? "Return to" : "Open"} the scan of ${projectName(item.project)} from ${formatDateTime(item.createdAt)}`}
                          >
                            {projectName(item.project)}
                          </Button>
                          <span className="history-path" title={item.project}>
                            {directory ? `/${directory}` : item.project}
                          </span>
                          <span className="history-mobile-date">
                            <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
                            {" · "}
                            {formatRelativeTime(item.createdAt)}
                          </span>
                          {current && <span className="tag history-current-tag">Open now</span>}
                        </span>
                      </td>
                      <td className="history-date-cell">
                        <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
                        <span className="muted">{formatRelativeTime(item.createdAt)}</span>
                      </td>
                      <td className="history-number-cell">{item.files.toLocaleString()}</td>
                      <td className="history-number-cell">
                        <span className={`run-count ${item.findings ? "" : "is-zero"}`}>
                          {item.findings.toLocaleString()}
                        </span>
                      </td>
                      <td className="history-open-cell">
                        <Icon name="chevron" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="history-footer">
            <span className="count-label">
              {scans.length === 0
                ? "0 scans"
                : `${pagination.start + 1}–${pagination.end} of ${scans.length} ${plural(scans.length, "scan")}`}
            </span>
            {pagination.pageCount > 1 && (
              <Pagination
                page={pagination.page}
                pageCount={pagination.pageCount}
                label="Saved scans pages"
                onPageChange={pagination.goTo}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
