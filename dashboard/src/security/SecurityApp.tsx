import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router";
import type { SecurityWorkspace } from "../../../src/dashboard/contract.ts";
import { SECURITY_POLL_MS } from "../../../src/dashboard/contract.ts";
import type { SavedProvider } from "../../../src/redteam/provider-config.ts";
import { connect, type DashboardApi } from "../api/client.ts";
import { DashboardProvider } from "../app/DashboardContext.tsx";
import { useTheme } from "../app/useTheme.ts";
import { errorMessage } from "../shared/async.ts";
import { Icon } from "../shared/icons.tsx";
import { Button } from "../shared/ui.tsx";

const ProvidersView = lazy(() =>
  import("../providers/ProvidersView.tsx").then((module) => ({
    default: module.ProvidersView,
  })),
);
const SettingsLayout = lazy(() =>
  import("../settings/SettingsLayout.tsx").then((module) => ({
    default: module.SettingsLayout,
  })),
);
const DataSettings = lazy(() =>
  import("../settings/DataSettings.tsx").then((module) => ({
    default: module.DataSettings,
  })),
);
const AppearanceSettings = lazy(() =>
  import("../settings/AppearanceSettings.tsx").then((module) => ({
    default: module.AppearanceSettings,
  })),
);
const RedteamComingSoon = lazy(() =>
  import("../redteam/RedteamComingSoon.tsx").then((module) => ({
    default: module.RedteamComingSoon,
  })),
);
const FindingsPage = lazy(() =>
  import("./FindingsPage.tsx").then((module) => ({
    default: module.FindingsPage,
  })),
);
const FindingPage = lazy(() =>
  import("./FindingPage.tsx").then((module) => ({
    default: module.FindingPage,
  })),
);
const ProjectsPage = lazy(() =>
  import("./ProjectsPage.tsx").then((module) => ({
    default: module.ProjectsPage,
  })),
);
const ProjectDetailPage = lazy(() =>
  import("./ProjectDetailPage.tsx").then((module) => ({
    default: module.ProjectDetailPage,
  })),
);
const ScansPage = lazy(() =>
  import("./ScansPage.tsx").then((module) => ({ default: module.ScansPage })),
);
const ScanDetailPage = lazy(() =>
  import("./ScanDetailPage.tsx").then((module) => ({
    default: module.ScanDetailPage,
  })),
);
const NewScanForm = lazy(() =>
  import("./ScanForms.tsx").then((module) => ({ default: module.NewScanForm })),
);
const ProjectForm = lazy(() =>
  import("./ScanForms.tsx").then((module) => ({ default: module.ProjectForm })),
);

const EMPTY: SecurityWorkspace = { repositories: [], scans: [], findings: [] };
export function SecurityApp() {
  const navigate = useNavigate();
  const location = useLocation();
  const previousPath = useRef(location.pathname);
  const [api, setApi] = useState<DashboardApi | null>(null);
  const [data, setData] = useState(EMPTY);
  const [providers, setProviders] = useState<SavedProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [newScan, setNewScan] = useState(false);
  const [addRepository, setAddRepository] = useState(false);
  const [formsRequested, setFormsRequested] = useState(false);
  const [repositoryId, setRepositoryId] = useState("");
  const [resumeNewScan, setResumeNewScan] = useState(false);
  const newTrigger = useRef<HTMLButtonElement>(null);
  const newReturnFocus = useRef<HTMLElement | null>(null);
  const addTrigger = useRef<HTMLElement | null>(null);
  const theme = useTheme(api, setAnnouncement);
  const { setTheme } = theme;
  const active = data.scans.some((scan) => scan.status === "running");
  const detailPage = /^\/(findings|scans|projects)\//.test(location.pathname);
  useEffect(() => {
    let stopped = false;
    void connect()
      .then(async (client) => {
        const [workspace, saved] = await Promise.all([
          client.securityWorkspace(),
          client.providers(),
        ]);
        if (!stopped) {
          setApi(client);
          setData(workspace);
          setProviders(saved);
          setTheme(client.initialState.theme);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!stopped) {
          setError("Unable to connect to the local service. Restart Plenger and reload this page.");
          setLoading(false);
        }
      });
    return () => {
      stopped = true;
    };
  }, [setTheme]);
  const refresh = useCallback(async () => {
    if (!api) return;
    const next = await api.securityWorkspace();
    setData(next);
    setError("");
  }, [api]);
  useEffect(() => {
    if (!api || !active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.securityWorkspace();
        if (!stopped) setData(next);
      } catch {
        if (!stopped)
          setError("Unable to refresh scan progress. Check the local service connection.");
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), SECURITY_POLL_MS);
      }
    };
    timer = setTimeout(() => void poll(), SECURITY_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, active]);
  useLayoutEffect(() => {
    if (previousPath.current !== location.pathname) {
      previousPath.current = location.pathname;
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [location.pathname]);
  function openNewScan(id = "") {
    newReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRepositoryId(id);
    setFormsRequested(true);
    setNewScan(true);
  }
  function openAdd() {
    addTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFormsRequested(true);
    setAddRepository(true);
  }
  return (
    <DashboardProvider api={api}>
      <div className="security-shell">
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <header className="security-header">
          <div className="security-header-row">
            <div className="security-header-inner">
              <div className="security-workspace-identity">
                <Link
                  className="security-brand"
                  to="/findings"
                  aria-label="Plenger security workspace"
                >
                  {/* <Mark /> */}
                  <span>plenger</span>
                </Link>
              </div>
              <div className="security-header-actions">
                {!detailPage && (
                  <Button
                    ref={newTrigger}
                    className="button button-primary"
                    disabled={!api || active}
                    onClick={() => openNewScan()}
                  >
                    <Icon name="scan" /> New Scan
                  </Button>
                )}
              </div>
            </div>
          </div>
          <div className="security-nav-row">
            <nav className="security-primary-nav" aria-label="Security workspace">
              <NavLink to="/findings">
                <Icon name="findings" /> Findings
              </NavLink>
              <NavLink to="/projects">
                <Icon name="folder" /> Projects
              </NavLink>
              <NavLink to="/scans">
                <Icon name="scan" /> Scans
              </NavLink>
              <NavLink to="/settings">
                <Icon name="settings" /> Settings
              </NavLink>
            </nav>
          </div>
        </header>
        <main id="main-content" className="security-content" tabIndex={-1} aria-busy={loading}>
          <p className="sr-only" role="status">
            {announcement}
          </p>
          {error && (
            <div className="security-service-error" role="alert">
              <p>{error}</p>
              <Button
                className="button button-secondary"
                onClick={() =>
                  api
                    ? void refresh().catch((failure) =>
                        setError(errorMessage(failure, "Unable to refresh workspace.")),
                      )
                    : window.location.reload()
                }
              >
                {api ? "Retry" : "Reload page"}
              </Button>
            </div>
          )}
          {loading ? (
            <div className="security-empty" role="status">
              <span className="spinner" /> Loading security workspace…
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="security-empty" role="status">
                  <span className="spinner" aria-hidden="true" /> Loading page…
                </div>
              }
            >
              <Routes>
                <Route path="/" element={<Navigate to="/findings" replace />} />
                <Route
                  path="/findings"
                  element={<FindingsPage data={data} onNewScan={() => openNewScan()} />}
                />
                <Route
                  path="/findings/:id"
                  element={
                    <FindingPage
                      key={`${location.pathname}:${location.search}`}
                      data={data}
                      providers={providers}
                      onRefresh={refresh}
                    />
                  }
                />
                <Route path="/repositories" element={<Navigate to="/projects" replace />} />
                <Route
                  path="/projects"
                  element={
                    <ProjectsPage
                      projects={data.repositories}
                      scans={data.scans}
                      onAdd={openAdd}
                      onNewScan={openNewScan}
                    />
                  }
                />
                <Route path="/scans" element={<ScansPage data={data} />} />
                <Route
                  path="/projects/:id"
                  element={
                    <ProjectDetailPage
                      key={location.pathname}
                      data={data}
                      onNewScan={openNewScan}
                      onChanged={refresh}
                    />
                  }
                />
                <Route
                  path="/scans/:id"
                  element={
                    <ScanDetailPage
                      key={location.pathname}
                      data={data}
                      onRefresh={refresh}
                      onNewScan={openNewScan}
                    />
                  }
                />
                <Route path="/settings" element={<SettingsLayout />}>
                  <Route index element={<Navigate to="providers" replace />} />
                  <Route
                    path="appearance"
                    element={
                      <AppearanceSettings
                        theme={theme.theme}
                        disabled={!api || theme.saving}
                        error={theme.error}
                        onToggle={() => void theme.toggle()}
                      />
                    }
                  />
                  <Route
                    path="providers"
                    element={<ProvidersView providers={providers} onChange={setProviders} />}
                  />
                  <Route
                    path="data"
                    element={
                      <DataSettings
                        active={active}
                        onCleared={() => {
                          setData(EMPTY);
                          setRepositoryId("");
                          setNewScan(false);
                          setAddRepository(false);
                          setResumeNewScan(false);
                          setError("");
                        }}
                      />
                    }
                  />
                </Route>
                <Route path="/providers" element={<Navigate to="/settings/providers" replace />} />
                <Route path="/history" element={<Navigate to="/scans" replace />} />
                <Route path="/inventory" element={<Navigate to="/projects" replace />} />
                <Route path="/redteam" element={<RedteamComingSoon />} />
                <Route path="*" element={<Navigate to="/findings" replace />} />
              </Routes>
            </Suspense>
          )}
        </main>
        {api && formsRequested && (
          <Suspense
            fallback={
              <span className="sr-only" role="status">
                Loading scan setup…
              </span>
            }
          >
            <ProjectForm
              open={addRepository}
              onClose={() => {
                setAddRepository(false);
                setResumeNewScan(false);
              }}
              returnFocus={() =>
                addTrigger.current?.isConnected ? addTrigger.current : newTrigger.current
              }
              onCreated={(repository) => {
                setData((current) => ({
                  ...current,
                  repositories: [
                    ...current.repositories.filter((item) => item.id !== repository.id),
                    repository,
                  ],
                }));
                void refresh().catch((failure) =>
                  setError(errorMessage(failure, "Unable to refresh projects.")),
                );
                if (resumeNewScan) {
                  setRepositoryId(repository.id);
                  setNewScan(true);
                }
              }}
            />
            <NewScanForm
              key={`${repositoryId}:${newScan}`}
              open={newScan}
              repositoryId={repositoryId}
              repositories={data.repositories}
              providers={providers}
              onClose={() => setNewScan(false)}
              onChanged={refresh}
              returnFocus={() =>
                newReturnFocus.current?.isConnected ? newReturnFocus.current : newTrigger.current
              }
              onAddProject={() => {
                setNewScan(false);
                setResumeNewScan(true);
                openAdd();
              }}
              onStarted={(scan) => {
                setData((current) => ({
                  ...current,
                  scans: [scan, ...current.scans],
                }));
                void refresh().catch((failure) =>
                  setError(errorMessage(failure, "Unable to refresh scans.")),
                );
                navigate(`/scans/${scan.id}`);
              }}
            />
          </Suspense>
        )}
      </div>
    </DashboardProvider>
  );
}
