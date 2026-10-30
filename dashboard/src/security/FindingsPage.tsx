import { useId, useMemo, useState } from "react";
import { Dialog, DialogTrigger, Heading, Popover } from "react-aria-components";
import { useSearchParams } from "react-router";
import {
  FINDING_STATUSES,
  type FindingStatus,
  findingValidation,
  type SecurityWorkspace,
  WORKSPACE_LIMITS,
} from "../../../src/dashboard/contract.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { Button, Checkbox, Input, Select } from "../shared/ui.tsx";
import { SeverityFlow } from "./SeverityFlow.tsx";
import { Empty, FindingsTable, Pagination, statusLabel, validationLabel } from "./ui.tsx";

export function FindingsPage({
  data,
  onNewScan,
}: {
  data: SecurityWorkspace;
  onNewScan: () => void;
}) {
  const id = useId();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<FindingStatus[]>(["new", "triaged", "in-progress"]);
  const [severity, setSeverity] = useState("all");
  const [validation, setValidation] = useState("active");
  const [page, setPage] = useState(0);
  const repository = params.get("project") ?? params.get("repository") ?? "all";
  const names = useMemo(
    () => new Map(data.repositories.map((item) => [item.id, item.name])),
    [data.repositories],
  );
  const filtered = useMemo(
    () =>
      data.findings
        .filter(
          (item) =>
            statuses.includes(item.status) &&
            (validation === "all" ||
              (validation === "active"
                ? findingValidation(item) !== "dismissed"
                : findingValidation(item) === validation)) &&
            (severity === "all" || item.severity === severity) &&
            (repository === "all" || item.repositoryId === repository) &&
            `${item.title} ${names.get(item.repositoryId) ?? ""} ${item.rootCause}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort(
          (a, b) =>
            ["critical", "high", "medium", "low"].indexOf(a.severity) -
            ["critical", "high", "medium", "low"].indexOf(b.severity),
        ),
    [data.findings, statuses, severity, validation, repository, query, names],
  );
  const change = (next: FindingStatus[]) => {
    setStatuses(next);
    setPage(0);
  };
  const pageSize = WORKSPACE_LIMITS.pageSize;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const view =
    statuses.length === FINDING_STATUSES.length
      ? "all"
      : statuses.length === 3 &&
          statuses.every((status) => status !== "resolved" && status !== "dismissed")
        ? "open"
        : statuses.length === 2 &&
            statuses.every((status) => status === "resolved" || status === "dismissed")
          ? "closed"
          : "custom";
  return (
    <>
      <header className="security-page-heading">
        <div>
          <h1>
            Findings{" "}
            <span className="security-count">
              <MorphNumber value={filtered.length} />
            </span>
          </h1>
          <p>Review and triage security findings across your local projects.</p>
        </div>
      </header>
      <div className="security-toolbar">
        <div className="security-search">
          <Icon name="search" />
          <label htmlFor={`${id}-search`} className="sr-only">
            Search findings
          </label>
          <Input
            id={`${id}-search`}
            type="search"
            placeholder="Search findings"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </div>
        <label className="sr-only" htmlFor={`${id}-repository`}>
          Project filter
        </label>
        <Select
          label="Project filter"
          id={`${id}-repository`}
          value={repository}
          items={[
            { value: "all", label: "All projects" },
            ...data.repositories.map((item) => ({ value: item.id, label: item.name })),
          ]}
          onValueChange={(value) => {
            setParams(value === "all" ? {} : { project: value });
            setPage(0);
          }}
        />
        <label className="sr-only" htmlFor={`${id}-view`}>
          Finding view
        </label>
        <Select
          label="Finding view"
          id={`${id}-view`}
          value={view}
          items={[
            { value: "open", label: "Open findings" },
            { value: "all", label: "All findings" },
            { value: "closed", label: "Closed findings" },
            ...(view === "custom" ? [{ value: "custom", label: "Custom statuses" }] : []),
          ]}
          onValueChange={(value) =>
            value !== "custom" &&
            change(
              value === "all"
                ? [...FINDING_STATUSES]
                : value === "closed"
                  ? ["resolved", "dismissed"]
                  : ["new", "triaged", "in-progress"],
            )
          }
        />
        <DialogTrigger>
          <Button className="button button-secondary security-filter-trigger">
            <Icon name="checklist" /> Filters{" "}
            <span className="security-status">{statuses.length + Number(severity !== "all")}</span>
          </Button>
          <Popover className="security-filter-body ui-popover" placement="bottom end" offset={6}>
            <Dialog aria-label="Finding filters">
              <Heading slot="title" className="sr-only">
                Finding filters
              </Heading>
              <fieldset>
                <legend>Status</legend>
                {FINDING_STATUSES.map((status) => (
                  <Checkbox
                    key={status}
                    isSelected={statuses.includes(status)}
                    onChange={(checked) =>
                      change(
                        checked
                          ? [...statuses, status]
                          : statuses.filter((item) => item !== status),
                      )
                    }
                  >
                    {statusLabel[status]}
                  </Checkbox>
                ))}
              </fieldset>
              <label htmlFor={`${id}-validation`}>Validation</label>
              <Select
                label="Validation filter"
                id={`${id}-validation`}
                value={validation}
                items={[
                  { value: "active", label: "Non-dismissed candidates" },
                  { value: "all", label: "All validation outcomes" },
                  ...Object.entries(validationLabel).map(([value, label]) => ({ value, label })),
                ]}
                onValueChange={(value) => {
                  setValidation(value);
                  setPage(0);
                }}
              />
              <label htmlFor={`${id}-severity`}>Severity</label>
              <Select
                label="Severity"
                id={`${id}-severity`}
                value={severity}
                items={["all", "critical", "high", "medium", "low"].map((value) => ({
                  value,
                  label:
                    value === "all"
                      ? "All severities"
                      : `${value[0]?.toUpperCase()}${value.slice(1)}`,
                }))}
                onValueChange={(value) => {
                  setSeverity(value);
                  setPage(0);
                }}
              />
            </Dialog>
          </Popover>
        </DialogTrigger>
      </div>
      <div className="security-filter-chips">
        {statuses.map((status) => (
          <Button
            key={status}
            className="security-chip"
            aria-label={`Remove ${statusLabel[status]} status filter`}
            onClick={() => change(statuses.filter((item) => item !== status))}
          >
            Status: {statusLabel[status]} <Icon name="close" />
          </Button>
        ))}
        {severity !== "all" && (
          <Button className="security-chip" onClick={() => setSeverity("all")}>
            Severity: {severity} <Icon name="close" />
          </Button>
        )}
        <Button
          className="button button-ghost"
          onClick={() => {
            change([...FINDING_STATUSES]);
            setSeverity("all");
            setValidation("all");
            setQuery("");
            setParams({});
          }}
        >
          Clear filters
        </Button>
      </div>
      <SeverityFlow findings={filtered} />
      {filtered.length ? (
        <>
          <FindingsTable
            findings={filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize)}
            names={names}
          />
          <Pagination
            page={currentPage}
            count={pageSize}
            total={filtered.length}
            onChange={setPage}
          />
        </>
      ) : (
        <Empty
          title={
            data.findings.length
              ? "No findings match these filters"
              : "Your findings will appear here"
          }
          description={
            data.findings.length
              ? "Change the status, validation, project, or severity filters to see more findings."
              : "Run a security scan to review source evidence, threat models, and remediation guidance."
          }
          action={
            <Button className="button button-primary" onClick={onNewScan}>
              New Scan
            </Button>
          }
        />
      )}
    </>
  );
}
