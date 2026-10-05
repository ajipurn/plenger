function SkeletonPanel() {
  return (
    <div className="panel">
      <div className="section-heading skeleton-panel-heading">
        <span className="skeleton-block skeleton-panel-title" />
        <span className="skeleton-block skeleton-pill" />
      </div>
      {["first", "second", "third", "fourth"].map((row) => (
        <div className="skeleton-row" key={row}>
          <span className="skeleton-block skeleton-symbol" />
          <div className="skeleton-row-content">
            <span className="skeleton-block skeleton-row-title" />
            <span className="skeleton-block skeleton-row-detail" />
          </div>
          <span className="skeleton-block skeleton-pill" />
        </div>
      ))}
    </div>
  );
}

export function OverviewChartSkeleton() {
  return (
    <div className="overview-chart-grid" aria-hidden="true">
      {[0, 1].map((index) => (
        <div className="panel overview-chart-panel" key={index}>
          <div className="overview-chart-heading">
            <div className="skeleton-heading">
              <span className="skeleton-block skeleton-panel-title" />
              <span className="skeleton-block skeleton-description" />
            </div>
          </div>
          <div className="overview-chart-canvas skeleton-chart-canvas">
            <span className="skeleton-block skeleton-chart-plot" />
          </div>
          <div className="overview-chart-footnote">
            <span className="skeleton-block skeleton-stat-note" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DashboardSkeleton({
  overview,
  findings = false,
  settings = false,
  inventory = false,
}: {
  overview: boolean;
  findings?: boolean;
  settings?: boolean;
  inventory?: boolean;
}) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading dashboard…</span>
      <div aria-hidden="true">
        <div className="page-heading skeleton-heading">
          <span className="skeleton-block skeleton-title" />
          <span className="skeleton-block skeleton-description" />
        </div>
        <div className="stack">
          {overview && (
            <>
              <div className="scan-meta">
                <span className="skeleton-block skeleton-meta" />
              </div>
              <div className="stats-grid panel">
                {["findings", "agents", "tools", "files"].map((metric) => (
                  <div className="stat-card skeleton-stat" key={metric}>
                    <span className="skeleton-block skeleton-stat-label" />
                    <span className="skeleton-block skeleton-stat-value" />
                    <span className="skeleton-block skeleton-stat-note" />
                  </div>
                ))}
              </div>
              <OverviewChartSkeleton />
            </>
          )}
          <div
            className={
              overview
                ? "overview-columns"
                : inventory
                  ? "subnav-layout inventory-layout"
                  : settings
                    ? "subnav-layout"
                    : undefined
            }
          >
            {settings && (
              <aside className="subnav">
                <span className="skeleton-block skeleton-panel-title" />
              </aside>
            )}
            {inventory && (
              <aside className="subnav">
                <p className="eyebrow">Categories</p>
                <div className="subnav-list">
                  {[
                    "frameworks",
                    "models",
                    "agents",
                    "tools",
                    "calls",
                    "entries",
                    "servers",
                    "clients",
                    "stores",
                    "prompts",
                  ].map((category) => (
                    <div className="subnav-item" key={category}>
                      <span className="skeleton-block skeleton-symbol" />
                      <span className="skeleton-block skeleton-row-title" />
                    </div>
                  ))}
                </div>
              </aside>
            )}
            {settings || inventory ? (
              <div className="subnav-content">
                <div className="subnav-content-heading">
                  <div className="skeleton-heading">
                    <span className="skeleton-block skeleton-panel-title" />
                    <span className="skeleton-block skeleton-description" />
                  </div>
                  <span className="skeleton-block skeleton-pill" />
                </div>
                <SkeletonPanel />
              </div>
            ) : findings ? (
              <div className="panel findings-workbench">
                <div className="findings-toolbar">
                  <span className="skeleton-block skeleton-findings-search" />
                  <span className="skeleton-block skeleton-findings-filters" />
                </div>
                <div className="skeleton-findings-columns">
                  {["severity", "finding", "source", "confidence"].map((column) => (
                    <span key={column} className="skeleton-block skeleton-stat-label" />
                  ))}
                </div>
                {[0, 1, 2, 3].map((row) => (
                  <div className="skeleton-findings-columns skeleton-findings-row" key={row}>
                    <span className="skeleton-block skeleton-pill" />
                    <div className="skeleton-row-content">
                      <span className="skeleton-block skeleton-row-title" />
                      <span className="skeleton-block skeleton-row-detail" />
                    </div>
                    <span className="skeleton-block skeleton-row-title" />
                    <span className="skeleton-block skeleton-pill" />
                  </div>
                ))}
              </div>
            ) : (
              <SkeletonPanel />
            )}
            {overview && <SkeletonPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}
