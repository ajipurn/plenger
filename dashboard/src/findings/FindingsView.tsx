import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { useId, useMemo, useRef, useState } from "react";
import type { DashboardScan } from "../../../src/dashboard/contract.ts";
import type { Finding, Severity } from "../../../src/rules/model.ts";
import { DetailDrawer } from "../shared/DetailDrawer.tsx";
import { EmptyState } from "../shared/EmptyState.tsx";
import { capitalize } from "../shared/format.ts";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { Pagination, usePagination } from "../shared/Pagination.tsx";
import { SearchField } from "../shared/SearchField.tsx";
import { Button, Select } from "../shared/ui.tsx";
import { FindingDetail } from "./FindingDetail.tsx";
import { FindingsTable } from "./FindingsTable.tsx";

const severities: Severity[] = ["critical", "high", "medium", "low"];
const sortItems = [
  { value: "severity", label: "Highest severity" },
  { value: "confidence", label: "Highest confidence" },
  { value: "source", label: "Source file" },
] as const;
type Sort = (typeof sortItems)[number]["value"];
const pageSize = 20;

export function FindingsView({
  report,
  initialSelection,
}: {
  report: DashboardScan;
  initialSelection: string | null;
}) {
  const searchId = useId();
  const sortId = useId();
  const severityId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [sort, setSort] = useState<Sort>("severity");
  const [selectedId, setSelectedId] = useState(initialSelection);
  const [drawerOpen, setDrawerOpen] = useState(() =>
    report.scan.findings.some((finding) => finding.fingerprint === initialSelection),
  );
  const findings = useMemo(() => {
    const search = query.trim().toLowerCase();
    const filtered = report.scan.findings.filter(
      (finding) =>
        (severity === "all" || finding.severity === severity) &&
        (!search ||
          [
            finding.title,
            finding.rule,
            finding.location.path,
            finding.subject.name,
            ...finding.notes,
          ]
            .join(" ")
            .toLowerCase()
            .includes(search)),
    );
    const rank = (finding: Finding) => severities.indexOf(finding.severity);
    const confidenceRank = (finding: Finding) =>
      ["high", "medium", "low"].indexOf(finding.confidence);
    return filtered.sort((a, b) => {
      const primary =
        sort === "source"
          ? a.location.path.localeCompare(b.location.path) || a.location.line - b.location.line
          : sort === "confidence"
            ? confidenceRank(a) - confidenceRank(b)
            : rank(a) - rank(b);
      return (
        primary ||
        rank(a) - rank(b) ||
        b.score - a.score ||
        a.fingerprint.localeCompare(b.fingerprint)
      );
    });
  }, [report, query, severity, sort]);
  const pagination = usePagination(findings, pageSize);
  const selected = report.scan.findings.find((finding) => finding.fingerprint === selectedId);
  const rule = report.rules.find((item) => item.id === selected?.rule);
  const counts = useMemo(
    () =>
      Object.fromEntries(
        severities.map((value) => [
          value,
          report.scan.findings.filter((finding) => finding.severity === value).length,
        ]),
      ) as Record<Severity, number>,
    [report],
  );
  function clearFilters() {
    setQuery("");
    setSeverity("all");
    pagination.reset();
  }

  return (
    <section className="findings-browser" aria-label="Findings browser">
      <div className="panel findings-workbench">
        <div className="findings-toolbar">
          <SearchField
            ref={searchInput}
            id={searchId}
            label="Search findings"
            inputClassName="search-input"
            placeholder="Search findings, files, or rules…"
            value={query}
            onChange={(value) => {
              setQuery(value);
              pagination.reset();
            }}
          />
          <div className="findings-toolbar-filters">
            <div className="findings-mobile-severity">
              <label htmlFor={severityId} className="sr-only">
                Filter by severity
              </label>
              <Select
                id={severityId}
                value={severity}
                items={(["all", ...severities] as const).map((value) => ({
                  value,
                  label: value === "all" ? "All severities" : capitalize(value),
                }))}
                onValueChange={(value) => {
                  setSeverity(value);
                  pagination.reset();
                }}
              />
            </div>
            <ToggleGroup
              className="severity-filters"
              aria-label="Filter by severity"
              value={[severity]}
              onValueChange={(values) => {
                const value = values[0];
                if (value === "all" || severities.includes(value as Severity)) {
                  setSeverity(value as Severity | "all");
                  pagination.reset();
                }
              }}
            >
              {(["all", ...severities] as const).map((value) => (
                <Toggle
                  key={value}
                  value={value}
                  className="button button-secondary"
                  aria-label={
                    value === "all"
                      ? `All ${report.scan.findings.length} findings`
                      : `${counts[value]} ${value} findings`
                  }
                >
                  {value === "all" ? "All" : capitalize(value)}
                  <span className="filter-count">
                    <MorphNumber
                      value={value === "all" ? report.scan.findings.length : counts[value]}
                    />
                  </span>
                </Toggle>
              ))}
            </ToggleGroup>
            <div className="findings-sort">
              <label htmlFor={sortId} className="sr-only">
                Sort findings
              </label>
              <Select
                id={sortId}
                value={sort}
                items={[...sortItems]}
                onValueChange={(value) => {
                  setSort(value);
                  pagination.reset();
                }}
              />
            </div>
          </div>
        </div>
        {report.scan.findings.length === 0 ? (
          <EmptyState
            className="empty-state"
            icon="check"
            title="No findings in the scanned code"
            description="Review the inventory and scan coverage to see what Plenger observed. A scan without findings does not prove the project is safe."
          />
        ) : findings.length === 0 ? (
          <EmptyState
            className="empty-state"
            icon="search"
            title="No findings match these filters"
            description="Try a different search or return to all findings."
          >
            <Button className="button button-secondary" onClick={clearFilters}>
              Clear filters
            </Button>
          </EmptyState>
        ) : (
          <FindingsTable
            findings={pagination.visible}
            rules={report.rules}
            selectedId={drawerOpen ? selectedId : null}
            onOpen={(finding, trigger) => {
              returnFocus.current = trigger;
              setSelectedId(finding.fingerprint);
              setDrawerOpen(true);
            }}
          />
        )}
        <div className="findings-footer">
          <p className="count-label muted" role="status">
            {findings.length > 0 ? (
              <>
                <MorphNumber value={pagination.start + 1} />–
                <MorphNumber value={pagination.end} /> of{" "}
              </>
            ) : null}
            <MorphNumber value={findings.length} /> findings
            {findings.length !== report.scan.findings.length ? (
              <>
                {" "}
                · <MorphNumber value={report.scan.findings.length} /> total
              </>
            ) : null}
          </p>
          {pagination.pageCount > 1 && (
            <Pagination
              page={pagination.page}
              pageCount={pagination.pageCount}
              label="Findings pages"
              onPageChange={pagination.goTo}
            />
          )}
          <span className="findings-static-note">
            Static indications · dynamic evidence in Red-team
          </span>
        </div>
      </div>
      <DetailDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        className="inventory-detail-panel findings-detail-panel"
        headingClassName="findings-drawer-heading"
        eyebrow={<>Finding details · {selected?.rule}</>}
        title="Review finding"
        description="Source evidence, risk explanation, and suggested remediation."
        descriptionClassName="sr-only"
        closeLabel="Close finding details"
        returnFocus={() =>
          returnFocus.current?.isConnected ? returnFocus.current : searchInput.current
        }
      >
        {selected && <FindingDetail finding={selected} rule={rule} />}
      </DetailDrawer>
    </section>
  );
}
