import type { ReactNode } from "react";
import type { DashboardScan, SavedRunProfile } from "../../src/dashboard/model.ts";
import type { ProjectPlan } from "../../src/redteam/plan.ts";
import { runBlocker } from "../../src/redteam/profile.ts";
import type { RedteamRun } from "../../src/redteam/run.ts";
import type { DashboardApi } from "./api.ts";
import { InventoryBrowser, type InventoryItem } from "./InventoryBrowser.tsx";
import { Icon } from "./icons.tsx";
import { RedteamRunner } from "./RedteamRunner.tsx";
import { ScrollArea } from "./ScrollArea.tsx";
import { SourceRef } from "./SourceRef.tsx";
import { Button } from "./ui.tsx";

function uniqueObservations<T>(values: T[]): T[] {
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
}

function TechnicalDisclosure({
  title,
  children,
  open,
  scrollable = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
  scrollable?: boolean;
  className?: string;
}) {
  return (
    <details className={`technical-disclosure ${className}`} open={open}>
      <summary className="disclosure-heading">
        <span>{title}</span>
        <Icon name="chevron" />
      </summary>
      <div className="technical-content">
        {scrollable ? (
          <ScrollArea className="technical-list-scroll" role="region" aria-label={title}>
            {children}
          </ScrollArea>
        ) : (
          children
        )}
      </div>
    </details>
  );
}

const list = (values: string[]) => (values.length > 0 ? values.join(", ") : "None observed");
const known = (value: string | null) => value ?? "Not resolved";

export function InventoryView({ report }: { report: DashboardScan }) {
  const inventory = report.scan.inventory;
  const toolNames = new Map(inventory.tools.map((tool) => [tool.id, tool.name]));
  const tools = (ids: string[]) => ids.map((id) => toolNames.get(id) ?? id);
  const toolPreview = (ids: string[], unresolved = 0) => {
    const names = tools(ids);
    const parts = names.slice(0, 2);
    if (names.length > 2) parts.push(`+${names.length - 2} more`);
    if (unresolved > 0)
      parts.push(`${unresolved} unresolved ${unresolved === 1 ? "reference" : "references"}`);
    return parts.length > 0 ? parts.join(", ") : "None observed";
  };
  const categories: { title: string; items: InventoryItem[] }[] = [
    {
      title: "Models",
      items: inventory.models.map((item) => ({
        id: item.id,
        name: item.model ?? item.target,
        location: item.location,
        framework: item.framework,
        preview: [
          [item.model ? "Client" : "Model", item.model ? item.target : "Not resolved"],
          ...(item.baseUrl ? [["Base URL", item.baseUrl] as [string, string]] : []),
        ],
        rows: [
          ["Constructor", item.target],
          ["Model", known(item.model)],
          ["Base URL", known(item.baseUrl)],
          ["Credential source", item.credential],
        ],
      })),
    },
    {
      title: "Agents",
      items: inventory.agents.map((item) => ({
        id: item.id,
        name: item.name ?? item.target,
        location: item.location,
        framework: item.framework,
        preview: [
          ...(item.name ? [["Constructor", item.target] as [string, string]] : []),
          ["Model", known(item.model)],
          ["Tools", toolPreview(item.tools, item.unresolvedTools)],
          ...(item.nodes.length > 0
            ? [["Graph nodes", String(item.nodes.length)] as [string, string]]
            : []),
        ],
        capabilities: item.capabilities,
        toolCount: item.tools.length,
        unresolvedTools: item.unresolvedTools,
        rows: [
          ["Constructor", item.target],
          ["Model", known(item.model)],
          ["Tools", list(tools(item.tools))],
          ["Unresolved tools", String(item.unresolvedTools)],
          ["Approval step", item.approval ?? "Not observed"],
          ["Delegates", list(item.delegates)],
          ["MCP clients", list(item.mcpClients)],
          [
            "Graph nodes",
            list(item.nodes.map((node) => `${node.name}: ${node.handler ?? "not resolved"}`)),
          ],
        ],
      })),
    },
    {
      title: "Tools",
      items: inventory.tools.map((item) => ({
        id: item.id,
        name: item.name,
        location: item.location,
        framework: item.framework,
        description: item.description,
        capabilities: item.capabilities,
        preview: [
          ["Declaration", item.via],
          ["Parameters", list(item.params)],
        ],
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
      })),
    },
    {
      title: "LLM calls",
      items: inventory.llmCalls.map((item) => ({
        id: item.id,
        name: item.target,
        location: item.location,
        framework: item.framework,
        preview: [["Model", known(item.model)]],
        capabilities: item.outputEffects,
        rows: [
          ["Model", known(item.model)],
          ["Scope", known(item.scope)],
          ["Client", known(item.client)],
          ["Tools", list(tools(item.tools))],
          ["Unresolved tools", String(item.unresolvedTools)],
          ["Prompts", list(item.prompts)],
        ],
      })),
    },
    {
      title: "Entry points",
      items: inventory.entryPoints.map((item) => ({
        id: item.id,
        name:
          item.kind === "http"
            ? `${item.method ?? "*"} ${item.path ?? "Unresolved route"}`
            : `MCP · ${item.handler ?? item.id}`,
        location: item.location,
        framework: item.framework,
        capabilities: item.reaches,
        preview: [
          ["Transport", item.kind],
          ["Handler", known(item.handler)],
        ],
        rows: [
          ["Transport", item.kind],
          [
            "Handler",
            item.handler
              ? `${item.handlerPath ? `${item.handlerPath}: ` : ""}${item.handler}`
              : "Not resolved",
          ],
        ],
      })),
    },
    {
      title: "MCP servers",
      items: inventory.mcpServers.map((item) => ({
        id: item.id,
        name: item.name ?? "Unnamed MCP server",
        toolCount: item.tools.length,
        location: item.location,
        framework: item.framework,
        preview: [
          ["Transport", known(item.transport)],
          ["Tools", toolPreview(item.tools)],
        ],
        rows: [
          ["Transport", known(item.transport)],
          ["Tools", list(tools(item.tools))],
          ["Resources", list(item.resources.map((member) => member.name))],
          ["Prompts", list(item.prompts.map((member) => member.name))],
        ],
      })),
    },
    {
      title: "MCP clients",
      items: inventory.mcpClients.map((item) => ({
        id: item.id,
        name: item.target,
        location: item.location,
        framework: item.framework,
        preview: item.url ? [["URL", item.url]] : [["Command", known(item.command)]],
        rows: [
          ["Command", known(item.command)],
          ["URL", known(item.url)],
        ],
      })),
    },
    {
      title: "Data stores",
      items: inventory.dataStores.map((item) => ({
        id: item.id,
        name: item.target,
        location: item.location,
        framework: item.framework,
        preview: [["Kind", item.kind.replaceAll("_", " ")]],
        rows: [["Kind", item.kind.replaceAll("_", " ")]],
      })),
    },
    {
      title: "Prompts",
      items: inventory.prompts.map((item) => ({
        id: item.id,
        name: `${item.role[0]?.toUpperCase()}${item.role.slice(1)} prompt`,
        location: item.location,
        prompt: item.text,
        preview: [
          ["Variables", list(item.variables)],
          ["Text", item.truncated ? "Truncated by scanner" : "Captured"],
        ],
        rows: [
          ["Role", item.role],
          ["Template variables", list(item.variables)],
          ["Used by", list(item.usedBy)],
          ["Dynamic expressions", list(item.dynamic.map((part) => part.text))],
          ["Text completeness", item.truncated ? "Truncated by scanner" : "Captured"],
          ["Credential observation", item.secret ?? "None observed"],
        ],
      })),
    },
  ];
  return (
    <section className="stack" aria-labelledby="inventory-heading">
      <h2 id="inventory-heading" className="sr-only">
        Source inventory
      </h2>
      <details className="framework-overview">
        <summary className="disclosure-heading">
          <span className="category-heading-main">
            <span className="category-icon">
              <Icon name="frameworks" />
            </span>
            <span>Frameworks</span>
            <span className="category-count">{inventory.frameworks.length}</span>
            <span className="framework-summary muted">
              {inventory.frameworks.length > 0
                ? `${inventory.frameworks
                    .slice(0, 4)
                    .map((framework) => framework.name)
                    .join(
                      ", ",
                    )}${inventory.frameworks.length > 4 ? ` +${inventory.frameworks.length - 4} more` : ""}`
                : "None observed"}
            </span>
          </span>
          <Icon name="chevron" />
        </summary>
        <div className="framework-content">
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
            <TechnicalDisclosure
              title={`Unrecognized AI imports (${inventory.unrecognised.length})`}
              scrollable
            >
              <ul className="review-list">
                {inventory.unrecognised.map((item) => (
                  <li className="review-row" key={item.module}>
                    <code className="review-path">{item.module}</code>
                    <span className="review-note muted">{item.files.join(", ")}</span>
                  </li>
                ))}
              </ul>
            </TechnicalDisclosure>
          )}
        </div>
      </details>
      <InventoryBrowser
        categories={categories}
        initialCategory={
          inventory.agents.length > 0
            ? "Agents"
            : (categories.find((category) => category.items.length > 0)?.title ?? "Models")
        }
      />
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
    "Project data and configuration files need support beyond the file-test preview.",
  "Resolve and qualify dependencies, Python version and project layout; lockfiles are not resolved yet.":
    "Additional dependencies, Python constraints and layouts need qualified runtime profiles.",
  "Verify input/output mapping and bind compatible built-in test packs and effect hooks.":
    "Broader test packs need compatible input mapping and observable action boundaries.",
  "Replace any embedded access with managed access; static secret recognition is not exhaustive.":
    "Broader model adapters need managed access. Offline review does not transfer project credentials.",
  "Select provider access and enforce run-wide call/token limits through the managed network path.":
    "Qualify live-model availability and usage accounting through the shared budget and broker.",
  "Qualify the live-model runtime; this plan contains no executable test cases yet.":
    "The file-test preview still needs qualification with a real model before M6a is complete.",
};

export function RedteamView({
  project,
  plan,
  busy,
  disabled,
  error,
  onPlan,
  api,
  runs,
  profile,
  onRunUpdate,
}: {
  project: string;
  plan: ProjectPlan | null;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onPlan: (target?: string) => void;
  api: DashboardApi | null;
  runs: RedteamRun[];
  profile: SavedRunProfile | null;
  onRunUpdate: (run: RedteamRun) => void;
}) {
  const reviewButton = (
    <Button
      type="button"
      className="button button-secondary"
      disabled={disabled || !project.trim()}
      onClick={() => onPlan()}
    >
      <Icon name="scan" />
      {busy ? "Reviewing project…" : plan ? "Refresh test setup" : "Review test setup"}
    </Button>
  );
  return (
    <section className="stack" aria-labelledby="redteam-heading">
      {runs.length === 0 ? (
        <div className="section-heading view-section-intro">
          <div>
            <h2 id="redteam-heading">Security tests</h2>
            <p className="muted">
              Review observed weaknesses, test coverage, and the next steps to take.
            </p>
          </div>
          {reviewButton}
        </div>
      ) : (
        <h2 id="redteam-heading" className="sr-only">
          Security test results
        </h2>
      )}

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
            Choose a project folder, then select Review test setup to see the entry points Plenger
            can prepare.
          </p>
        </div>
      )}
      {plan && (
        <>
          <RedteamRunner
            key={plan.root}
            api={api}
            plan={plan}
            runs={runs}
            profile={profile}
            disabled={disabled}
            onUpdate={onRunUpdate}
          />
          <details
            className="redteam-preparation"
            open={runs.length === 0}
            key={`${plan.root}-${runs.length === 0 ? "first" : "results"}`}
          >
            <summary className="disclosure-heading">
              <span>Test setup and supported targets</span>
              <Icon name="chevron" />
            </summary>
            <div className="stack">
              {runs.length > 0 && (
                <div className="section-heading">
                  <div>
                    <h3>Source preparation</h3>
                    <p className="muted">Review the current project before starting a new test.</p>
                  </div>
                  {reviewButton}
                </div>
              )}
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
                    {plan.targets.length === 0 && (plan.coverage?.files ?? 0) > 0
                      ? "Runtime profile unavailable"
                      : plan.preparation.status === "ready"
                        ? "Source review ready"
                        : "Needs attention"}
                  </span>
                </div>
                <dl className="readiness-summary">
                  <div className="readiness-fact">
                    <dt>Supported targets</dt>
                    <dd className="readiness-value">
                      <span className="readiness-number">{plan.targets.length}</span>
                      <span className="muted readiness-context"> discovered</span>
                    </dd>
                  </div>
                  <div className="readiness-fact">
                    <dt>Runtime source snapshot</dt>
                    <dd className="readiness-value">
                      <span className="readiness-number">{plan.sources.files.length}</span>
                      <span className="muted readiness-context"> captured</span>
                    </dd>
                  </div>
                  <div className="readiness-fact">
                    <dt>Dynamic testing</dt>
                    <dd className="readiness-value readiness-unavailable">
                      {runBlocker(plan)
                        ? "Runtime profile unavailable"
                        : plan.nextProfile
                          ? "Booking-test preview"
                          : "File-test preview"}
                    </dd>
                  </div>
                </dl>
                {plan.coverage && (
                  <div className="status-banner plan-callout">
                    <div className="callout-body">
                      <h3>Static review: {plan.coverage.files} source files</h3>
                      <p>
                        {plan.coverage.httpEntryPoints.length} HTTP entry points and{" "}
                        {plan.coverage.toolUsingCalls} tool-using model flows were discovered across{" "}
                        {plan.coverage.frameworks.map((framework) => framework.name).join(", ") ||
                          "the scanned source"}
                        .
                        {plan.targets.length === 0
                          ? " This project has no candidate for the current Python/llmfy runtime profile. These static observations remain available in Inventory."
                          : plan.nextProfile
                            ? " Runtime preparation captures the selected POST handler and its local imports."
                            : " Runtime preparation covers the Python/llmfy profile only."}
                      </p>
                    </div>
                  </div>
                )}
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
                  <ul className="notice-list readiness-notices">
                    {uniqueObservations(plan.preparation.reasons).map((reason) => (
                      <li key={reason}>{explainPlanValue(reason)}</li>
                    ))}
                  </ul>
                )}
              </div>
              <section className="panel targets-card">
                <div className="panel-intro targets-intro">
                  <div className="section-heading plan-section-heading">
                    <div>
                      <h3>Discovered targets</h3>
                      <p className="muted">Entry points captured from source</p>
                    </div>
                    <span className="category-count">{plan.targets.length}</span>
                  </div>
                  {plan.selection === "required" && (
                    <p className="panel-note">
                      Select a candidate below to create a plan for that entry point.
                    </p>
                  )}
                  {plan.targets.length === 0 && (
                    <p className="muted panel-note">
                      {plan.coverage?.httpEntryPoints.length
                        ? "HTTP entry points were found, but their runtime adapters are not available yet. No project code has been run."
                        : "No llmfy targets were discovered in the captured Python source."}
                    </p>
                  )}
                </div>
                {plan.targets.length > 0 && (
                  <div className="candidate-list">
                    {plan.targets.map((target) => (
                      <article
                        className={`candidate-row ${target.id === plan.selectedTarget ? "is-selected" : ""}`}
                        key={target.id}
                      >
                        <div className="candidate-main candidate-body">
                          <div className="section-heading candidate-heading">
                            <h4>{target.symbol ?? "Unresolved entry point"}</h4>
                          </div>
                          <div className="candidate-location">
                            <SourceRef location={target.location} />
                          </div>
                          <p className="muted candidate-kind">
                            {target.kind === "factory"
                              ? "Agent factory"
                              : target.kind === "function"
                                ? "Agent entry function"
                                : target.kind === "route"
                                  ? "Next.js POST handler"
                                  : "Unresolved entry point"}
                          </p>
                          {target.reasons.length > 0 && (
                            <ul className="notice-list candidate-notices">
                              {uniqueObservations(target.reasons).map((reason) => (
                                <li key={reason}>{explainPlanValue(reason)}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div className="target-actions">
                          <span
                            className={`tag target-status ${target.id === plan.selectedTarget ? "ready-status" : ""}`}
                          >
                            {target.id === plan.selectedTarget
                              ? "Selected"
                              : target.status === "candidate"
                                ? "Candidate"
                                : "Not supported yet"}
                          </span>
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
                        </div>
                        <TechnicalDisclosure
                          className="target-disclosure"
                          title="Technical target details"
                        >
                          <p className="target-shape">
                            <code>
                              {target.kind}
                              {target.async ? " · async" : ""} · ({target.parameters.join(", ")})
                            </code>
                          </p>
                          <code className="target-id">{target.id}</code>
                        </TechnicalDisclosure>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <div className="inventory-grid plan-detail-grid">
                <section className="panel inventory-card plan-detail-card">
                  <div className="plan-card-intro">
                    <div className="category-heading-main">
                      <span className="category-icon">
                        <Icon name="source-files" />
                      </span>
                      <h3>Source coverage</h3>
                    </div>
                  </div>
                  <dl className="detail-list">
                    <div>
                      <dt>Captured files</dt>
                      <dd>{plan.sources.files.length}</dd>
                    </div>
                    <div>
                      <dt>Supported source</dt>
                      <dd>
                        {plan.nextProfile
                          ? "Selected TypeScript/JavaScript import closure"
                          : "Python files only"}
                      </dd>
                    </div>
                    <div>
                      <dt>Data and configuration files</dt>
                      <dd>
                        {plan.nextProfile
                          ? "SQLite is created automatically for each check"
                          : "Not included in this review"}
                      </dd>
                    </div>
                    <div>
                      <dt>Source limit reached</dt>
                      <dd>{plan.sources.truncated ? "Yes" : "No"}</dd>
                    </div>
                  </dl>
                  {plan.sources.files.length > 0 && (
                    <TechnicalDisclosure title="Captured source files" scrollable>
                      <ul className="review-list">
                        {plan.sources.files.map((file) => (
                          <li className="review-row" key={file.path}>
                            <code className="review-path">{file.path}</code>
                            <span className="muted review-meta">
                              {file.bytes.toLocaleString()} bytes
                            </span>
                          </li>
                        ))}
                      </ul>
                    </TechnicalDisclosure>
                  )}
                  {plan.sources.omitted.length > 0 && (
                    <TechnicalDisclosure
                      title={`Omitted files (${plan.sources.omitted.length})`}
                      scrollable
                    >
                      <ul className="review-list">
                        {uniqueObservations(plan.sources.omitted).map((file) => (
                          <li className="review-row" key={`${file.path}-${file.reason}`}>
                            <code className="review-path">{file.path}</code>
                            <span className="review-note">{explainPlanValue(file.reason)}</span>
                          </li>
                        ))}
                      </ul>
                    </TechnicalDisclosure>
                  )}
                  {plan.sources.excludedDirs.length > 0 && (
                    <TechnicalDisclosure
                      title={`Excluded directories (${plan.sources.excludedDirs.length})`}
                      scrollable
                    >
                      <ul className="review-list">
                        {uniqueObservations(plan.sources.excludedDirs).map((directory) => (
                          <li className="review-row" key={`${directory.path}-${directory.reason}`}>
                            <code className="review-path">{directory.path}</code>
                            <span className="review-note">
                              {explainPlanValue(directory.reason)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </TechnicalDisclosure>
                  )}
                </section>
                <section className="panel inventory-card plan-detail-card">
                  <div className="plan-card-intro">
                    <div className="category-heading-main">
                      <span className="category-icon">
                        <Icon name="frameworks" />
                      </span>
                      <h3>Dependency review</h3>
                    </div>
                    <p className="muted panel-note">
                      {plan.nextProfile
                        ? "The managed image pins AI SDK, Zod and SQLite dependencies. Project installers and scripts are not run."
                        : "Declarations only. Dependencies have not been resolved or installed."}
                    </p>
                  </div>
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
                      <dt>
                        {plan.nextProfile ? "Managed AI SDK version" : "Declared llmfy version"}
                      </dt>
                      <dd>
                        {plan.nextProfile
                          ? plan.nextProfile.versions.ai
                          : known(plan.dependencies.llmfy.version)}
                      </dd>
                    </div>
                    <div>
                      <dt>
                        {plan.nextProfile ? "Database setup" : "Matches the tested llmfy example"}
                      </dt>
                      <dd>
                        {plan.nextProfile
                          ? "Automatic · disposable SQLite"
                          : plan.dependencies.llmfy.matchesSyntheticBaseline
                            ? "Yes"
                            : "No"}
                      </dd>
                    </div>
                    <div>
                      <dt>{plan.nextProfile ? "Managed Node.js version" : "Python constraint"}</dt>
                      <dd>
                        {plan.nextProfile ? "22.18.0" : known(plan.dependencies.requiresPython)}
                      </dd>
                    </div>
                  </dl>
                  {plan.dependencies.issues.length > 0 && (
                    <ul className="review-list dependency-issues">
                      {uniqueObservations(plan.dependencies.issues).map((issue) => (
                        <li
                          className="review-row"
                          key={`${issue.path}-${issue.line ?? ""}-${issue.reason}`}
                        >
                          <code className="review-path">
                            {issue.path}
                            {issue.line ? `:${issue.line}` : ""}
                          </code>
                          <span className="review-note">{explainPlanValue(issue.reason)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <TechnicalDisclosure title="Reviewed manifests" scrollable>
                    <ul className="review-list">
                      {plan.dependencies.manifests.map((manifest) => (
                        <li className="review-row" key={manifest.path}>
                          <code className="review-path">{manifest.path}</code>
                          <span className="review-note">{explainPlanValue(manifest.status)}</span>
                        </li>
                      ))}
                    </ul>
                  </TechnicalDisclosure>
                  {plan.dependencies.packages.length > 0 && (
                    <TechnicalDisclosure
                      title={`Declared packages (${plan.dependencies.packages.length})`}
                      scrollable
                    >
                      <ul className="review-list">
                        {uniqueObservations(plan.dependencies.packages).map((item) => (
                          <li
                            className="review-row"
                            key={`${item.name}-${item.extras.join(",")}-${item.constraint}-${item.source}`}
                          >
                            <code className="review-path">
                              {item.name}
                              {item.extras.length > 0 ? `[${item.extras.join(",")}]` : ""}
                              {item.constraint}
                            </code>
                            <span className="muted review-note">{item.source}</span>
                          </li>
                        ))}
                      </ul>
                    </TechnicalDisclosure>
                  )}
                </section>
              </div>
              {plan.pending.length > 0 && (
                <section className="panel pending-card">
                  <div className="plan-card-intro">
                    <div className="category-heading-main">
                      <span className="category-icon">
                        <Icon name="checklist" />
                      </span>
                      <div>
                        <h3>Remaining runtime support</h3>
                        <p className="muted panel-note">
                          Work beyond the managed run preview. Offline review alone does not
                          establish runtime compatibility.
                        </p>
                      </div>
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
              <TechnicalDisclosure
                className="panel snapshot-details"
                title="Source snapshot identity"
              >
                <p className="muted">
                  This digest covers captured runtime source and reviewed manifests. It does not
                  cover undiscovered project resources.
                </p>
                <code className="digest">{plan.sourceDigest}</code>
                <p className="muted">
                  Capture policy: {plan.sources.policy} · Project resources:{" "}
                  {plan.sources.resources} · Execution ready: {String(plan.executionReady)}
                </p>
              </TechnicalDisclosure>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
