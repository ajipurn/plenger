import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router";
import { connect, type DashboardApi } from "../api/client.ts";
import { FindingsView } from "../findings/FindingsView.tsx";
import { ClearSavedData } from "../history/ClearSavedData.tsx";
import { HistoryView } from "../history/HistoryView.tsx";
import { InventoryView } from "../inventory/InventoryView.tsx";
import { NeedsScan } from "../overview/NeedsScan.tsx";
import Overview from "../overview/Overview.tsx";
import { Welcome } from "../overview/Welcome.tsx";
import { ProjectPicker } from "../project/ProjectPicker.tsx";
import { ProvidersView } from "../providers/ProvidersView.tsx";
import { RedteamView } from "../redteam/RedteamView.tsx";
import { downloadJson } from "../shared/download.ts";
import { Icon } from "../shared/icons.tsx";
import { Button } from "../shared/ui.tsx";
import { AppSidebar } from "./AppSidebar.tsx";
import { AppTopbar } from "./AppTopbar.tsx";
import { DashboardProvider, useDashboardState } from "./DashboardContext.tsx";
import { DashboardSkeleton } from "./DashboardSkeleton.tsx";
import { PageHeading } from "./PageHeading.tsx";
import { legacyRedirects, pageFor, routes } from "./routes.ts";
import { useRunPolling } from "./useRunPolling.ts";
import { useTheme } from "./useTheme.ts";
import { useWorkspaceActions } from "./useWorkspaceActions.ts";

export function App() {
  const location = useLocation();
  const previousPath = useRef(location.pathname);
  const [search] = useSearchParams();
  const view = pageFor(location.pathname);
  const findingId = search.get("finding");
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const clearTrigger = useRef<HTMLButtonElement>(null);
  const [api, setApi] = useState<DashboardApi | null>(null);
  const { state, actions } = useDashboardState();
  const { project, report, history, plan, runs, campaigns, runProfile, providers, busy } = state;
  const [announcement, setAnnouncement] = useState("");
  const theme = useTheme(api, setAnnouncement);
  const { activeRunId, activeCampaignId } = useRunPolling(
    api,
    runs,
    campaigns,
    actions,
    setAnnouncement,
  );
  const operationBlocked = !!busy || !!activeRunId || !!activeCampaignId;
  const workspace = useWorkspaceActions({
    api,
    project,
    operationBlocked,
    actions,
    announce: setAnnouncement,
  });

  useLayoutEffect(() => {
    if (previousPath.current !== location.pathname) {
      previousPath.current = location.pathname;
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [location.pathname]);

  const { setTheme } = theme;
  useEffect(() => {
    let active = true;
    connect()
      .then(async (api) => {
        const savedProviders = await api.providers();
        if (active) {
          actions.setProviders(savedProviders);
          setApi(api);
          setTheme(api.initialState.theme);
          actions.restore(api.initialState);
        }
      })
      .catch(() => {
        if (active)
          actions.setError(
            "Unable to connect to the local service. Restart Plenger and reload this page.",
          );
      });
    return () => {
      active = false;
    };
  }, [actions, setTheme]);

  const isInitializing = !api && !state.error;
  const available = !!api && !operationBlocked;
  const scan = () => void workspace.runScan();
  const scanActions = (
    <div className="scan-actions">
      <Button
        type="button"
        className="button button-secondary"
        disabled={!report}
        onClick={() => {
          if (report) downloadJson(`plenger-${report.id}.json`, report);
        }}
      >
        <Icon name="download" /> Export JSON
      </Button>
      <Button type="button" className="button button-primary" disabled={!available} onClick={scan}>
        <Icon name="scan" /> {report ? "Rescan project" : "Scan project"}
      </Button>
    </div>
  );
  return (
    <DashboardProvider api={api}>
      <div className="app-shell">
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <AppSidebar
          project={project}
          initializing={isInitializing}
          switcherDisabled={!available}
          pickerTrigger={pickerTrigger}
          onOpenPicker={workspace.openPicker}
          theme={theme.theme}
          themeDisabled={!api}
          themeSaving={theme.saving}
          onToggleTheme={() => void theme.toggle()}
          findingCount={report?.scan.findings.length ?? 0}
          historyCount={history.length}
        />
        <div className="app-main">
          <AppTopbar view={view} project={project} report={report} actions={scanActions} />
          <main id="main-content" tabIndex={-1} aria-busy={isInitializing}>
            {isInitializing ? (
              <DashboardSkeleton
                overview={view === "overview"}
                findings={view === "findings"}
                settings={view === "settings"}
                inventory={view === "inventory"}
              />
            ) : (
              <>
                <PageHeading view={view} report={report} />
                <div className="sr-only" role="status">
                  {announcement}
                </div>
                {theme.error && (
                  <div role="alert" className="status-banner error-banner">
                    <p>{theme.error}</p>
                  </div>
                )}
                {state.error && (
                  <div role="alert" className="status-banner error-banner">
                    <p>{state.error}</p>
                    {!api && (
                      <Button
                        type="button"
                        className="button button-secondary"
                        onClick={() => window.location.reload()}
                      >
                        Reload page
                      </Button>
                    )}
                  </div>
                )}
                {busy === "scan" && (
                  <div className="status-banner scan-progress">
                    <span className="spinner" />
                    <div>
                      <strong>Reading source and tracing agent capabilities</strong>
                      <p className="muted">Findings will appear when analysis completes.</p>
                    </div>
                  </div>
                )}
                <Routes>
                  <Route
                    path={routes.overview}
                    element={
                      report ? (
                        <Overview key={report.id} report={report} history={history} />
                      ) : (
                        <Welcome onScan={scan} available={available} />
                      )
                    }
                  />
                  <Route
                    path={routes.findings}
                    element={
                      report ? (
                        <FindingsView
                          key={`${report.id}:${findingId ?? "all"}`}
                          report={report}
                          initialSelection={findingId}
                        />
                      ) : (
                        <NeedsScan onScan={scan} available={available} label="Findings" />
                      )
                    }
                  />
                  <Route
                    path={routes.inventory}
                    element={
                      report ? (
                        <InventoryView key={report.id} report={report} />
                      ) : (
                        <NeedsScan onScan={scan} available={available} label="Inventory" />
                      )
                    }
                  />
                  <Route
                    path={routes.redteam}
                    element={
                      <RedteamView
                        project={project}
                        plan={plan}
                        busy={busy === "plan"}
                        disabled={!available}
                        error={state.planError}
                        onPlan={(target) => void workspace.reviewPlan(target)}
                        runs={runs}
                        campaigns={campaigns}
                        profile={runProfile}
                        providers={providers}
                        onCampaignUpdate={actions.updateCampaign}
                      />
                    }
                  />
                  <Route
                    path={routes.providers}
                    element={
                      <ProvidersView providers={providers} onChange={actions.setProviders} />
                    }
                  />
                  {legacyRedirects.map((redirect) => (
                    <Route
                      key={redirect.from}
                      path={redirect.from}
                      element={<Navigate to={redirect.to} replace />}
                    />
                  ))}
                  <Route
                    path={routes.history}
                    element={
                      <HistoryView
                        history={history}
                        available={available}
                        clearTrigger={clearTrigger}
                        onScan={scan}
                        onOpen={(item) => void workspace.openHistory(item)}
                        onClear={workspace.openClearDialog}
                      />
                    }
                  />
                  <Route path="*" element={<Navigate to={routes.overview} replace />} />
                </Routes>
              </>
            )}
          </main>
        </div>
        {api && (
          <ProjectPicker
            initial={project}
            open={workspace.picker}
            returnFocus={pickerTrigger}
            onClose={workspace.closePicker}
            onSelect={workspace.selectProject}
          />
        )}
        <ClearSavedData
          open={workspace.clearOpen}
          busy={busy === "clear"}
          error={workspace.clearError}
          returnFocus={clearTrigger}
          onClose={workspace.closeClearDialog}
          onClear={workspace.clearSavedData}
        />
      </div>
    </DashboardProvider>
  );
}
