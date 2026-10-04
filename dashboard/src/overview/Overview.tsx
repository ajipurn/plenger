import { lazy, Suspense, useState } from "react";
import { Link } from "react-router";
import type { DashboardScan, DashboardScanSummary } from "../../../src/dashboard/contract.ts";
import { SEVERITIES } from "../../../src/rules/model.ts";
import { OverviewChartSkeleton } from "../app/DashboardSkeleton.tsx";
import { findingRoute, routes } from "../app/routes.ts";
import { EmptyState } from "../shared/EmptyState.tsx";
import { capitalize, plural } from "../shared/format.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { Button } from "../shared/ui.tsx";

const OverviewCharts = lazy(() => import("./OverviewCharts.tsx"));

export default function Overview({
  report,
  history,
}: {
  report: DashboardScan;
  history: DashboardScanSummary[];
}) {
  const { scan } = report;
  const [showAllFrameworks, setShowAllFrameworks] = useState(false);
  const frameworks = showAllFrameworks
    ? scan.inventory.frameworks
    : scan.inventory.frameworks.slice(0, 6);
  const highImpact = scan.findings.filter(
    (finding) => finding.severity === "critical" || finding.severity === "high",
  ).length;
  const syntax = scan.files.filter((file) => file.syntaxErrors).length;
  const analysisGaps = scan.skipped.length > 0 || syntax > 0 || scan.truncated;
  const severityCounts = SEVERITIES.map((level) => ({
    level,
    count: scan.findings.filter((finding) => finding.severity === level).length,
  }));
  const stats = [
    {
      label: "Findings to review",
      count: scan.findings.length,
      note: `${highImpact} critical or high`,
      icon: "findings" as const,
    },
    {
      label: "Agent declarations",
      count: scan.inventory.agents.length,
      note: `${scan.inventory.llmCalls.filter((call) => call.tools.length > 0).length} tool-using model flows`,
      icon: "agents" as const,
    },
    {
      label: "Tools mapped",
      count: scan.inventory.tools.length,
      note: `${scan.inventory.models.length} model clients`,
      icon: "tools" as const,
    },
    {
      label: "Source files",
      count: scan.files.length,
      note: `${scan.durationMs.toLocaleString()} ms scan time`,
      icon: "source-files" as const,
    },
  ];
  return (
    <div className="stack overview-stack">
      <div className="overview-snapshot">
        <span className="overview-project-path" title={scan.root}>
          <Icon name="folder" />
          <code className="break-path">{scan.root}</code>
        </span>
        <span>
          {report.rules.length.toLocaleString()} detection {plural(report.rules.length, "rule")}
        </span>
        <span>
          {scan.inventory.frameworks.length.toLocaleString()}{" "}
          {plural(scan.inventory.frameworks.length, "framework")}
        </span>
      </div>
      <div className="stats-grid panel">
        {stats.map((stat, index) => (
          <div className="stat-card" key={stat.label}>
            <div className="stat-label">
              <Icon name={stat.icon} />
              <span>{stat.label}</span>
            </div>
            <strong className="stat-value">
              <MorphNumber value={stat.count} />
            </strong>
            {index === 0 && scan.findings.length > 0 && (
              <div className="severity-meter" aria-hidden="true">
                {severityCounts
                  .filter((item) => item.count > 0)
                  .map((item) => (
                    <span
                      key={item.level}
                      className={`severity-meter-segment ${item.level}`}
                      style={{ flexGrow: item.count }}
                      title={`${capitalize(item.level)}: ${item.count}`}
                    />
                  ))}
              </div>
            )}
            <p className="stat-note">{stat.note}</p>
          </div>
        ))}
      </div>
      <Suspense fallback={<OverviewChartSkeleton />}>
        <OverviewCharts report={report} history={history} />
      </Suspense>
      <div className="overview-columns overview-details">
        <section className="panel priority-panel">
          <div className="section-heading">
            <div>
              <h2>Priority findings</h2>
              <p className="muted">Ranked by severity, confidence, and reachable exposure.</p>
            </div>
            <Link to={routes.findings} className="text-link">
              View all
              <Icon name="chevron" />
            </Link>
          </div>
          {scan.findings.length ? (
            <div className="priority-list">
              {scan.findings.slice(0, 5).map((finding, index) => (
                <Link
                  to={findingRoute(finding.fingerprint)}
                  className="priority-row"
                  key={finding.fingerprint}
                >
                  <span className="priority-rank">{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{finding.title}</strong>
                    <span className="source-ref">
                      {finding.location.path}:{finding.location.line}
                      <span className="rule-id">{finding.rule}</span>
                    </span>
                  </div>
                  <span className={`badge ${finding.severity}`}>{finding.severity}</span>
                  <Icon name="chevron" />
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              className="empty-state compact"
              icon="check"
              title="No findings from the current rules"
              titleLevel="h3"
              description="Review coverage and inventory. An empty finding list does not establish runtime safety."
              descriptionClassName="muted"
            />
          )}
        </section>
        <section className="panel framework-panel">
          <div className="section-heading">
            <div>
              <h2>Frameworks & connections</h2>
              <p className="muted">What the agent is built on and what it reaches.</p>
            </div>
            <span className="tag framework-count">{scan.inventory.frameworks.length}</span>
          </div>
          <div className="framework-list" id="overview-frameworks">
            {scan.inventory.frameworks.length ? (
              frameworks.map((framework) => (
                <div className="framework-row" key={framework.id}>
                  <span className="framework-monogram">
                    {framework.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <strong>{framework.name}</strong>
                    <span>
                      {framework.files.length} source {plural(framework.files.length, "file")}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">No recognized AI frameworks were found in the scanned source.</p>
            )}
          </div>
          {scan.inventory.frameworks.length > 6 && (
            <Button
              className="text-link framework-toggle"
              aria-expanded={showAllFrameworks}
              aria-controls="overview-frameworks"
              onClick={() => setShowAllFrameworks((value) => !value)}
            >
              {showAllFrameworks
                ? "Show fewer frameworks"
                : `Show all ${scan.inventory.frameworks.length} frameworks`}
              <Icon name="chevron" />
            </Button>
          )}
          <div className="connection-counts">
            <div>
              <span>Entry points</span>
              <strong>{scan.inventory.entryPoints.length}</strong>
            </div>
            <div>
              <span>MCP servers / clients</span>
              <strong>
                {scan.inventory.mcpServers.length} / {scan.inventory.mcpClients.length}
              </strong>
            </div>
            <div>
              <span>Data stores</span>
              <strong>{scan.inventory.dataStores.length}</strong>
            </div>
          </div>
          <Link to={routes.inventory} className="text-link">
            Explore inventory
            <Icon name="chevron" />
          </Link>
        </section>
      </div>
      <section className="panel coverage-panel">
        <div className="section-heading coverage-heading">
          <div>
            <h2>Analysis coverage</h2>
            <p className="muted">Static observations from this scan’s scope.</p>
          </div>
          <span className={`tag ${analysisGaps ? "attention-status" : "tag-success"}`}>
            {analysisGaps ? "Gaps to review" : "No analysis gaps"}
          </span>
        </div>
        <div className="coverage-counts">
          <div>
            <strong>{scan.skipped.length}</strong>
            <span>Files skipped</span>
          </div>
          <div>
            <strong>{syntax}</strong>
            <span>Syntax gaps</span>
          </div>
          <div>
            <strong>{scan.excludedDirs.length}</strong>
            <span>Directories excluded</span>
          </div>
          <div>
            <strong>{scan.truncated ? "Reached" : "Within limit"}</strong>
            <span>Source file limit</span>
          </div>
        </div>
        {analysisGaps && (
          <details className="coverage-details">
            <summary>
              <span>Review analysis gaps</span>
              <Icon name="chevron" />
            </summary>
            <ul>
              {scan.truncated && (
                <li>File-count limit reached; some source files were not scanned.</li>
              )}
              {scan.files
                .filter((file) => file.syntaxErrors)
                .map((file) => (
                  <li key={file.path}>{file.path} — syntax errors</li>
                ))}
              {scan.skipped.map((file) => (
                <li key={`${file.path}:${file.reason}`}>
                  {file.path} — {file.reason.replaceAll("_", " ")}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}
