import type { ReactNode } from "react";
import type { DashboardScan } from "../../../src/dashboard/contract.ts";
import { formatDateTime } from "../shared/format.ts";
import { projectName } from "../shared/paths.ts";
import { type PageId, pages } from "./routes.ts";

/** Sticky context bar: where you are, when the open scan was taken, and the scan actions. */
export function AppTopbar({
  view,
  project,
  report,
  actions,
}: {
  view: PageId;
  project: string;
  report: DashboardScan | null;
  actions: ReactNode;
}) {
  const page = pages.find((item) => item.id === view);
  const scope =
    page?.group === "Workspace" ? "Workspace" : project ? projectName(project) : "No project";
  return (
    <header className="app-topbar">
      <nav className="topbar-breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li>{scope}</li>
          <li aria-current="page">{page?.label ?? "Overview"}</li>
        </ol>
      </nav>
      <div className="topbar-actions">
        {report && (
          <span className="topbar-scan-status">
            <span className="local-dot" aria-hidden="true" />
            Scanned <time dateTime={report.createdAt}>{formatDateTime(report.createdAt)}</time>
          </span>
        )}
        {actions}
      </div>
    </header>
  );
}
