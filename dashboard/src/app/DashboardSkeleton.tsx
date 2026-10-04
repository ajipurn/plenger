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
        {inventory && (
          <div className="inventory-sidebar">
            <div className="inventory-sidebar-scroll">
              <p className="eyebrow">Categories</p>
              <div className="inventory-tabs">
                {[
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
                  <div className="inventory-tab" key={category}>
                    <span className="skeleton-block skeleton-symbol" />
                    <span className="skeleton-block skeleton-row-title" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        <div className="page-heading skeleton-heading">
          <span className="skeleton-block skeleton-title" />
          <span className="skeleton-block skeleton-description" />
        </div>
        <div className="stack">
          {inventory && (
            <div className="inventory-category-select">
              <span className="eyebrow">Category</span>
              <span className="skeleton-block skeleton-row-title" />
            </div>
          )}
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
          <div className={overview ? "overview-columns" : settings ? "settings-layout" : undefined}>
            {settings && (
              <aside className="settings-sidebar">
                <span className="skeleton-block skeleton-panel-title" />
              </aside>
            )}
            {settings ? (
              <div className="settings-content">
                <div className="settings-content-heading">
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
