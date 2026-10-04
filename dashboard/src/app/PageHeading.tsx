import type { DashboardScan } from "../../../src/dashboard/contract.ts";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { type PageId, pages } from "./routes.ts";

export function PageHeading({ view, report }: { view: PageId; report: DashboardScan | null }) {
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
    <div className="page-heading">
      <h1>
        {view === "overview"
          ? report
            ? "Project overview"
            : "Start with your agent."
          : page?.label}
        {view === "findings" && report && (
          <span className="heading-count">
            <MorphNumber value={report.scan.findings.length} />
          </span>
        )}
      </h1>
      <p className="muted">{descriptions[view]}</p>
    </div>
  );
}
