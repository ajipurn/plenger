import { useCallback, useEffect, useId, useMemo, useState } from "react";
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
import { useTableSort } from "../shared/table-sort.tsx";
import { Button, Checkbox, Input, Select } from "../shared/ui.tsx";
import { RUNNING_SCAN_REASON } from "./running-scan.ts";
import { SeverityFlow } from "./SeverityFlow.tsx";
import {
  Empty,
  FINDING_DEFAULT_SORT,
  FINDING_SORT,
  FindingsTable,
  Pagination,
  statusLabel,
  validationLabel,
} from "./ui.tsx";

const OPEN_STATUSES: readonly FindingStatus[] = ["new", "triaged", "in-progress"];
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const VALIDATIONS = ["active", "all", ...Object.keys(validationLabel)];

interface FindingFilters {
  query: string;
  statuses: FindingStatus[];
  severity: string;
  validation: string;
  /** Zero-based; the address shows it from 1. */
  page: number;
}

/**
 * The filters as the address keeps them (`?q=&status=new,triaged&severity=high`), so
 * Back from a finding returns to the same list. Defaults are left out of the address.
 */
function readFilters(params: URLSearchParams): FindingFilters {
  const status = params.get("status");
  const severity = params.get("severity") ?? "all";
  const validation = params.get("validation") ?? "active";
  return {
    query: params.get("q") ?? "",
    statuses:
      status === null
        ? [...OPEN_STATUSES]
        : FINDING_STATUSES.filter((item) => status.split(",").includes(item)),
    severity: (SEVERITIES as readonly string[]).includes(severity) ? severity : "all",
    validation: VALIDATIONS.includes(validation) ? validation : "active",
    page: Math.max(0, Math.floor(Number(params.get("page")) || 1) - 1),
  };
}

function sameStatuses(a: readonly FindingStatus[], b: readonly FindingStatus[]): boolean {
  return a.length === b.length && a.every((status) => b.includes(status));
}

export function FindingsPage({
  data,
  onNewScan,
}: {
  data: SecurityWorkspace;
  onNewScan: () => void;
}) {
  const id = useId();
  const running = data.scans.some((scan) => scan.status === "running");
  const [params, setParams] = useSearchParams();
  const { query, statuses, severity, validation, page } = readFilters(params);
  const repository = params.get("project") ?? params.get("repository") ?? "all";
  /** Changes filters in the address, keeping the sort and the other filters; the page resets unless given. */
  const update = useCallback(
    (changes: Partial<FindingFilters> & { project?: string }) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          const set = (key: string, value: string | null) =>
            value === null ? next.delete(key) : next.set(key, value);
          if (changes.query !== undefined) set("q", changes.query || null);
          if (changes.statuses !== undefined)
            set(
              "status",
              sameStatuses(changes.statuses, OPEN_STATUSES) ? null : changes.statuses.join(","),
            );
          if (changes.severity !== undefined)
            set("severity", changes.severity === "all" ? null : changes.severity);
          if (changes.validation !== undefined)
            set("validation", changes.validation === "active" ? null : changes.validation);
          if (changes.project !== undefined) {
            next.delete("repository");
            set("project", changes.project === "all" ? null : changes.project);
          }
          const nextPage = changes.page ?? 0;
          set("page", nextPage > 0 ? String(nextPage + 1) : null);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  const names = useMemo(
    () => new Map(data.repositories.map((item) => [item.id, item.name])),
    [data.repositories],
  );
  const filtered = useMemo(
    () =>
      data.findings.filter(
        (item) =>
          statuses.includes(item.status) &&
          (validation === "all" ||
            (validation === "active"
              ? findingValidation(item) !== "dismissed"
              : findingValidation(item) === validation)) &&
          (severity === "all" || item.severity === severity) &&
          (repository === "all" || item.repositoryId === repository) &&
          [
            item.title,
            names.get(item.repositoryId) ?? "",
            item.rootCause,
            item.cwe ?? "",
            ...item.evidence.map((cite) => cite.path),
          ]
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [data.findings, statuses, severity, validation, repository, query, names],
  );
  const findingSort = useTableSort(FINDING_SORT, FINDING_DEFAULT_SORT);
  // A new sort starts at the first page; returning to the list keeps its page.
  const sortKey = findingSort.sort ? `${findingSort.sort.direction}:${findingSort.sort.key}` : "";
  const [seenSort, setSeenSort] = useState(sortKey);
  useEffect(() => {
    if (seenSort === sortKey) return;
    setSeenSort(sortKey);
    if (page > 0) update({});
  }, [sortKey, seenSort, page, update]);
  const sorted = findingSort.apply(filtered);
  const change = (next: FindingStatus[]) => update({ statuses: next });
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
            onChange={(event) => update({ query: event.target.value })}
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
          onValueChange={(value) => update({ project: value })}
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
            <span className="security-status">
              <MorphNumber value={statuses.length + Number(severity !== "all")} />
            </span>
          </Button>
          <Popover className="security-filter-body ui-popover" placement="bottom end" offset={6}>
            <Dialog aria-label="Finding filters">
              <Heading slot="title" className="sr-only">
                Finding filters
              </Heading>
              <fieldset className="security-filter-section">
                <legend className="security-filter-title">Status</legend>
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
              <div className="security-filter-section">
                <label htmlFor={`${id}-validation`} className="security-filter-title">
                  Validation
                </label>
                <Select
                  label="Validation filter"
                  id={`${id}-validation`}
                  value={validation}
                  items={[
                    { value: "active", label: "Non-dismissed candidates" },
                    { value: "all", label: "All validation outcomes" },
                    ...Object.entries(validationLabel).map(([value, label]) => ({ value, label })),
                  ]}
                  onValueChange={(value) => update({ validation: value })}
                />
              </div>
              <div className="security-filter-section">
                <label htmlFor={`${id}-severity`} className="security-filter-title">
                  Severity
                </label>
                <Select
                  label="Severity"
                  id={`${id}-severity`}
                  value={severity}
                  items={["all", ...SEVERITIES].map((value) => ({
                    value,
                    label: value === "all" ? "All severities" : capitalized(value),
                  }))}
                  onValueChange={(value) => update({ severity: value })}
                />
              </div>
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
          <Button
            className="security-chip"
            aria-label={`Remove ${capitalized(severity)} severity filter`}
            onClick={() => update({ severity: "all" })}
          >
            Severity: {capitalized(severity)} <Icon name="close" />
          </Button>
        )}
        <Button
          className="button button-ghost"
          onClick={() =>
            update({
              statuses: [...FINDING_STATUSES],
              severity: "all",
              validation: "all",
              query: "",
              project: "all",
            })
          }
        >
          Clear filters
        </Button>
      </div>
      <SeverityFlow findings={filtered} />
      {filtered.length ? (
        <>
          <FindingsTable
            findings={sorted.slice(currentPage * pageSize, currentPage * pageSize + pageSize)}
            names={names}
          />
          <Pagination
            page={currentPage}
            count={pageSize}
            total={filtered.length}
            onChange={(next) => update({ page: next })}
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
            <Button
              className="button button-primary"
              {...(running ? { title: RUNNING_SCAN_REASON } : {})}
              disabled={running}
              onClick={onNewScan}
            >
              New Scan
            </Button>
          }
        />
      )}
    </>
  );
}

function capitalized(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
