import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { useId, useMemo, useState } from "react";
import type { DashboardScan } from "../../src/dashboard/model.ts";
import type { Capability, Location } from "../../src/inventory/model.ts";
import type { ProjectPlan } from "../../src/redteam/plan.ts";
import type { Finding, Severity } from "../../src/rules/model.ts";
import { Icon, type IconName } from "./icons.tsx";
import { ScrollArea } from "./ScrollArea.tsx";
import { Button, Input } from "./ui.tsx";

const severities: Severity[] = ["critical", "high", "medium", "low"];

function uniqueObservations<T>(values: T[]): T[] {
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
}

function SourceRef({ location }: { location: Location }) {
  return (
    <code className="source-ref">
      {location.path}:{location.line}
    </code>
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
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(initialSelection);
  const findings = useMemo(() => {
    const search = query.trim().toLowerCase();
    return report.scan.findings.filter(
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
  }, [report, query, severity]);
  const selected = findings.find((finding) => finding.fingerprint === selectedId) ?? findings[0];
  const rule = report.rules.find((item) => item.id === selected?.rule);
  const severityCounts = useMemo(
    () =>
      Object.fromEntries(
        severities.map((value) => [
          value,
          report.scan.findings.filter((finding) => finding.severity === value).length,
        ]),
      ) as Record<Severity, number>,
    [report],
  );

  return (
    <section className="stack" aria-labelledby="findings-heading">
      <div className="section-heading view-section-intro">
        <div>
          <h2 id="findings-heading">Observations</h2>
          <p className="muted">Review what the source reveals, one finding at a time.</p>
        </div>
        <span className="tag">Static analysis</span>
      </div>
      <div className="panel findings-workbench">
        <div className="toolbar">
          <div className="field">
            <label htmlFor={searchId} className="sr-only">
              Search findings
            </label>
            <div className="search-field">
              <Icon name="search" />
              <Input
                id={searchId}
                className="search-input"
                type="search"
                placeholder="Search findings, files, or rules…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          <ToggleGroup
            className="severity-filters"
            aria-label="Filter by severity"
            value={[severity]}
            onValueChange={(values) => {
              const value = values[0];
              if (value === "all" || severities.includes(value as Severity)) {
                setSeverity(value as Severity | "all");
              }
            }}
          >
            {(["all", ...severities] as const).map((value) => (
              <Toggle
                key={value}
                value={value}
                className={`button button-secondary ${severity === value ? "is-selected" : ""}`}
                aria-label={
                  value === "all"
                    ? `All ${report.scan.findings.length} findings`
                    : `${severityCounts[value]} ${value} findings`
                }
              >
                {value === "all" ? "All" : value[0]?.toUpperCase() + value.slice(1)}
                <span className="filter-count">
                  {value === "all" ? report.scan.findings.length : severityCounts[value]}
                </span>
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
        <div className="findings-summary">
          <p className="muted count-label" role="status">
            Showing <strong>{findings.length}</strong> of {report.scan.findings.length} findings
          </p>
          <span className="muted">Runtime behavior has not been tested</span>
        </div>
        {report.scan.findings.length === 0 ? (
          <div className="panel empty-state">
            <Icon name="check" />
            <h3>No findings in the scanned code</h3>
            <p>
              Review the inventory and scan coverage to see what Plenger observed. A scan without
              findings does not prove the project is safe.
            </p>
          </div>
        ) : findings.length === 0 ? (
          <div className="panel empty-state">
            <Icon name="search" />
            <h3>No findings match these filters</h3>
            <p>Try a different search or return to all findings.</p>
            <Button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setQuery("");
                setSeverity("all");
              }}
            >
              Clear filters
            </Button>
          </div>
        ) : (
          <div className="split-view">
            <ScrollArea className="panel findings-list" role="region" aria-label="Ranked findings">
              {findings.map((finding) => (
                <Button
                  key={finding.fingerprint}
                  type="button"
                  className={`finding-row ${selected?.fingerprint === finding.fingerprint ? "is-selected" : ""}`}
                  aria-pressed={selected?.fingerprint === finding.fingerprint}
                  onClick={() => setSelectedId(finding.fingerprint)}
                >
                  <span className="finding-meta">
                    <span className={`badge ${finding.severity}`}>{finding.severity}</span>
                    <span className="muted">
                      {finding.rule} · Score {finding.score}
                    </span>
                  </span>
                  <span className="finding-title">{finding.title}</span>
                  <SourceRef location={finding.location} />
                </Button>
              ))}
            </ScrollArea>
            {selected && (
              <article className="panel finding-detail" aria-label="Selected finding">
                <div className="finding-detail-header">
                  <div className="finding-meta">
                    <span className={`badge ${selected.severity}`}>{selected.severity}</span>
                    <span className="tag">{selected.confidence} confidence</span>
                    <span className="tag">{selected.rule}</span>
                  </div>
                  <h3>{selected.title}</h3>
                  <SourceRef location={selected.location} />
                </div>
                <p className="finding-description">
                  {rule?.description ??
                    "Review the source evidence and notes for this observation."}
                </p>
                <dl className="detail-list">
                  <div>
                    <dt>Subject</dt>
                    <dd>
                      {selected.subject.name}{" "}
                      <span className="muted">({selected.subject.kind})</span>
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
                {selected.snippet && (
                  <section className="detail-section">
                    <h4>Code context</h4>
                    <pre className="code-block">
                      <code>{selected.snippet}</code>
                    </pre>
                  </section>
                )}
                <EvidenceList finding={selected} />
                {selected.notes.length > 0 && (
                  <section className="detail-section">
                    <h4>Review notes</h4>
                    <ul>
                      {uniqueObservations(selected.notes).map((note) => (
                        <li key={note}>{note}</li>
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
                  </>
                )}
              </article>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function EvidenceList({ finding }: { finding: Finding }) {
  if (finding.evidence.length === 0) return null;
  return (
    <section className="detail-section">
      <h4>Source evidence</h4>
      <ol className="evidence-list">
        {uniqueObservations(finding.evidence).map((evidence) => (
          <li key={JSON.stringify([evidence.location, evidence.message, evidence.snippet])}>
            <p>{evidence.message}</p>
            <SourceRef location={evidence.location} />
            {evidence.snippet && (
              <pre className="code-block">
                <code>{evidence.snippet}</code>
              </pre>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

interface InventoryItem {
  id: string;
  name: string;
  location: Location;
  framework?: string;
  description?: string | null;
  rows: [string, string][];
  capabilities?: Capability[];
  prompt?: string;
}

function CapabilityList({ capabilities }: { capabilities: Capability[] }) {
  if (capabilities.length === 0)
    return <p className="muted">No capabilities observed in this scope.</p>;
  return (
    <ul className="evidence-list">
      {uniqueObservations(capabilities).map((capability) => (
        <li key={JSON.stringify(capability)}>
          <span className="tag">{capability.kind.replaceAll("_", " ")}</span>{" "}
          <code>{capability.target}</code>
          {capability.hosted && <span className="tag">Provider hosted</span>}
          <div>
            <SourceRef location={capability.location} />
          </div>
          {capability.guards && capability.guards.length > 0 && (
            <p className="muted">Observed checks: {capability.guards.join(", ")}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

const inventoryIcons: Record<string, IconName> = {
  Models: "scan",
  Agents: "redteam",
  Tools: "inventory",
  "LLM calls": "overview",
  "Entry points": "arrow",
  "MCP servers": "inventory",
  "MCP clients": "overview",
  "Data stores": "folder",
  Prompts: "scan",
};

function InventoryCategory({ title, items }: { title: string; items: InventoryItem[] }) {
  return (
    <section className="panel inventory-card">
      <div className="section-heading inventory-category-heading">
        <div className="category-heading-main">
          <span className="category-icon">
            <Icon name={inventoryIcons[title] ?? "inventory"} />
          </span>
          <h3>{title}</h3>
        </div>
        <span className="category-count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="muted inventory-section-note">None observed in this scan.</p>
      ) : (
        items.map((item) => (
          <details className="inventory-item" key={item.id}>
            <summary>
              <span className="inventory-summary-main">
                <span>{item.name}</span>
                {item.framework && (
                  <span className="muted inventory-framework">{item.framework}</span>
                )}
              </span>
              <Icon name="chevron" />
            </summary>
            <div className="stack inventory-item-content">
              <SourceRef location={item.location} />
              {item.description && <p>{item.description}</p>}
              <dl className="detail-list">
                {item.rows.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              {item.prompt !== undefined && (
                <pre className="code-block">
                  <code>{item.prompt}</code>
                </pre>
              )}
              {item.capabilities && (
                <div>
                  <h4>Observed capabilities</h4>
                  <CapabilityList capabilities={item.capabilities} />
                </div>
              )}
            </div>
          </details>
        ))
      )}
    </section>
  );
}

const list = (values: string[]) => (values.length > 0 ? values.join(", ") : "None observed");
const known = (value: string | null) => value ?? "Not resolved";

export function InventoryView({ report }: { report: DashboardScan }) {
  const inventory = report.scan.inventory;
  return (
    <section className="stack" aria-labelledby="inventory-heading">
      <div className="section-heading view-section-intro">
        <div>
          <h2 id="inventory-heading">Source inventory</h2>
          <p className="muted">
            Expand an item to explore its declarations and observed capabilities.
          </p>
        </div>
        <span className="tag">Built from source</span>
      </div>
      <div className="panel framework-overview">
        <div className="section-heading inventory-category-heading">
          <div className="category-heading-main">
            <span className="category-icon">
              <Icon name="inventory" />
            </span>
            <div>
              <h3>Frameworks</h3>
              <p className="muted">Recognized in the scanned files</p>
            </div>
          </div>
          <span className="category-count">{inventory.frameworks.length}</span>
        </div>
        {inventory.frameworks.length > 0 ? (
          <div className="capabilities framework-chips">
            {inventory.frameworks.map((framework) => (
              <span className="tag" key={framework.id}>
                {framework.name} · {framework.files.length}{" "}
                {framework.files.length === 1 ? "file" : "files"}
              </span>
            ))}
          </div>
        ) : (
          <p className="muted">No supported AI frameworks observed.</p>
        )}
        {inventory.unrecognised.length > 0 && (
          <details>
            <summary>Unrecognized AI imports ({inventory.unrecognised.length})</summary>
            <ul>
              {inventory.unrecognised.map((item) => (
                <li key={item.module}>
                  <code>{item.module}</code>
                  <p className="muted">{item.files.join(", ")}</p>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="inventory-grid">
        <InventoryCategory
          title="Models"
          items={inventory.models.map((item) => ({
            id: item.id,
            name: item.model ?? item.target,
            location: item.location,
            framework: item.framework,
            rows: [
              ["Constructor", item.target],
              ["Model", known(item.model)],
              ["Base URL", known(item.baseUrl)],
              ["Credential source", item.credential],
            ],
          }))}
        />
        <InventoryCategory
          title="Agents"
          items={inventory.agents.map((item) => ({
            id: item.id,
            name: item.name ?? item.target,
            location: item.location,
            framework: item.framework,
            capabilities: item.capabilities,
            rows: [
              ["Constructor", item.target],
              ["Model", known(item.model)],
              ["Tools", list(item.tools)],
              ["Unresolved tool references", String(item.unresolvedTools)],
              ["Approval step", item.approval ?? "Not observed"],
              ["Delegates", list(item.delegates)],
              ["MCP clients", list(item.mcpClients)],
              [
                "Graph nodes",
                list(item.nodes.map((node) => `${node.name}: ${node.handler ?? "not resolved"}`)),
              ],
            ],
          }))}
        />
        <InventoryCategory
          title="Tools"
          items={inventory.tools.map((item) => ({
            id: item.id,
            name: item.name,
            location: item.location,
            framework: item.framework,
            description: item.description,
            capabilities: item.capabilities,
            rows: [
              ["Declaration", item.via],
              [
                "Handler",
                item.handler
                  ? `${item.handlerPath ? `${item.handlerPath}: ` : ""}${item.handler}`
                  : "Not resolved",
              ],
              ["Parameters", list(item.params)],
              ["Approval step", item.approval ?? "Not observed"],
              ["MCP server", known(item.server)],
            ],
          }))}
        />
        <InventoryCategory
          title="LLM calls"
          items={inventory.llmCalls.map((item) => ({
            id: item.id,
            name: item.target,
            location: item.location,
            framework: item.framework,
            capabilities: item.outputEffects,
            rows: [
              ["Model", known(item.model)],
              ["Scope", known(item.scope)],
              ["Client", known(item.client)],
              ["Tools", list(item.tools)],
              ["Unresolved tool references", String(item.unresolvedTools)],
              ["Prompts", list(item.prompts)],
            ],
          }))}
        />
        <InventoryCategory
          title="Entry points"
          items={inventory.entryPoints.map((item) => ({
            id: item.id,
            name:
              item.kind === "http"
                ? `${item.method ?? "*"} ${item.path ?? "Unresolved route"}`
                : `MCP · ${item.handler ?? item.id}`,
            location: item.location,
            framework: item.framework,
            capabilities: item.reaches,
            rows: [
              ["Transport", item.kind],
              [
                "Handler",
                item.handler
                  ? `${item.handlerPath ? `${item.handlerPath}: ` : ""}${item.handler}`
                  : "Not resolved",
              ],
            ],
          }))}
        />
        <InventoryCategory
          title="MCP servers"
          items={inventory.mcpServers.map((item) => ({
            id: item.id,
            name: item.name ?? item.id,
            location: item.location,
            framework: item.framework,
            rows: [
              ["Transport", known(item.transport)],
              ["Tools", list(item.tools)],
              ["Resources", list(item.resources.map((member) => member.name))],
              ["Prompts", list(item.prompts.map((member) => member.name))],
            ],
          }))}
        />
        <InventoryCategory
          title="MCP clients"
          items={inventory.mcpClients.map((item) => ({
            id: item.id,
            name: item.target,
            location: item.location,
            framework: item.framework,
            rows: [
              ["Command", known(item.command)],
              ["URL", known(item.url)],
            ],
          }))}
        />
        <InventoryCategory
          title="Data stores"
          items={inventory.dataStores.map((item) => ({
            id: item.id,
            name: item.target,
            location: item.location,
            framework: item.framework,
            rows: [["Kind", item.kind.replaceAll("_", " ")]],
          }))}
        />
        <InventoryCategory
          title="Prompts"
          items={inventory.prompts.map((item) => ({
            id: item.id,
            name: `${item.role} · ${item.location.path}:${item.location.line}`,
            location: item.location,
            prompt: item.text,
            rows: [
              ["Role", item.role],
              ["Template variables", list(item.variables)],
              ["Used by", list(item.usedBy)],
              ["Dynamic expressions", list(item.dynamic.map((part) => part.text))],
              ["Text completeness", item.truncated ? "Truncated by scanner" : "Captured"],
              ["Credential observation", item.secret ?? "None observed"],
            ],
          }))}
        />
      </div>
    </section>
  );
}

const planExplanations: Record<string, string> = {
  "target-selection-required":
    "Choose one of the candidate entry points below to continue this review.",
  "no-candidate-target": "No entry point meets the current llmfy preparation requirements.",
  "dependency-review-required": "Dependency declarations need attention. Review the details below.",
  "source-file-limit": "Source capture reached its file limit, so this review is incomplete.",
  "source-syntax-errors":
    "Some source files could not be parsed fully, so this review may be incomplete.",
  "source-preparation-gaps":
    "Some source files could not be captured. Review the omitted files below.",
  "no-callable-entry-point":
    "An agent was found, but its callable entry point could not be identified.",
  "not-a-module-function":
    "Automatic preparation currently supports functions defined at the module's top level.",
  "not-a-public-function": "Automatic preparation currently supports public functions only.",
  "decorated-function": "Automatic preparation does not support decorated entry points yet.",
  "ambiguous-symbol": "The entry-point symbol could not be identified unambiguously.",
  "factory-needs-arguments":
    "This factory takes arguments that automatic preparation cannot supply yet.",
  "input-mapping-required":
    "This function's arguments cannot be mapped automatically to a test input yet.",
  "source-has-syntax-errors": "The entry-point source contains syntax errors.",
  "agent-has-syntax-errors": "The agent's source contains syntax errors.",
  "ambiguous-factory-return":
    "The factory can return different values, so its agent could not be selected unambiguously.",
  "outside-python-profile": "This file is outside the current Python-only preparation support.",
  "sensitive-source-path":
    "This source path may contain credentials and was excluded from capture.",
  "embedded-credential": "This file contains a recognized credential and was excluded from review.",
  "total-byte-limit":
    "Source capture reached its total size limit before this file could be included.",
  "outside-project": "This file resolves outside the selected project.",
  "not-a-single-regular-file": "This path is not a regular file or has multiple hard links.",
  "linked-path": "This path contains a symbolic link and was excluded from capture.",
  "too-large": "This file exceeds the review size limit.",
  too_large: "This file exceeds the review size limit.",
  "file-changed": "This file changed during capture. Refresh the plan to review it again.",
  "not-utf8-text": "This file could not be read as UTF-8 text.",
  unreadable: "This path could not be read.",
  missing: "This file was not found.",
  symlink: "Symbolic links are excluded from source capture.",
  gitignored: "Excluded by the project's ignore rules.",
  gitignore: "Excluded by the project's ignore rules.",
  default: "Dependency, build, cache, or version-control directory excluded from review.",
  virtualenv: "Python environment excluded from review.",
  declaration: "Type declaration files are excluded from source review.",
  minified: "Minified source files are excluded from review.",
  "unsupported-dependency-declaration":
    "This dependency declaration is not supported by the current review.",
  "poetry-metadata-not-supported":
    "Poetry dependency metadata is not supported by the current review.",
  "custom-dependency-source-not-supported":
    "Custom package sources are not supported by the current review.",
  "dynamic-dependencies-not-supported":
    "Dependencies computed by project code cannot be reviewed automatically yet.",
  "invalid-dependencies": "The dependency list does not have the expected format.",
  "unsupported-python-constraint":
    "The declared Python version constraint is not supported by the current review.",
  "invalid-toml": "The TOML manifest could not be parsed.",
  "llmfy-dependency-not-declared":
    "No llmfy dependency declaration was found in the reviewed manifests.",
  "llmfy-version-unresolved": "The reviewed declarations do not identify one exact llmfy version.",
  "llmfy-version-not-qualified": "The declared llmfy version has not been qualified by Plenger.",
  read: "Reviewed successfully.",
};

function explainPlanValue(value: string): string {
  if (value.startsWith("conflicting-dependency:")) {
    return `Different constraints were declared for ${value.slice("conflicting-dependency:".length)}; compatibility has not been resolved.`;
  }
  const explanation = planExplanations[value];
  if (explanation) return explanation;
  const words = value.replaceAll(/[-_]/g, " ");
  return words ? `${words[0]?.toUpperCase()}${words.slice(1)}` : "No additional details available.";
}

const pendingExplanations: Record<string, string> = {
  "Qualify required data/configuration resources; the snapshot contains Python source only.":
    "Support for project data and configuration files must be qualified before execution.",
  "Resolve and qualify dependencies, Python version and project layout; lockfiles are not resolved yet.":
    "Dependency installation and project compatibility checks are still being built.",
  "Verify input/output mapping and bind compatible built-in test packs and effect hooks.":
    "Automatic input/output handling, built-in test packs, and action observation must be connected.",
  "Replace any embedded access with managed access; static secret recognition is not exhaustive.":
    "Managed credentials are required for future runs. This review does not transfer project credentials.",
  "Select provider access and enforce run-wide call/token limits through the managed network path.":
    "Model access and enforced budgets must be connected to the managed network path.",
  "Qualify the live-model runtime; this plan contains no executable test cases yet.":
    "Execution with a live model must be qualified before dynamic runs are available.",
};

export function RedteamView({
  project,
  plan,
  busy,
  disabled,
  error,
  onPlan,
}: {
  project: string;
  plan: ProjectPlan | null;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onPlan: (target?: string) => void;
}) {
  return (
    <section className="stack" aria-labelledby="redteam-heading">
      <div className="section-heading view-section-intro">
        <div>
          <h2 id="redteam-heading">Project readiness</h2>
          <p className="muted">Understand what can be prepared before running a test.</p>
        </div>
        <Button
          type="button"
          className="button button-primary"
          disabled={disabled || !project.trim()}
          onClick={() => onPlan()}
        >
          <Icon name="scan" />
          {busy ? "Reviewing project…" : plan ? "Refresh plan" : "Review plan"}
        </Button>
      </div>
      <div className="status-banner plan-callout">
        <span className="callout-icon">
          <Icon name="redteam" />
        </span>
        <div className="callout-body">
          <h3>Offline planning is available</h3>
          <p>
            Review llmfy targets, source coverage, and dependency declarations. This step does not
            call a model or run project code. Dynamic tests are still being built.
          </p>
        </div>
        <span className="tag callout-status">Planning only</span>
      </div>
      {error && (
        <div className="status-banner error-banner plan-callout" role="alert">
          <span className="callout-icon">
            <Icon name="findings" />
          </span>
          <div className="callout-body">
            <h3>Could not review this project</h3>
            <p>{error}</p>
            <p>Check the selected folder, then retry the review.</p>
          </div>
        </div>
      )}
      {busy && (
        <p className="muted" role="status">
          Inspecting the selected project and preparing its source review…
        </p>
      )}
      {!plan && !busy && (
        <div className="panel empty-state">
          <span className="empty-state-symbol">
            <Icon name="redteam" />
          </span>
          <h3>Start with a project review</h3>
          <p>
            Choose a project folder, then select Review plan to see the entry points Plenger can
            prepare.
          </p>
        </div>
      )}
      {plan && (
        <>
          <div className="panel readiness-card">
            <div className="section-heading readiness-title">
              <div className="category-heading-main">
                <span className="category-icon">
                  <Icon name="redteam" />
                </span>
                <div>
                  <h3>Preparation summary</h3>
                  <p className="muted">The current source review for this project</p>
                </div>
              </div>
              <span
                className={`tag ${plan.preparation.status === "ready" ? "ready-status" : "attention-status"}`}
              >
                {plan.preparation.status === "ready" ? "Source review ready" : "Needs attention"}
              </span>
            </div>
            <dl className="readiness-summary">
              <div>
                <dt>Entry points</dt>
                <dd>
                  {plan.targets.length}
                  <span className="muted"> discovered</span>
                </dd>
              </div>
              <div>
                <dt>Source files</dt>
                <dd>
                  {plan.sources.files.length}
                  <span className="muted"> captured</span>
                </dd>
              </div>
              <div>
                <dt>Dynamic testing</dt>
                <dd className="muted">Not available yet</dd>
              </div>
            </dl>
            <dl className="detail-list readiness-details">
              <div>
                <dt>Project</dt>
                <dd>
                  <code>{plan.root}</code>
                </dd>
              </div>
              <div>
                <dt>Target selection</dt>
                <dd>
                  {plan.selection === "automatic"
                    ? "One candidate selected automatically"
                    : plan.selection === "explicit"
                      ? "Selected by you"
                      : plan.selection === "required"
                        ? "Choose a candidate below"
                        : "No supported candidate available"}
                </dd>
              </div>
            </dl>
            {plan.preparation.reasons.length > 0 && (
              <ul>
                {uniqueObservations(plan.preparation.reasons).map((reason) => (
                  <li key={reason}>{explainPlanValue(reason)}</li>
                ))}
              </ul>
            )}
          </div>
          <section className="panel targets-card">
            <div className="section-heading plan-section-heading">
              <div>
                <h3>Discovered targets</h3>
                <p className="muted">Entry points captured from Python source</p>
              </div>
              <span className="category-count">{plan.targets.length}</span>
            </div>
            {plan.selection === "required" && (
              <p>Select a candidate below to create a plan for that entry point.</p>
            )}
            {plan.targets.length === 0 ? (
              <p className="muted">
                No llmfy targets were discovered in the captured Python source.
              </p>
            ) : (
              <div className="candidate-list">
                {plan.targets.map((target) => (
                  <article
                    className={`candidate-row ${target.id === plan.selectedTarget ? "is-selected" : ""}`}
                    key={target.id}
                  >
                    <div className="candidate-main">
                      <div className="section-heading candidate-heading">
                        <h4>{target.symbol ?? "Unresolved entry point"}</h4>
                        <span
                          className={`tag target-status ${target.id === plan.selectedTarget ? "ready-status" : ""}`}
                        >
                          {target.id === plan.selectedTarget
                            ? "Selected"
                            : target.status === "candidate"
                              ? "Candidate"
                              : "Not supported yet"}
                        </span>
                      </div>
                      <SourceRef location={target.location} />
                      <p className="muted">
                        {target.kind === "factory"
                          ? "Agent factory"
                          : target.kind === "function"
                            ? "Agent entry function"
                            : "Unresolved entry point"}
                      </p>
                      {target.reasons.length > 0 && (
                        <ul>
                          {uniqueObservations(target.reasons).map((reason) => (
                            <li key={reason}>{explainPlanValue(reason)}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="target-actions">
                      {target.status === "candidate" && (
                        <Button
                          type="button"
                          className="button button-secondary"
                          disabled={disabled}
                          onClick={() => onPlan(target.id)}
                          aria-label={`${target.id === plan.selectedTarget ? "Review selected target" : "Review this target"}: ${target.symbol ?? target.id}`}
                        >
                          {target.id === plan.selectedTarget && <Icon name="check" />}
                          {target.id === plan.selectedTarget
                            ? "Review selected target"
                            : "Review this target"}
                        </Button>
                      )}
                      <details>
                        <summary>Technical target details</summary>
                        <p className="target-shape">
                          <code>
                            {target.kind}
                            {target.async ? " · async" : ""} · ({target.parameters.join(", ")})
                          </code>
                        </p>
                        <code>{target.id}</code>
                      </details>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
          <div className="inventory-grid">
            <section className="panel inventory-card">
              <div className="category-heading-main">
                <span className="category-icon">
                  <Icon name="folder" />
                </span>
                <h3>Source coverage</h3>
              </div>
              <dl className="detail-list">
                <div>
                  <dt>Captured files</dt>
                  <dd>{plan.sources.files.length}</dd>
                </div>
                <div>
                  <dt>Supported source</dt>
                  <dd>Python files only</dd>
                </div>
                <div>
                  <dt>Data and configuration files</dt>
                  <dd>Not included in this review</dd>
                </div>
                <div>
                  <dt>Source limit reached</dt>
                  <dd>{plan.sources.truncated ? "Yes" : "No"}</dd>
                </div>
              </dl>
              {plan.sources.files.length > 0 && (
                <details>
                  <summary>Captured source files</summary>
                  <ul>
                    {plan.sources.files.map((file) => (
                      <li key={file.path}>
                        <code>{file.path}</code>{" "}
                        <span className="muted">{file.bytes.toLocaleString()} bytes</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {plan.sources.omitted.length > 0 && (
                <details open>
                  <summary>Omitted files ({plan.sources.omitted.length})</summary>
                  <ul>
                    {uniqueObservations(plan.sources.omitted).map((file) => (
                      <li key={`${file.path}-${file.reason}`}>
                        <code>{file.path}</code> — {explainPlanValue(file.reason)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {plan.sources.excludedDirs.length > 0 && (
                <details>
                  <summary>Excluded directories ({plan.sources.excludedDirs.length})</summary>
                  <ul>
                    {uniqueObservations(plan.sources.excludedDirs).map((directory) => (
                      <li key={`${directory.path}-${directory.reason}`}>
                        <code>{directory.path}</code> — {explainPlanValue(directory.reason)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
            <section className="panel inventory-card">
              <div className="category-heading-main">
                <span className="category-icon">
                  <Icon name="inventory" />
                </span>
                <h3>Dependency review</h3>
              </div>
              <p className="muted">
                Declarations only. Dependencies have not been resolved or installed.
              </p>
              <dl className="detail-list">
                <div>
                  <dt>Status</dt>
                  <dd>
                    {plan.dependencies.status === "declared"
                      ? "Declarations reviewed"
                      : "Needs attention"}
                  </dd>
                </div>
                <div>
                  <dt>Declared llmfy version</dt>
                  <dd>{known(plan.dependencies.llmfy.version)}</dd>
                </div>
                <div>
                  <dt>Matches the tested llmfy example</dt>
                  <dd>{plan.dependencies.llmfy.matchesSyntheticBaseline ? "Yes" : "No"}</dd>
                </div>
                <div>
                  <dt>Python constraint</dt>
                  <dd>{known(plan.dependencies.requiresPython)}</dd>
                </div>
              </dl>
              {plan.dependencies.issues.length > 0 && (
                <ul>
                  {uniqueObservations(plan.dependencies.issues).map((issue) => (
                    <li key={`${issue.path}-${issue.line ?? ""}-${issue.reason}`}>
                      <code>
                        {issue.path}
                        {issue.line ? `:${issue.line}` : ""}
                      </code>{" "}
                      — {explainPlanValue(issue.reason)}
                    </li>
                  ))}
                </ul>
              )}
              <details>
                <summary>Reviewed manifests</summary>
                <ul>
                  {plan.dependencies.manifests.map((manifest) => (
                    <li key={manifest.path}>
                      <code>{manifest.path}</code> — {explainPlanValue(manifest.status)}
                    </li>
                  ))}
                </ul>
              </details>
              {plan.dependencies.packages.length > 0 && (
                <details>
                  <summary>Declared packages ({plan.dependencies.packages.length})</summary>
                  <ul>
                    {uniqueObservations(plan.dependencies.packages).map((item) => (
                      <li
                        key={`${item.name}-${item.extras.join(",")}-${item.constraint}-${item.source}`}
                      >
                        <code>
                          {item.name}
                          {item.extras.length > 0 ? `[${item.extras.join(",")}]` : ""}
                          {item.constraint}
                        </code>
                        <p className="muted">{item.source}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          </div>
          {plan.pending.length > 0 && (
            <section className="panel pending-card">
              <div className="category-heading-main">
                <span className="category-icon">
                  <Icon name="history" />
                </span>
                <div>
                  <h3>Remaining before execution</h3>
                  <p className="muted">
                    These capabilities must be connected before dynamic tests can run.
                  </p>
                </div>
              </div>
              <ul className="pending-checklist">
                {uniqueObservations(plan.pending).map((item) => (
                  <li key={item}>
                    <span className="pending-step" aria-hidden="true" />
                    <span>{pendingExplanations[item] ?? explainPlanValue(item)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <details className="panel snapshot-details">
            <summary>Source snapshot identity</summary>
            <p className="muted">
              This digest covers captured Python source and reviewed manifests. It does not cover
              undiscovered project resources.
            </p>
            <code className="digest">{plan.sourceDigest}</code>
            <p className="muted">
              Capture policy: {plan.sources.policy} · Project resources: {plan.sources.resources} ·
              Execution ready: {String(plan.executionReady)}
            </p>
          </details>
        </>
      )}
    </section>
  );
}
