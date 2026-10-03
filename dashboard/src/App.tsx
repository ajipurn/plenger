import { useEffect, useRef, useState } from "react";
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
import type { DashboardScan } from "../../src/dashboard/model.ts";
import type { ProjectPlan } from "../../src/redteam/plan.ts";
import { connect, type DashboardApi } from "./api.ts";
import { Icon, type IconName, Mark } from "./icons.tsx";
import { MorphText } from "./MorphText.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { Button } from "./ui.tsx";
import { FindingsView, InventoryView, RedteamView } from "./views.tsx";

type View = "overview" | "findings" | "inventory" | "redteam" | "history";
const pages: { id: View; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "overview" },
  { id: "findings", label: "Findings", icon: "findings" },
  { id: "inventory", label: "Inventory", icon: "inventory" },
  { id: "redteam", label: "Red-team", icon: "redteam" },
  { id: "history", label: "Scan history", icon: "history" },
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
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const view =
    pages.find((page) => matchPath({ path: routeFor(page.id), end: true }, location.pathname))
      ?.id ?? "overview";
  const findingId = search.get("finding");
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const [api, setApi] = useState<DashboardApi | null>(null);
  const [project, setProject] = useState("");
  const [report, setReport] = useState<DashboardScan | null>(null);
  const [history, setHistory] = useState<DashboardScan[]>([]);
  const [plan, setPlan] = useState<ProjectPlan | null>(null);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState<"scan" | "plan" | null>(null);
  const [error, setError] = useState("");
  const [planError, setPlanError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    let active = true;
    connect()
      .then((api) => {
        if (active) {
          setApi(api);
          setProject(api.session.workspace);
        }
      })
      .catch(() => {
        if (active)
          setError("Unable to connect to the local service. Restart Plenger and reload this page.");
      });
    return () => {
      active = false;
    };
  }, []);

  async function runScan(path = project) {
    if (!api || busy) return;
    setBusy("scan");
    setError("");
    setAnnouncement("Scanning source code…");
    try {
      const result = await api.scan(path);
      setReport(result);
      setProject(result.scan.root);
      setPlan(null);
      setPlanError(null);
      setHistory((history) => [result, ...history].slice(0, 20));
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
    if (!api || busy) return;
    setBusy("plan");
    setPlanError(null);
    setAnnouncement("Reviewing project preparation…");
    try {
      const result = await api.plan(project, target);
      setPlan(result);
      setAnnouncement("Project preparation reviewed. Dynamic execution is not available yet.");
    } catch (error) {
      setPlanError(
        error instanceof Error ? error.message : "Unable to review project preparation. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }
  function selectProject(path: string) {
    setProject(path);
    setReport(null);
    setPlan(null);
    setError("");
    setPlanError(null);
    setPicker(false);
    void navigate("/");
    setAnnouncement(`Selected ${nameOf(path)}. Ready to scan.`);
  }
  function openHistory(item: DashboardScan) {
    setReport(item);
    setProject(item.scan.root);
    setPlan(null);
    setPlanError(null);
    setError("");
    void navigate("/");
    setAnnouncement("Viewing an earlier scan. Rescan for current source code.");
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
  const descriptions: Record<View, string> = {
    overview: report
      ? "A clear view of your agent’s capabilities and the findings to review."
      : "Understand what your agent can reach, starting with its source code.",
    findings: "Follow the evidence. Review what matters most.",
    inventory: "Explore the models, tools, and connections in your project.",
    redteam: "Discover test targets and review what’s needed for a dynamic run.",
    history: "Revisit the projects you’ve scanned in this session.",
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link className="brand" to="/" aria-label="Plenger overview">
          <Mark />
          <span>
            plenger<span className="brand-dot">.</span>
          </span>
        </Link>
        <p className="sidebar-caption">Agent security workspace</p>
        <p className="nav-label">Workspace</p>
        <nav aria-label="Workspace navigation">
          {pages.map((page) => (
            <NavLink
              key={page.id}
              to={routeFor(page.id)}
              end
              className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
            >
              <Icon name={page.icon} />
              <span>{page.label}</span>
              {page.id === "findings" && report && (
                <span className="nav-count">{report.scan.findings.length}</span>
              )}
              {page.id === "history" && history.length > 0 && (
                <span className="nav-count">{history.length}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Button
            ref={pickerTrigger}
            className="sidebar-project project-switcher"
            disabled={!api || !!busy}
            onClick={() => setPicker(true)}
            aria-label={`Select project${project ? `, current project ${nameOf(project)}` : ""}`}
          >
            <span className="project-monogram">
              <Icon name="folder" />
            </span>
            <span className="project-switcher-copy">
              <strong>{project ? nameOf(project) : "Connecting…"}</strong>
              <span>Select project</span>
            </span>
            <Icon name="chevron" className="project-switcher-arrow" />
          </Button>
          <div className="sidebar-local">
            <div className="local-label">
              <span className="local-dot" /> Running locally
            </div>
            <p>Source analysis stays on this computer.</p>
          </div>
          <span className="version-label">Plenger / early preview</span>
        </div>
      </aside>
      <div className="main-shell">
        <header className="workspace-bar">
          <div className="breadcrumbs">
            <Icon name="folder" />
            <span>{project ? nameOf(project) : "Workspace"}</span>
            <span className="slash">/</span>
            <strong>{selectedPage?.label}</strong>
          </div>
          <span className="offline-label">
            <span className="local-dot" /> Local workspace
          </span>
        </header>
        <main id="main-content" tabIndex={-1}>
          <div className="page-heading">
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
              </h1>
              <p className="muted">{descriptions[view]}</p>
            </div>
            <div className="heading-actions">
              {report && (
                <Button
                  type="button"
                  className="button button-secondary export-button"
                  onClick={download}
                >
                  <Icon name="download" />
                  Export JSON
                </Button>
              )}
              <Button
                type="button"
                className="button button-primary"
                disabled={!api || !!busy}
                onClick={() => void runScan()}
              >
                {busy === "scan" ? <span className="spinner" /> : <Icon name="scan" />}
                <MorphText>
                  {busy === "scan" ? "Scanning…" : report ? "Rescan project" : "Scan project"}
                </MorphText>
              </Button>
            </div>
          </div>
          <div className="sr-only" role="status">
            {announcement}
          </div>
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
                  <Overview key={report.id} report={report} />
                ) : (
                  <Welcome onScan={() => void runScan()} available={!!api && !busy} />
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
                    available={!!api && !busy}
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
                    available={!!api && !busy}
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
                  disabled={!!busy || !api}
                  error={planError}
                  onPlan={(target) => void reviewPlan(target)}
                />
              }
            />
            <Route
              path="/history"
              element={
                <section className="panel history-panel">
                  <div className="section-heading">
                    <div>
                      <h2>Scans in this session</h2>
                      <p className="muted">Select a scan to revisit its findings and inventory.</p>
                    </div>
                    <span className="tag">{history.length} / 20 scans</span>
                  </div>
                  {history.length === 0 ? (
                    <NeedsScan
                      onScan={() => void runScan()}
                      available={!!api && !busy}
                      label="Scan history"
                    />
                  ) : (
                    <div className="history-list">
                      {history.map((item) => (
                        <Button
                          type="button"
                          key={item.id}
                          className="history-row"
                          disabled={!!busy}
                          onClick={() => openHistory(item)}
                        >
                          <span className="history-icon">
                            <Icon name="history" />
                          </span>
                          <span>
                            <strong>{nameOf(item.scan.root)}</strong>
                            <span className="muted break-path">{item.scan.root}</span>
                          </span>
                          <span className="history-date">{date(item.createdAt)}</span>
                          <span className="tag">{item.scan.findings.length} findings</span>
                          <Icon name="chevron" />
                        </Button>
                      ))}
                    </div>
                  )}
                  <p className="panel-footnote history-summary">
                    Session history clears when this page is closed or reloaded. Export a scan to
                    keep it.
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
function Overview({ report }: { report: DashboardScan }) {
  const { scan } = report;
  const [showAllFrameworks, setShowAllFrameworks] = useState(false);
  const frameworks = showAllFrameworks
    ? scan.inventory.frameworks
    : scan.inventory.frameworks.slice(0, 6);
  const highImpact = scan.findings.filter(
    (finding) => finding.severity === "critical" || finding.severity === "high",
  ).length;
  const syntax = scan.files.filter((file) => file.syntaxErrors).length;
  const stats = [
    {
      label: "Findings to review",
      count: scan.findings.length,
      note: `${highImpact} critical or high`,
      icon: "findings" as const,
    },
    {
      label: "Agents discovered",
      count: scan.inventory.agents.length,
      note: "Statically identified",
      icon: "redteam" as const,
    },
    {
      label: "Tools mapped",
      count: scan.inventory.tools.length,
      note: `${scan.inventory.models.length} model clients`,
      icon: "inventory" as const,
    },
    {
      label: "Source files",
      count: scan.files.length,
      note: `${scan.durationMs.toLocaleString()} ms scan time`,
      icon: "folder" as const,
    },
  ];
  return (
    <div className="stack overview-stack">
      <div className="scan-meta">
        <span className="tag tag-success">
          <Icon name="check" />
          Scan complete
        </span>
        <span className="muted">{date(report.createdAt)}</span>
        <span className="muted break-path">{scan.root}</span>
      </div>
      <div className="stats-grid">
        {stats.map((stat) => (
          <div className="stat-card" key={stat.label}>
            <div>
              <span>{stat.label}</span>
              <Icon name={stat.icon} />
            </div>
            <strong>{stat.count.toLocaleString()}</strong>
            <p>{stat.note}</p>
          </div>
        ))}
      </div>
      <div className="overview-columns">
        <section className="panel priority-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Start here</p>
              <h2>Priority findings</h2>
            </div>
            <Link to="/findings" className="text-link">
              View all
              <Icon name="chevron" />
            </Link>
          </div>
          {scan.findings.length ? (
            <div className="priority-list">
              {scan.findings.slice(0, 4).map((finding) => (
                <Link
                  to={`/findings?finding=${encodeURIComponent(finding.fingerprint)}`}
                  className="priority-row"
                  key={finding.fingerprint}
                >
                  <span className={`severity-dot ${finding.severity}`} />
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
            <div className="empty-state compact">
              <Icon name="check" />
              <h3>No findings from the current rules</h3>
              <p className="muted">
                Review coverage and inventory. An empty finding list does not establish runtime
                safety.
              </p>
            </div>
          )}
          <div className="panel-footnote">
            Ranked by severity, confidence, and reachable exposure.
          </div>
        </section>
        <section className="panel framework-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Project composition</p>
              <h2>Frameworks & connections</h2>
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
                      {framework.files.length} source{" "}
                      {framework.files.length === 1 ? "file" : "files"}
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
          <Link to="/inventory" className="text-link">
            Explore inventory
            <Icon name="chevron" />
          </Link>
        </section>
      </div>
      <section className="panel coverage-panel">
        <div className="coverage-heading">
          <Icon name="scan" />
          <div>
            <h2>Analysis coverage</h2>
            <p className="muted">Static observations from this scan’s scope.</p>
          </div>
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
        {(scan.skipped.length > 0 || syntax > 0 || scan.truncated) && (
          <details className="coverage-details">
            <summary>Review analysis gaps</summary>
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
