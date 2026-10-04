import type { ReactNode } from "react";
import type { DashboardScan } from "../../../src/dashboard/contract.ts";
import { formatDateTime } from "../shared/format.ts";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { type PageId, pages } from "./routes.ts";

export function PageHeading({
  view,
  report,
  actions,
}: {
  view: PageId;
  report: DashboardScan | null;
  /** Rendered beside the overview heading only. */
  actions: ReactNode;
}) {
  const page = pages.find((item) => item.id === view);
  const descriptions: Record<PageId, string> = {
    overview: report
      ? "Source findings, agent composition, and analysis coverage in one place."
      : "Understand what your agent can reach, starting with its source code.",
    findings: "Follow the evidence. Review what matters most.",
    inventory: "Explore the models, tools, and connections in your project.",
    redteam: "Test your agent, understand the results, and review the evidence.",
    history: "Revisit your saved scans, even after a refresh or restart.",
    settings: "Manage model providers for your red-team tests.",
  };
  return (
    <div className={`page-heading ${view === "findings" && report ? "findings-page-heading" : ""}`}>
      <div>
        <p className="eyebrow">{view === "overview" ? "Source security" : "Your workspace"}</p>
        <h1>
          {view === "overview"
            ? report
              ? "Project overview"
              : "Start with your agent."
            : page?.label}
          {view === "findings" && report && (
            <span className="findings-heading-count">
              <MorphNumber value={report.scan.findings.length} />
            </span>
          )}
        </h1>
        {!(view === "findings" && report) && <p className="muted">{descriptions[view]}</p>}
      </div>
      {view === "overview" && actions}
      {view === "findings" && report && (
        <div className="findings-snapshot">
          <span className="tag">Static analysis</span>
          <span className="muted">
            Scanned <time dateTime={report.createdAt}>{formatDateTime(report.createdAt)}</time>
          </span>
        </div>
      )}
    </div>
  );
}
