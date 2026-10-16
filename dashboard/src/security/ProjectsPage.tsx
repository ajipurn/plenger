import { useId, useState } from "react";
import { Link } from "react-router";
import type { LocalRepository, SecurityScanSummary } from "../../../src/dashboard/contract.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { Button, Input } from "../shared/ui.tsx";
import { date, Empty, ScanStatus } from "./ui.tsx";

export function ProjectsPage({
  projects,
  scans,
  onAdd,
  onNewScan,
}: {
  projects: LocalRepository[];
  scans: SecurityScanSummary[];
  onAdd: () => void;
  onNewScan: (id: string) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const filtered = projects.filter((item) =>
    `${item.name} ${item.path}`.toLowerCase().includes(query.toLowerCase()),
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
        <Button className="button button-secondary" onClick={onAdd}>
          <Icon name="plus" /> Add project
        </Button>
      </div>
      {filtered.length ? (
        <div className="security-table-scroll">
          <table className="security-table security-projects-table">
            <caption className="sr-only">Local projects</caption>
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Last scan</th>
                <th scope="col">Findings</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((project) => {
                const latest = scans.find((scan) => scan.repositoryId === project.id);
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
                          <span className="security-cell-caption">{date(latest.startedAt)}</span>
                        </>
                      ) : (
                        <span className="muted">Not scanned</span>
                      )}
                    </td>
                    <td>{latest ? latest.findingCount : "—"}</td>
                    <td>
                      <div className="security-row-actions">
                        <Button
                          className="button button-secondary"
                          onClick={() => onNewScan(project.id)}
                        >
                          <Icon name="scan" /> New Scan
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
    </>
  );
}
