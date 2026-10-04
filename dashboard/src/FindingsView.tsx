import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { useId, useMemo, useRef, useState } from "react";
import { Drawer } from "vaul";
import type { DashboardScan } from "../../src/dashboard/model.ts";
import type { Finding, Severity } from "../../src/rules/model.ts";
import { Icon } from "./icons.tsx";
import { MorphNumber } from "./MorphNumber.tsx";
import { useElementScrollbars } from "./ScrollArea.tsx";
import { SourceRef } from "./SourceRef.tsx";
import { Button, Input, Select } from "./ui.tsx";

const severities: Severity[] = ["critical", "high", "medium", "low"];
const sortItems = [
  { value: "severity", label: "Highest severity" },
  { value: "confidence", label: "Highest confidence" },
  { value: "source", label: "Source file" },
] as const;
type Sort = (typeof sortItems)[number]["value"];
const pageSize = 20;

function uniqueObservations<T>(values: T[]): T[] {
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
}

/** Finding titles contain code identifiers delimited by backticks, not arbitrary Markdown. */
function FindingTitle({ title }: { title: string }) {
  return [...title.matchAll(/`[^`]+`|[^`]+|`/g)].map(({ 0: part, index }) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={`${index}:${part}`}>{part.slice(1, -1)}</code>
    ) : (
      part
    ),
  );
}

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
  const detailScrollbars = useElementScrollbars<HTMLDivElement>();
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [sort, setSort] = useState<Sort>("severity");
  const [page, setPage] = useState(0);
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
  const pageCount = Math.max(1, Math.ceil(findings.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleFindings = findings.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  function clearFilters() {
    setQuery("");
    setSeverity("all");
    setPage(0);
  }

  return (
    <section className="findings-browser" aria-label="Findings browser">
      <div className="panel findings-workbench">
        <div className="findings-toolbar">
          <div className="search-field">
            <Icon name="search" />
            <label htmlFor={searchId} className="sr-only">
              Search findings
            </label>
            <Input
              ref={searchInput}
              id={searchId}
              type="search"
              className="search-input"
              placeholder="Search findings, files, or rules…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
            />
          </div>
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
                  label:
                    value === "all" ? "All severities" : value[0]?.toUpperCase() + value.slice(1),
                }))}
                onValueChange={(value) => {
                  setSeverity(value);
                  setPage(0);
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
                  setPage(0);
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
                  {value === "all" ? "All" : value[0]?.toUpperCase() + value.slice(1)}
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
                  setPage(0);
                }}
              />
            </div>
          </div>
        </div>
        {report.scan.findings.length === 0 ? (
          <div className="empty-state">
            <Icon name="check" />
            <h2>No findings in the scanned code</h2>
            <p>
              Review the inventory and scan coverage to see what Plenger observed. A scan without
              findings does not prove the project is safe.
            </p>
          </div>
        ) : findings.length === 0 ? (
          <div className="empty-state">
            <Icon name="search" />
            <h2>No findings match these filters</h2>
            <p>Try a different search or return to all findings.</p>
            <Button className="button button-secondary" onClick={clearFilters}>
              Clear filters
            </Button>
          </div>
        ) : (
          <table className="findings-table">
            <caption className="sr-only">
              Source findings. Open a finding to review its evidence and remediation.
            </caption>
            <colgroup>
              <col className="finding-severity-column" />
              <col className="finding-name-column" />
              <col className="finding-source-column" />
              <col className="finding-confidence-column" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Severity</th>
                <th scope="col">Finding</th>
                <th scope="col">Source</th>
                <th scope="col">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {visibleFindings.map((finding) => {
                const matchingRule = report.rules.find((item) => item.id === finding.rule);
                const filenameStart = finding.location.path.lastIndexOf("/") + 1;
                return (
                  <tr
                    key={finding.fingerprint}
                    className={`finding-table-row ${drawerOpen && selectedId === finding.fingerprint ? "is-selected" : ""}`}
                    onClick={(event) => {
                      returnFocus.current =
                        event.currentTarget.querySelector<HTMLButtonElement>(".finding-open");
                      setSelectedId(finding.fingerprint);
                      setDrawerOpen(true);
                    }}
                  >
                    <td className="finding-severity-cell">
                      <span className={`badge ${finding.severity}`}>{finding.severity}</span>
                    </td>
                    <td className="finding-name-cell">
                      <Button
                        className="finding-open"
                        aria-label={`Review finding: ${finding.title.replaceAll("`", "")}`}
                        aria-haspopup="dialog"
                      >
                        <span className="finding-table-title">
                          <FindingTitle title={matchingRule?.title ?? finding.title} />
                        </span>
                        <span className="finding-table-meta">
                          <span>{finding.rule}</span>
                          <span className="finding-subject">{finding.subject.name}</span>
                        </span>
                      </Button>
                      <span className="finding-mobile-confidence">
                        {finding.confidence} confidence
                      </span>
                    </td>
                    <td
                      className="finding-source-cell"
                      title={`${finding.location.path}:${finding.location.line}:${finding.location.column}`}
                    >
                      <code className="finding-source-file">
                        {finding.location.path.slice(filenameStart)}:{finding.location.line}
                      </code>
                      <code className="finding-source-directory">
                        {finding.location.path.slice(0, filenameStart) || "Project root"}
                      </code>
                    </td>
                    <td className="finding-confidence-cell">
                      <span className="finding-confidence">{finding.confidence}</span>
                      <Icon name="chevron" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="findings-footer">
          <p className="count-label muted" role="status">
            {findings.length > 0 ? (
              <>
                <MorphNumber value={currentPage * pageSize + 1} />–
                <MorphNumber value={Math.min((currentPage + 1) * pageSize, findings.length)} /> of{" "}
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
          {pageCount > 1 && (
            <nav className="inventory-pagination" aria-label="Findings pages">
              <Button
                className="button button-secondary"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                <Icon name="chevron" className="previous-page-icon" /> Previous
              </Button>
              <span className="count-label">
                <MorphNumber value={currentPage + 1} /> / <MorphNumber value={pageCount} />
              </span>
              <Button
                className="button button-secondary"
                disabled={currentPage === pageCount - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                Next <Icon name="chevron" />
              </Button>
            </nav>
          )}
          <span className="findings-static-note">
            Static indications · dynamic evidence in Red-team
          </span>
        </div>
      </div>
      <Drawer.Root
        direction="right"
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        autoFocus
        repositionInputs={false}
      >
        <Drawer.Portal>
          <Drawer.Overlay className="inventory-drawer-overlay" />
          <Drawer.Content
            className="inventory-detail-panel findings-detail-panel"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const target = returnFocus.current?.isConnected
                ? returnFocus.current
                : searchInput.current;
              target?.focus({ preventScroll: true });
            }}
          >
            <div className="findings-drawer-heading">
              <div>
                <p className="eyebrow">Finding details · {selected?.rule}</p>
                <Drawer.Title>Review finding</Drawer.Title>
                <Drawer.Description className="sr-only">
                  Source evidence, risk explanation, and suggested remediation.
                </Drawer.Description>
              </div>
              <Drawer.Close asChild>
                <Button className="icon-button" aria-label="Close finding details">
                  <Icon name="close" />
                </Button>
              </Drawer.Close>
            </div>
            <div
              className="inventory-detail-scroll"
              ref={detailScrollbars}
              data-overlayscrollbars-initialize=""
              data-vaul-no-drag
            >
              {selected && (
                <article className="finding-detail">
                  <div className="finding-detail-header">
                    <div className="finding-meta">
                      <span className={`badge ${selected.severity}`}>{selected.severity}</span>
                      <span className="tag">{selected.confidence} confidence</span>
                      <span className="finding-score muted">
                        Score <MorphNumber value={selected.score} />
                      </span>
                    </div>
                    <h3>
                      <FindingTitle title={selected.title} />
                    </h3>
                  </div>
                  <section className="finding-source-context">
                    <h4 className="detail-section-title">
                      <Icon name="source-files" /> Source location
                    </h4>
                    <SourceRef location={selected.location} includeColumn />
                    {selected.snippet && (
                      <pre className="code-block">
                        <code>{selected.snippet}</code>
                      </pre>
                    )}
                  </section>
                  <EvidenceList finding={selected} />
                  <section className="detail-section">
                    <h4>Why it matters</h4>
                    <p className="finding-description">
                      {rule?.description ??
                        "Review the source evidence and notes for this observation."}
                    </p>
                    <dl className="detail-list">
                      <div>
                        <dt>Subject</dt>
                        <dd>
                          {selected.subject.name}{" "}
                          <span className="muted">
                            ({selected.subject.kind.replaceAll("_", " ")})
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt>Exposure</dt>
                        <dd>
                          {selected.exposed
                            ? "Reachable from a network entry point"
                            : "Network exposure not observed"}
                        </dd>
                      </div>
                    </dl>
                  </section>
                  {selected.notes.length > 0 && (
                    <section className="detail-section">
                      <h4>Review notes</h4>
                      <ul>
                        {uniqueObservations(selected.notes).map((note) => (
                          <li key={note}>
                            <FindingTitle title={note} />
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {rule && (
                    <>
                      <section className="detail-section remediation-panel">
                        <h4 className="detail-section-title">
                          <Icon name="check" /> Suggested remediation
                        </h4>
                        <p>{rule.remediation}</p>
                      </section>
                      {(rule.owasp.length > 0 || rule.cwe.length > 0) && (
                        <section className="detail-section">
                          <h4>Reference mapping</h4>
                          <div className="capabilities">
                            {rule.owasp.map((mapping) => (
                              <span className="tag" key={mapping}>
                                {mapping}
                              </span>
                            ))}
                            {rule.cwe.map((cwe) => (
                              <span className="tag" key={cwe}>
                                CWE-{cwe}
                              </span>
                            ))}
                          </div>
                        </section>
                      )}
                    </>
                  )}
                </article>
              )}
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </section>
  );
}
function EvidenceList({ finding }: { finding: Finding }) {
  if (finding.evidence.length === 0) return null;
  return (
    <section className="detail-section">
      <h4>Source trace</h4>
      <ol className="evidence-list finding-evidence-trace">
        {uniqueObservations(finding.evidence).map((evidence) => (
          <li key={JSON.stringify([evidence.location, evidence.message, evidence.snippet])}>
            <p>
              <FindingTitle title={evidence.message} />
            </p>
            <SourceRef location={evidence.location} />
            {evidence.snippet && (
              <details className="finding-trace-code">
                <summary>
                  <Icon name="chevron" /> Code context
                </summary>
                <pre className="code-block">
                  <code>{evidence.snippet}</code>
                </pre>
              </details>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
