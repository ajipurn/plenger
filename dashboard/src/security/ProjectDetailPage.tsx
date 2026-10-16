import { useId, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { type SecurityWorkspace, WORKSPACE_LIMITS } from "../../../src/dashboard/contract.ts";
import { SEVERITIES } from "../../../src/rules/model.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { Button, Input } from "../shared/ui.tsx";
import { costLabel } from "./ScanBilling.tsx";
import { ScansTable } from "./ScansTable.tsx";
import { date, Empty, FindingsTable, Pagination, ScanDuration, ScanStatus } from "./ui.tsx";

export function ProjectDetailPage({
  data,
  onNewScan,
}: {
  data: SecurityWorkspace;
  onNewScan: (id: string) => void;
}) {
  const { id } = useParams();
  const searchId = useId();
  const [params] = useSearchParams();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const project = data.repositories.find((item) => item.id === id);
  if (!project)
    return (
      <Empty
        title="Project not found"
        description="Return to Projects to choose a saved local folder."
        action={
          <Link className="button button-primary" to="/projects">
            All projects
          </Link>
        }
      />
    );
  const path = `/projects/${encodeURIComponent(project.id)}`;
  const scans = data.scans.filter((scan) => scan.repositoryId === project.id);
  const latest = scans[0];
  const findings = data.findings.filter((finding) => finding.repositoryId === project.id);
  const open = findings.filter(
    (finding) => finding.status !== "resolved" && finding.status !== "dismissed",
  ).length;
  const matches = findings
    .filter((finding) =>
      `${finding.title} ${finding.rootCause}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const scansView = params.get("tab") === "scans";
  const total = scansView ? scans.length : matches.length;
  const pageSize = WORKSPACE_LIMITS.pageSize;
  const current = Math.min(page, Math.max(0, Math.ceil(total / pageSize) - 1));
  const names = new Map([[project.id, project.name]]);
  const active = data.scans.some((scan) => scan.status === "running");
  const revision = latest?.revision ?? project.revision;
  const scanPath = latest
    ? `/scans/${encodeURIComponent(latest.id)}?project=${encodeURIComponent(project.id)}`
    : "";
  return (
    <div className="security-project-page">
      <Link to="/projects" className="security-back-link">
        <Icon name="chevron" /> All projects
      </Link>
      <header className="security-scan-heading">
        <div className="security-scan-identity">
          <div>
            <h1>{project.name}</h1>
          </div>
          <p className="muted security-project-detail-path">{project.path}</p>
        </div>
        <Button
          className="button button-primary"
          disabled={active}
          onClick={() => onNewScan(project.id)}
        >
          <Icon name="scan" /> New Scan
        </Button>
      </header>
      <dl className="security-scan-summary" aria-label="Project summary">
        <div>
          <dt>
            <Icon name="findings" /> Open findings
          </dt>
          <dd>
            <MorphNumber value={open} />
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="checklist" /> Saved findings
          </dt>
          <dd>
            <MorphNumber value={findings.length} />
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="scan" /> Scans
          </dt>
          <dd>
            <MorphNumber value={scans.length} />
          </dd>
        </div>
      </dl>
      <div className="security-detail-layout security-scan-layout">
        <section className="security-detail-main" aria-label="Project results">
          <nav className="security-subnav" aria-label="Project detail">
            <Link
              to={path}
              aria-current={!scansView ? "page" : undefined}
              onClick={() => setPage(0)}
            >
              <Icon name="findings" /> Findings{" "}
              <span className="security-count">
                <MorphNumber value={findings.length} />
              </span>
            </Link>
            <Link
              to={`${path}?tab=scans`}
              aria-current={scansView ? "page" : undefined}
              onClick={() => setPage(0)}
            >
              <Icon name="history" /> Scans{" "}
              <span className="security-count">
                <MorphNumber value={scans.length} />
              </span>
            </Link>
          </nav>
          {latest?.status === "running" && (
            <p className="security-project-notice" role="status">
              <span className="spinner" aria-hidden="true" /> Scan in progress.
              <Link className="security-text-link" to={scanPath}>
                View progress
              </Link>
            </p>
          )}
          {!scans.length ? (
            <Empty
              title="No scans yet"
              description="Start a scan to generate security findings and source analysis for this project."
            />
          ) : scansView ? (
            <>
              <ScansTable
                scans={scans.slice(current * pageSize, current * pageSize + pageSize)}
                names={names}
                projectId={project.id}
              />
              <Pagination page={current} count={pageSize} total={scans.length} onChange={setPage} />
            </>
          ) : (
            <>
              {findings.length > 0 && (
                <div className="security-toolbar">
                  <div className="security-search">
                    <Icon name="search" />
                    <label htmlFor={`${searchId}-search`} className="sr-only">
                      Search project findings
                    </label>
                    <Input
                      id={`${searchId}-search`}
                      type="search"
                      placeholder="Search project findings"
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setPage(0);
                      }}
                    />
                  </div>
                </div>
              )}
              {matches.length ? (
                <>
                  <FindingsTable
                    findings={matches.slice(current * pageSize, current * pageSize + pageSize)}
                    names={names}
                    projectId={project.id}
                  />
                  <Pagination
                    page={current}
                    count={pageSize}
                    total={matches.length}
                    onChange={setPage}
                  />
                </>
              ) : (
                <Empty
                  title={findings.length ? "No findings match" : "No saved findings"}
                  description={
                    findings.length
                      ? "Try another finding title or clear the search."
                      : "Review the latest scan's outputs for source coverage and limitations."
                  }
                  action={
                    findings.length ? (
                      <Button className="button button-secondary" onClick={() => setQuery("")}>
                        Clear search
                      </Button>
                    ) : (
                      <Link className="button button-secondary" to={`${scanPath}&tab=outputs`}>
                        View scan outputs
                      </Link>
                    )
                  }
                />
              )}
            </>
          )}
        </section>
        <aside className="security-detail-meta security-scan-meta" aria-label="Project details">
          <section>
            <h2>
              <Icon name="folder" /> Project
            </h2>
            <dl>
              <div className="security-meta-path">
                <dt>Local folder</dt>
                <dd>
                  <code>{project.path}</code>
                </dd>
              </div>
              <div>
                <dt>Environment</dt>
                <dd>{project.environment.name}</dd>
              </div>
              <div>
                <dt>Last observed revision</dt>
                <dd>
                  <code>{revision.commit?.slice(0, 12) ?? "Local files"}</code>
                  {revision.branch && <small>{revision.branch}</small>}
                  {revision.dirty && <small>Includes uncommitted changes</small>}
                </dd>
              </div>
              <div>
                <dt>Added</dt>
                <dd>{date(project.createdAt)}</dd>
              </div>
            </dl>
            {project.environment.notes && (
              <details className="security-scan-context">
                <summary>Review context</summary>
                <p>{project.environment.notes}</p>
              </details>
            )}
          </section>
          <section>
            <h2>
              <Icon name="scan" /> Latest scan
            </h2>
            {latest ? (
              <>
                <dl>
                  <div>
                    <dt>Status</dt>
                    <dd>
                      <Link to={scanPath}>
                        <ScanStatus scan={latest} />
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd>{date(latest.startedAt)}</dd>
                  </div>
                  <div>
                    <dt>{latest.status === "running" ? "Elapsed time" : "Duration"}</dt>
                    <dd>
                      <ScanDuration scan={latest} />
                    </dd>
                  </div>
                  <div>
                    <dt>Provider</dt>
                    <dd>
                      {latest.provider?.name ?? "Offline scan"}
                      <small>{latest.provider?.model}</small>
                    </dd>
                  </div>
                  <div>
                    <dt>Tokens used</dt>
                    <dd>
                      {latest.tokens === null ? (
                        "Unavailable"
                      ) : (
                        <MorphNumber value={latest.tokens} />
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Estimated cost</dt>
                    <dd>
                      {latest.cost ? <MorphNumber value={costLabel(latest.cost)} /> : "Unavailable"}
                    </dd>
                  </div>
                </dl>
                <Link
                  className="security-text-link security-project-outputs-link"
                  to={`${scanPath}&tab=outputs`}
                >
                  View scan outputs <Icon name="arrow-right" />
                </Link>
              </>
            ) : (
              <p className="muted">Not scanned yet.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
