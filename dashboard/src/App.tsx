import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Link,
  matchPath,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router";
import type {
  DashboardScan,
  DashboardScanSummary,
  DashboardState,
  DashboardTheme,
  SavedRunProfile,
} from "../../src/dashboard/model.ts";
import type { ProjectPlan } from "../../src/redteam/plan.ts";
import type { RedteamRun } from "../../src/redteam/run.ts";
import { connect, type DashboardApi } from "./api.ts";
import { ClearSavedData } from "./ClearSavedData.tsx";
import { DashboardSkeleton } from "./DashboardSkeleton.tsx";
import { FindingsView } from "./FindingsView.tsx";
import { Icon, Mark } from "./icons.tsx";
import { MorphNumber } from "./MorphNumber.tsx";
import Overview from "./Overview.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { useElementScrollbars } from "./ScrollArea.tsx";
import { Button } from "./ui.tsx";
import { InventoryView, RedteamView } from "./views.tsx";

type View = "overview" | "findings" | "inventory" | "redteam" | "history";
const pages: { id: View; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "findings", label: "Findings" },
  { id: "inventory", label: "Inventory" },
  { id: "redteam", label: "Red-team" },
  { id: "history", label: "Scan history" },
];
function routeFor(view: View): string {
  return view === "overview" ? "/" : `/${view}`;
}
function nameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project";
}
function date(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export function App() {
  const location = useLocation();
  const previousPath = useRef(location.pathname);
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const view =
    pages.find((page) => matchPath({ path: routeFor(page.id), end: true }, location.pathname))
      ?.id ?? "overview";
  const findingId = search.get("finding");
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const clearTrigger = useRef<HTMLButtonElement>(null);
  const navigationScrollbars = useElementScrollbars<HTMLElement>("x");
  const [api, setApi] = useState<DashboardApi | null>(null);
  const [project, setProject] = useState("");
  const [report, setReport] = useState<DashboardScan | null>(null);
  const [history, setHistory] = useState<DashboardScanSummary[]>([]);
  const [plan, setPlan] = useState<ProjectPlan | null>(null);
  const [runs, setRuns] = useState<RedteamRun[]>([]);
  const [runProfile, setRunProfile] = useState<SavedRunProfile | null>(null);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState<"scan" | "plan" | "project" | "history" | "clear" | null>(null);
  const [error, setError] = useState("");
  const [planError, setPlanError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [clearOpen, setClearOpen] = useState(false);
  const [clearError, setClearError] = useState("");
  const [theme, setTheme] = useState<DashboardTheme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const [savingTheme, setSavingTheme] = useState(false);
  const [themeError, setThemeError] = useState("");
  const restore = useCallback((state: DashboardState) => {
    setProject(state.project);
    setReport(state.report);
    setPlan(state.plan);
    setRuns(state.runs);
    setRunProfile(state.runProfile);
    setHistory(state.history);
    setError("");
    setPlanError(null);
  }, []);
  const updateRun = useCallback((run: RedteamRun) => {
    setRuns((previous) =>
      [run, ...previous.filter((item) => item.id !== run.id)]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, 20),
    );
  }, []);
  const activeRunId = runs.find((run) => run.state === "preparing" || run.state === "running")?.id;
  const operationBlocked = !!busy || !!activeRunId;

  useEffect(() => {
    if (!api || !activeRunId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const run = await api.getRun(activeRunId);
        if (!disposed) {
          updateRun(run);
          if (run.finishedAt)
            setAnnouncement(`Red-team run ${run.state}. Review its evidence and coverage.`);
        }
      } catch {
        if (!disposed)
          setAnnouncement("Unable to refresh run progress. Reconnecting to the local service…");
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [api, activeRunId, updateRun]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    const color = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (color) color.content = theme === "dark" ? "#0b0b0b" : "#fafafa";
    const scheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (scheme) scheme.content = theme;
  }, [theme]);

  useLayoutEffect(() => {
    if (previousPath.current !== location.pathname) {
      previousPath.current = location.pathname;
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [location.pathname]);

  useEffect(() => {
    let active = true;
    connect()
      .then((api) => {
        if (active) {
          setApi(api);
          setTheme(api.initialState.theme);
          restore(api.initialState);
        }
      })
      .catch(() => {
        if (active)
          setError("Unable to connect to the local service. Restart Plenger and reload this page.");
      });
    return () => {
      active = false;
    };
  }, [restore]);

  async function toggleTheme() {
    if (!api || savingTheme) return;
    const previous = theme;
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setSavingTheme(true);
    setThemeError("");
    try {
      await api.setTheme(next);
      setAnnouncement(`${next === "dark" ? "Dark" : "Light"} mode enabled.`);
    } catch {
      setTheme(previous);
      setThemeError("Could not save your theme. Try switching again.");
    } finally {
      setSavingTheme(false);
    }
  }

  async function runScan(path = project) {
    if (!api || operationBlocked) return;
    setBusy("scan");
    setError("");
    setAnnouncement("Scanning source code…");
    try {
      const result = await api.scan(path);
      setReport(result);
      setProject(result.scan.root);
      setPlan(null);
      setPlanError(null);
      setHistory((history) => [
        {
          id: result.id,
          createdAt: result.createdAt,
          project: result.scan.root,
          findings: result.scan.findings.length,
          files: result.scan.files.length,
        },
        ...history,
      ]);
      setAnnouncement(
        `Scan complete. ${result.scan.findings.length} findings across ${result.scan.files.length} source files.`,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to scan this project. Try again.");
      setAnnouncement("Scan could not complete.");
    } finally {
      setBusy(null);
    }
  }
  async function reviewPlan(target?: string) {
    if (!api || operationBlocked) return;
    setBusy("plan");
    setPlanError(null);
    setAnnouncement("Reviewing project preparation…");
    try {
      const result = await api.plan(project, target);
      setPlan(result);
      setAnnouncement(
        "Project preparation reviewed. Check runtime eligibility before starting a run.",
      );
    } catch (error) {
      setPlanError(
        error instanceof Error ? error.message : "Unable to review project preparation. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }
  async function selectProject(path: string) {
    if (!api || operationBlocked) return;
    setBusy("project");
    try {
      const state = await api.selectProject(path);
      restore(state);
      setPicker(false);
      void navigate("/");
      setAnnouncement(`Selected ${nameOf(state.project)}.`);
    } finally {
      setBusy(null);
    }
  }
  async function openHistory(item: DashboardScanSummary) {
    if (!api || operationBlocked) return;
    setBusy("history");
    setError("");
    try {
      restore(await api.openScan(item.id));
      void navigate("/");
      setAnnouncement("Viewing a saved scan. Rescan for current source code.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to open this saved scan.");
    } finally {
      setBusy(null);
    }
  }
  async function clearSavedData() {
    if (!api || operationBlocked) return;
    setBusy("clear");
    setClearError("");
    try {
      restore(await api.clear());
      setClearOpen(false);
      setAnnouncement("Saved dashboard data cleared. Your project files are unchanged.");
    } catch (error) {
      setClearError(
        error instanceof Error ? error.message : "Unable to clear saved data. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }
  function download() {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `plenger-${report.id}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const selectedPage = pages.find((page) => page.id === view);
  const isInitializing = !api && !error;
  const descriptions: Record<View, string> = {
    overview: report
      ? "Source findings, agent composition, and analysis coverage in one place."
      : "Understand what your agent can reach, starting with its source code.",
    findings: "Follow the evidence. Review what matters most.",
    inventory: "Explore the models, tools, and connections in your project.",
    redteam: "Test your agent, understand the results, and review the evidence.",
    history: "Revisit your saved scans, even after a refresh or restart.",
  };
  const overviewActions = (
    <div className="overview-actions">
      <Button
        type="button"
        className="button button-secondary"
        disabled={!report}
        onClick={download}
      >
        <Icon name="download" /> Export JSON
      </Button>
      <Button
        type="button"
        className="button button-primary"
        disabled={!api || operationBlocked}
        onClick={() => void runScan()}
      >
        <Icon name="scan" /> {report ? "Rescan project" : "Scan project"}
      </Button>
    </div>
  );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="workspace-header">
        <div className="workspace-topbar">
          <div className="workspace-identity">
            <Link className="brand" to="/" aria-label="Plenger overview">
              <Mark />
              {/*<span>plenger</span>*/}
            </Link>
            <span className="header-divider" aria-hidden="true" />
            <Button
              ref={pickerTrigger}
              className="project-switcher"
              disabled={!api || operationBlocked}
              onClick={() => setPicker(true)}
              aria-label={`Select project${project ? `, current project ${nameOf(project)}` : ""}`}
            >
              <Icon name="folder" />
              {isInitializing ? (
                <span className="skeleton-block skeleton-project-name" aria-hidden="true" />
              ) : (
                <strong>{project ? nameOf(project) : "Select project"}</strong>
              )}
              <Icon name="chevron" className="project-switcher-arrow" />
            </Button>
          </div>
          <div className="workspace-status">
            <Button
              className="icon-button theme-toggle"
              disabled={!api}
              aria-disabled={savingTheme}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              onClick={() => void toggleTheme()}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </Button>
          </div>
        </div>
      </header>
      <div className="workspace-nav-row">
        <nav
          ref={navigationScrollbars}
          data-overlayscrollbars-initialize=""
          aria-label="Workspace navigation"
        >
          {pages.map((page) => (
            <NavLink
              key={page.id}
              to={routeFor(page.id)}
              end
              className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
            >
              <span>{page.label}</span>
              {page.id === "findings" && (
                <span className="nav-count">
                  <MorphNumber value={report?.scan.findings.length ?? 0} />
                </span>
              )}
              {page.id === "history" && (
                <span className="nav-count">
                  <MorphNumber value={history.length} />
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="main-shell">
        <main id="main-content" tabIndex={-1} aria-busy={isInitializing}>
          {isInitializing ? (
            <DashboardSkeleton
              overview={view === "overview"}
              findings={view === "findings"}
              actions={view === "overview" ? overviewActions : undefined}
            />
          ) : (
            <>
              <div
                className={`page-heading ${view === "findings" && report ? "findings-page-heading" : ""}`}
              >
                <div>
                  <p className="eyebrow">
                    {view === "overview" ? "Source security" : "Your workspace"}
                  </p>
                  <h1>
                    {view === "overview"
                      ? report
                        ? "Project overview"
                        : "Start with your agent."
                      : selectedPage?.label}
                    {view === "findings" && report && (
                      <span className="findings-heading-count">
                        <MorphNumber value={report.scan.findings.length} />
                      </span>
                    )}
                  </h1>
                  {!(view === "findings" && report) && (
                    <p className="muted">{descriptions[view]}</p>
                  )}
                </div>
                {view === "overview" && overviewActions}
                {view === "findings" && report && (
                  <div className="findings-snapshot">
                    <span className="tag">Static analysis</span>
                    <span className="muted">
                      Scanned <time dateTime={report.createdAt}>{date(report.createdAt)}</time>
                    </span>
                  </div>
                )}
              </div>
              <div className="sr-only" role="status">
                {announcement}
              </div>
              {themeError && (
                <div role="alert" className="status-banner error-banner">
                  <p>{themeError}</p>
                </div>
              )}
              {error && (
                <div role="alert" className="status-banner error-banner">
                  <p>{error}</p>
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
                  path="/"
                  element={
                    report ? (
                      <Overview key={report.id} report={report} history={history} />
                    ) : (
                      <Welcome
                        onScan={() => void runScan()}
                        available={!!api && !operationBlocked}
                      />
                    )
                  }
                />
                <Route
                  path="/findings"
                  element={
                    report ? (
                      <FindingsView
                        key={`${report.id}:${findingId ?? "all"}`}
                        report={report}
                        initialSelection={findingId}
                      />
                    ) : (
                      <NeedsScan
                        onScan={() => void runScan()}
                        available={!!api && !operationBlocked}
                        label="Findings"
                      />
                    )
                  }
                />
                <Route
                  path="/inventory"
                  element={
                    report ? (
                      <InventoryView key={report.id} report={report} />
                    ) : (
                      <NeedsScan
                        onScan={() => void runScan()}
                        available={!!api && !operationBlocked}
                        label="Inventory"
                      />
                    )
                  }
                />
                <Route
                  path="/redteam"
                  element={
                    <RedteamView
                      project={project}
                      plan={plan}
                      busy={busy === "plan"}
                      disabled={operationBlocked || !api}
                      error={planError}
                      onPlan={(target) => void reviewPlan(target)}
                      api={api}
                      runs={runs}
                      profile={runProfile}
                      onRunUpdate={updateRun}
                    />
                  }
                />
                <Route
                  path="/history"
                  element={
                    <section className="panel history-panel">
                      <div className="section-heading">
                        <div>
                          <h2>Saved scans</h2>
                          <p className="muted">
                            Select a captured result to revisit its findings and inventory.
                          </p>
                        </div>
                        <div className="history-actions">
                          <span className="tag">
                            {history.length} {history.length === 1 ? "scan" : "scans"}
                          </span>
                          <Button
                            ref={clearTrigger}
                            className="button button-secondary"
                            disabled={!api || operationBlocked}
                            onClick={() => {
                              setClearError("");
                              setClearOpen(true);
                            }}
                          >
                            <Icon name="trash" /> Clear saved data
                          </Button>
                        </div>
                      </div>
                      {history.length === 0 ? (
                        <NeedsScan
                          onScan={() => void runScan()}
                          available={!!api && !operationBlocked}
                          label="Scan history"
                        />
                      ) : (
                        <div className="history-list">
                          {history.map((item) => (
                            <Button
                              type="button"
                              key={item.id}
                              className="history-row"
                              disabled={!api || operationBlocked}
                              onClick={() => void openHistory(item)}
                            >
                              <span className="history-icon">
                                <Icon name="history" />
                              </span>
                              <span>
                                <strong>{nameOf(item.project)}</strong>
                                <span className="muted break-path">{item.project}</span>
                              </span>
                              <span className="history-date">{date(item.createdAt)}</span>
                              <span className="tag">{item.findings} findings</span>
                              <Icon name="chevron" />
                            </Button>
                          ))}
                        </div>
                      )}
                      <p className="panel-footnote history-summary">
                        Saved locally across refreshes and restarts. These are captured results;
                        rescan your project to review current source code.
                      </p>
                    </section>
                  }
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              <footer className="page-footer">
                <span>Static findings are review hypotheses, not verified exploits.</span>
                <span>Built for agentic systems.</span>
              </footer>
            </>
          )}
        </main>
      </div>
      {api && (
        <ProjectPicker
          api={api}
          initial={project}
          open={picker}
          returnFocus={pickerTrigger}
          onClose={() => setPicker(false)}
          onSelect={selectProject}
        />
      )}
      <ClearSavedData
        open={clearOpen}
        busy={busy === "clear"}
        error={clearError}
        returnFocus={clearTrigger}
        onClose={() => setClearOpen(false)}
        onClear={clearSavedData}
      />
    </div>
  );
}

function Welcome({ onScan, available }: { onScan: () => void; available: boolean }) {
  return (
    <div className="welcome-layout">
      <section className="welcome-panel">
        <div className="welcome-art welcome-emblem" aria-hidden="true">
          <Icon name="redteam" />
        </div>
        <p className="eyebrow">Start with the source</p>
        <h2>
          Know your agent.
          <br />
          See its reach.
        </h2>
        <p className="welcome-description">
          Scan your project to map its models, tools, and entry points — and see the code paths that
          deserve a closer look.
        </p>
        <Button
          type="button"
          className="button button-primary"
          disabled={!available}
          onClick={onScan}
        >
          <Icon name="scan" />
          Scan this project
        </Button>
        <div className="welcome-note">
          <Icon name="check" />
          No project setup or API key required
        </div>
      </section>
      <section className="getting-started">
        <p className="eyebrow">Three steps to a clearer picture</p>
        <h2>Your review workflow</h2>
        <ol className="workflow-list">
          <li>
            <span className="step-number">01</span>
            <div>
              <h3>Map the agent</h3>
              <p>Find models, tools, routes, and the capabilities connected to them.</p>
            </div>
          </li>
          <li>
            <span className="step-number">02</span>
            <div>
              <h3>Review the findings</h3>
              <p>Prioritize by severity and confidence, then inspect the source evidence.</p>
            </div>
          </li>
          <li>
            <span className="step-number">03</span>
            <div>
              <h3>Prepare for red-teaming</h3>
              <p>Review discovered llmfy targets and preparation gaps.</p>
              <span className="tag">Preparation preview</span>
            </div>
          </li>
        </ol>
        <div className="quiet-note">
          <Icon name="redteam" />
          <p>
            Python, JavaScript, and TypeScript source. Your project code is never executed during
            analysis.
          </p>
        </div>
      </section>
    </div>
  );
}
function NeedsScan({
  onScan,
  available,
  label,
}: {
  onScan: () => void;
  available: boolean;
  label: string;
}) {
  return (
    <section className="empty-state panel">
      <Icon name="scan" />
      <h2>{label} starts with a scan</h2>
      <p className="muted">
        Scan the selected project to inspect its agent inventory and source findings.
      </p>
      <Button
        type="button"
        className="button button-primary"
        disabled={!available}
        onClick={onScan}
      >
        Scan project
      </Button>
    </section>
  );
}
