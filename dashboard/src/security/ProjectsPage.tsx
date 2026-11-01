import { useId, useRef, useState } from "react";
import { Link } from "react-router";
import type {
  LocalRepository,
  SecurityFinding,
  SecurityScanSummary,
} from "../../../src/dashboard/contract.ts";
import { findingValidation } from "../../../src/dashboard/contract.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { type SortColumns, SortHeader, useTableSort } from "../shared/table-sort.tsx";
import { Button, Input } from "../shared/ui.tsx";
import { DeleteProjectDialog, useProjectDeletion } from "./DeleteProjectDialog.tsx";
import { RUNNING_SCAN_REASON } from "./running-scan.ts";
import { date, Empty, isOpenStatus, ScanStatus } from "./ui.tsx";

type ProjectSortKey = "project" | "scanned" | "open";

export function ProjectsPage({
  projects,
  scans,
  findings,
  onAdd,
  onNewScan,
  onChanged,
}: {
  projects: LocalRepository[];
  scans: SecurityScanSummary[];
  findings: SecurityFinding[];
  onAdd: () => void;
  onNewScan: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const deletion = useProjectDeletion(onChanged, addButton);
  const running = scans.some((scan) => scan.status === "running");
  // Open findings across every scan, as the project page counts them, not the last scan's.
  const openFindings = new Map<string, number>();
  for (const finding of findings)
    if (isOpenStatus(finding.status) && findingValidation(finding) !== "dismissed")
      openFindings.set(finding.repositoryId, (openFindings.get(finding.repositoryId) ?? 0) + 1);
  const latestScan = (project: LocalRepository) =>
    scans.find((scan) => scan.repositoryId === project.id);
  // Unscanned projects have no last scan or open count, so they sort last.
  const columns: SortColumns<LocalRepository, ProjectSortKey> = {
    project: { value: (project) => project.name },
    scanned: {
      value: (project) => {
        const latest = latestScan(project);
        return latest ? Date.parse(latest.startedAt) : null;
      },
      first: "descending",
    },
    open: {
      value: (project) => (latestScan(project) ? (openFindings.get(project.id) ?? 0) : null),
      first: "descending",
    },
  };
  const { sort, toggle, apply } = useTableSort<LocalRepository, ProjectSortKey>(columns, {
    key: "scanned",
    direction: "descending",
  });
  const filtered = apply(
    projects.filter((item) =>
      `${item.name} ${item.path}`.toLowerCase().includes(query.toLowerCase()),
    ),
  );
  return (
    <>
      <header className="security-page-heading">
        <div>
          <h1>
            Projects{" "}
            <span className="security-count">
              <MorphNumber value={filtered.length} />
            </span>
          </h1>
          <p>Source folders saved on this computer. Start a scan whenever you need a review.</p>
        </div>
      </header>
      <div className="security-toolbar">
        <div className="security-search">
          <Icon name="search" />
          <label htmlFor={`${id}-search`} className="sr-only">
            Search projects
          </label>
          <Input
            id={`${id}-search`}
            type="search"
            placeholder="Search projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button
          ref={addButton}
          className="button button-secondary security-toolbar-action"
          onClick={onAdd}
        >
          <Icon name="plus" /> Add project
        </Button>
      </div>
      {filtered.length ? (
        <div className="security-table-scroll">
          <table className="security-table security-projects-table">
            <caption className="sr-only">Local projects</caption>
            <thead>
              <tr>
                <SortHeader column="project" sort={sort} onSort={toggle}>
                  Project
                </SortHeader>
                <SortHeader column="scanned" sort={sort} onSort={toggle}>
                  Last scan
                </SortHeader>
                <SortHeader column="open" sort={sort} onSort={toggle}>
                  Open findings
                </SortHeader>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((project) => {
                const latest = latestScan(project);
                return (
                  <tr key={project.id}>
                    <td>
                      <div className="security-project-cell">
                        <Icon name="folder" />
                        <div>
                          <Link
                            className="security-row-link"
                            to={`/projects/${encodeURIComponent(project.id)}`}
                          >
                            {project.name}
                          </Link>
                          <span className="security-cell-caption security-path">
                            {project.path}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td>
                      {latest ? (
                        <>
                          <Link className="security-row-link" to={`/scans/${latest.id}`}>
                            <ScanStatus scan={latest} />
                          </Link>
                          <span className="security-cell-caption">
                            <MorphNumber value={date(latest.startedAt)} variant="text" />
                          </span>
                        </>
                      ) : (
                        <span className="muted">Not scanned</span>
                      )}
                    </td>
                    <td>
                      {latest ? <MorphNumber value={openFindings.get(project.id) ?? 0} /> : "—"}
                    </td>
                    <td>
                      <div className="security-row-actions">
                        <Button
                          className="button button-secondary"
                          {...(running ? { title: RUNNING_SCAN_REASON } : {})}
                          disabled={running}
                          onClick={() => onNewScan(project.id)}
                        >
                          <Icon name="scan" /> New Scan
                        </Button>
                        <Button
                          className="icon-button"
                          aria-label={`Delete ${project.name}`}
                          title={
                            running
                              ? "Finish, pause or stop the running scan before deleting a project"
                              : "Delete project"
                          }
                          disabled={running}
                          onClick={(event) => deletion.open(project, event.currentTarget)}
                        >
                          <Icon name="trash" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={projects.length ? "No projects match" : "Add your first project"}
          description={
            projects.length
              ? "Try another project name or folder path."
              : "Choose a local source folder. Git is optional."
          }
          action={
            <Button
              className="button button-primary"
              onClick={projects.length ? () => setQuery("") : onAdd}
            >
              {projects.length ? "Clear search" : "Add project"}
            </Button>
          }
        />
      )}
      <DeleteProjectDialog
        deletion={deletion}
        scans={scans.filter((scan) => scan.repositoryId === deletion.project?.id).length}
      />
    </>
  );
}
