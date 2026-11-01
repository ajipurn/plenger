import { useId, useState } from "react";
import { type SecurityWorkspace, WORKSPACE_LIMITS } from "../../../src/dashboard/contract.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { Input, Select } from "../shared/ui.tsx";
import { ScansTable } from "./ScansTable.tsx";
import { Empty, Pagination, scanStatusLabel } from "./ui.tsx";

export function ScansPage({ data }: { data: SecurityWorkspace }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);
  const names = new Map(data.repositories.map((item) => [item.id, item.name]));
  const filtered = data.scans.filter(
    (scan) =>
      (status === "all" || scan.status === status) &&
      `${names.get(scan.repositoryId) ?? ""} ${scan.revision.commit ?? ""} ${scan.provider?.name ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const pageSize = WORKSPACE_LIMITS.pageSize;
  const current = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  return (
    <>
      <header className="security-page-heading">
        <div>
          <h1>
            Scans{" "}
            <span className="security-count">
              <MorphNumber value={filtered.length} />
            </span>
          </h1>
          <p>Track source analysis, model usage, and saved security assessments.</p>
        </div>
      </header>
      <div className="security-toolbar">
        <div className="security-search">
          <Icon name="search" />
          <label className="sr-only" htmlFor={`${id}-search`}>
            Search scans
          </label>
          <Input
            id={`${id}-search`}
            type="search"
            placeholder="Search scans"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </div>
        <label className="sr-only" htmlFor={`${id}-status`}>
          Scan status
        </label>
        <Select
          label="Scan status"
          id={`${id}-status`}
          value={status}
          items={[
            { value: "all", label: "All statuses" },
            ...Object.entries(scanStatusLabel).map(([value, label]) => ({ value, label })),
          ]}
          onValueChange={(value) => {
            setStatus(value);
            setPage(0);
          }}
        />
      </div>
      {filtered.length ? (
        <>
          <ScansTable
            scans={filtered.slice(current * pageSize, current * pageSize + pageSize)}
            names={names}
          />
          <Pagination page={current} count={pageSize} total={filtered.length} onChange={setPage} />
        </>
      ) : (
        <Empty
          title={data.scans.length ? "No scans match" : "No scans yet"}
          description="Start a new scan to review a local project. Progress, model usage, findings and outputs are saved here."
        />
      )}
    </>
  );
}
