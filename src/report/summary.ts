import { styleText } from "node:util";
import type { CapabilityKind, Inventory } from "../inventory/model.ts";
import { type Finding, SEVERITIES, type Severity } from "../rules/model.ts";
import { traceGapText, UNNAMED } from "../rules/text.ts";
import type { ScanResult, ScanSkipReason } from "../scan.ts";
import { VERSION } from "../shared/runtime.ts";
import { callLabel, routeLabel, shortName } from "../shared/text.ts";
import { LANGUAGE_LABEL, type Language } from "../source/languages.ts";
import { incompleteTraces } from "./model.ts";

const SKIP_LABEL: Record<ScanSkipReason, string> = {
  declaration: "type declarations",
  minified: "minified",
  symlink: "symlinks",
  too_large: "too large",
  unreadable: "unreadable",
  binary: "binary",
  not_utf8: "not UTF-8",
  gitignored: "gitignored",
};

const LIST_LIMIT = 10;
const DETAIL_WIDTH = 100;

/** Findings shown in the terminal unless `--all` is given. */
const FINDING_LIMIT = 20;

interface Styles {
  bold: (text: string) => string;
  dim: (text: string) => string;
  warn: (text: string) => string;
  severity: Record<Severity, (text: string) => string>;
}

export interface SummaryOptions {
  color: boolean;
  /** Show every finding instead of the most urgent ones. */
  all?: boolean;
}

/** The terminal summary of a scan: files, the agent inventory, its capabilities and the findings. */
export function formatSummary(result: ScanResult, options: SummaryOptions): string {
  const style = (format: Parameters<typeof styleText>[0]) => (text: string) =>
    options.color ? styleText(format, text) : text;
  const s: Styles = {
    bold: style("bold"),
    dim: style("dim"),
    warn: style("yellow"),
    severity: {
      critical: style(["bold", "red"]),
      high: style("red"),
      medium: style("yellow"),
      low: style("dim"),
    },
  };
  const lines = [
    ...fileLines(result, s),
    ...inventoryLines(result.inventory, s),
    ...capabilityLines(result.inventory, s),
    ...findingLines(result.findings, s, options.all === true),
  ];
  return `${lines.join("\n")}\n`;
}

function findingLines(findings: Finding[], s: Styles, all: boolean): string[] {
  const counts = SEVERITIES.map((severity) => ({
    severity,
    count: findings.filter((finding) => finding.severity === severity).length,
  })).filter((entry) => entry.count > 0);
  const tally = counts.map(({ severity, count }) => s.severity[severity](`${count} ${severity}`));
  const lines = [
    "",
    `  ${s.bold("Findings")}${tally.length > 0 ? `  ${tally.join(s.dim(" · "))}` : ""}`,
  ];
  if (findings.length === 0) {
    lines.push(
      "    No risks detected by plenger's rules. This is not proof that there are none.",
    );
    return lines;
  }
  const shown = all ? findings : findings.slice(0, FINDING_LIMIT);
  for (const finding of shown) {
    const label = s.severity[finding.severity](finding.severity.toUpperCase().padEnd(8));
    lines.push("", `    ${label} ${String(finding.score).padStart(3)}  ${finding.title}`);
    const where = `${finding.location.path}:${finding.location.line}`;
    const rating = `${finding.rule} · ${finding.confidence} confidence${finding.exposed ? " · exposed" : ""}`;
    lines.push(`                  ${where}  ${s.dim(rating)}`);
    if (finding.snippet !== undefined)
      lines.push(`                  ${s.dim(`│ ${finding.snippet}`)}`);
  }
  if (shown.length < findings.length) {
    lines.push(
      "",
      s.dim(
        `    … ${plural(findings.length - shown.length, "more finding")}; use --all to list them, or --json for the evidence of each`,
      ),
    );
  }
  return lines;
}

function fileLines(result: ScanResult, s: Styles): string[] {
  const lines = [`${s.bold(`plenger ${VERSION}`)} ${s.dim("·")} ${result.root}`, ""];
  const perLanguage = new Map<Language, { files: number; lines: number }>();
  for (const file of result.files) {
    const entry = perLanguage.get(file.language) ?? { files: 0, lines: 0 };
    entry.files++;
    entry.lines += file.lines;
    perLanguage.set(file.language, entry);
  }
  for (const [language, entry] of [...perLanguage].sort((a, b) => b[1].files - a[1].files)) {
    lines.push(
      `  ${LANGUAGE_LABEL[language].padEnd(12)}${plural(entry.files, "file").padStart(12)}  ${s.dim(plural(entry.lines, "line"))}`,
    );
  }
  if (perLanguage.size === 0) lines.push("  No Python, JavaScript or TypeScript files found.");
  lines.push(
    "",
    `  ${plural(result.files.length, "file")} parsed in ${(result.durationMs / 1000).toFixed(1)}s`,
  );

  if (result.truncated) {
    lines.push(s.warn("  Stopped at the file limit; the rest of the project was not scanned."));
  }
  const broken = result.files.filter((file) => file.syntaxErrors);
  if (broken.length > 0) {
    lines.push(
      s.warn(`  ${plural(broken.length, "file")} with syntax errors; results may be partial:`),
    );
    lines.push(
      ...truncatedList(broken.map((file) => file.path)).map((path) => `    ${s.dim(path)}`),
    );
  }
  const traces = incompleteTraces(result.inventory);
  if (traces.length > 0) {
    lines.push(
      s.warn(
        `  ${plural(traces.length, "handler")} traced incompletely; effects behind these calls were not seen:`,
      ),
    );
    lines.push(
      ...truncatedList(
        traces.map(
          ({ name, location, trace }) =>
            `${name} (${location.path}:${location.line}): ${traceGapText(trace)}`,
        ),
      ).map((line) => `    ${s.dim(line)}`),
    );
  }
  if (result.skipped.length > 0) {
    const counts = new Map<ScanSkipReason, number>();
    for (const { reason } of result.skipped) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    const breakdown = [...counts].map(([reason, count]) => `${SKIP_LABEL[reason]} ${count}`);
    lines.push(`  ${plural(result.skipped.length, "file")} skipped: ${breakdown.join(", ")}`);
  }
  const binaries = result.binaries ?? [];
  if (binaries.length > 0) {
    lines.push(
      `  ${plural(binaries.length, "binary file")} not analysed: ${counted(binaries.map((file) => file.kind)).join(", ")}`,
    );
    lines.push(
      ...truncatedList(binaries.map((file) => `${file.path} (${file.kind})`)).map(
        (line) => `    ${s.dim(line)}`,
      ),
    );
  }
  if (result.excludedDirs.length > 0) {
    const dirs = result.excludedDirs.map(({ path, reason }) =>
      reason === "default" ? path : `${path} (${reason})`,
    );
    lines.push(`  Excluded directories: ${s.dim(truncatedList(dirs).join(", "))}`);
  }
  return lines;
}

function inventoryLines(inventory: Inventory, s: Styles): string[] {
  const lines = ["", `  ${s.bold("Agent inventory")}`];
  const row = (label: string, count: number, details: string[]) => {
    if (count === 0) return;
    const detail = clip(details.join(", "), DETAIL_WIDTH);
    lines.push(`    ${label.padEnd(14)}${String(count).padStart(5)}  ${s.dim(detail)}`);
  };
  const frameworkName = new Map(
    inventory.frameworks.map((framework) => [framework.id, framework.name]),
  );

  if (inventory.frameworks.length > 0) {
    const names = inventory.frameworks.map(
      (framework) =>
        `${framework.name}${framework.files.length > 1 ? ` (${framework.files.length} files)` : ""}`,
    );
    lines.push(`    ${"Frameworks".padEnd(14)}       ${clip(names.join(", "), DETAIL_WIDTH)}`);
  }
  row(
    "Models",
    inventory.models.length,
    counted(
      inventory.models.map(
        (model) => model.model ?? `${frameworkName.get(model.framework) ?? model.framework} client`,
      ),
    ),
  );
  row(
    "LLM calls",
    inventory.llmCalls.length,
    counted(
      inventory.llmCalls.map(
        (call) =>
          `${frameworkName.get(call.framework) ?? call.framework} ${callLabel(call.target)}`,
      ),
    ),
  );
  row(
    "Agents",
    inventory.agents.length,
    counted(inventory.agents.map((agent) => agent.name ?? shortName(agent.target))),
  );
  row("Tools", inventory.tools.length, unique(inventory.tools.map((tool) => tool.name)));
  row(
    "MCP servers",
    inventory.mcpServers.length,
    inventory.mcpServers.map(
      (server) =>
        `${server.name ?? UNNAMED}${server.transport === null ? "" : ` (${server.transport})`}: ${plural(server.tools.length, "tool")}`,
    ),
  );
  row(
    "MCP clients",
    inventory.mcpClients.length,
    unique(
      inventory.mcpClients.map(
        (client) => client.command ?? client.url ?? shortName(client.target),
      ),
    ),
  );
  const dynamic = inventory.prompts.filter((prompt) => prompt.dynamic.length > 0).length;
  const templated = inventory.prompts.filter((prompt) => prompt.variables.length > 0).length;
  row("Prompts", inventory.prompts.length, [
    `${dynamic} with dynamic parts`,
    `${templated} with template variables`,
  ]);
  row(
    "Data stores",
    inventory.dataStores.length,
    counted(inventory.dataStores.map((store) => store.kind.replace("_", " "))),
  );
  row("Entry points", inventory.entryPoints.length, unique(inventory.entryPoints.map(routeLabel)));
  if (lines.length === 2) lines.push("    No LLM, agent, tool or MCP usage found.");
  if (inventory.unrecognised.length > 0) {
    const modules = inventory.unrecognised.map(
      (entry) => `${entry.module} (${plural(entry.files.length, "file")})`,
    );
    lines.push(s.warn(`    Not understood yet: ${clip(modules.join(", "), DETAIL_WIDTH)}`));
  }
  return lines;
}

/** Verb phrases for the terminal summary; rules/text.ts `ACTION_PHRASE` words `network` and `database` differently for finding titles. */
const CAPABILITY_LABEL: Record<CapabilityKind, string> = {
  process: "run commands",
  code: "execute code",
  file_write: "write files",
  file_delete: "delete files",
  file_read: "read files",
  network: "use the network",
  database: "use databases",
  message: "send messages",
  payment: "make payments",
  secret: "read secrets",
  deserialize: "load unsafe data",
  browser: "drive a browser",
  mcp: "use MCP servers",
  agent: "run other agents",
  llm: "call models",
};

/** Ordered roughly by how much damage a misused tool can do. */
const CAPABILITY_ORDER: CapabilityKind[] = [
  "process",
  "code",
  "file_delete",
  "file_write",
  "payment",
  "message",
  "database",
  "deserialize",
  "browser",
  "network",
  "file_read",
  "secret",
  "mcp",
  "agent",
  "llm",
];

function capabilityLines(inventory: Inventory, s: Styles): string[] {
  const lines = ["", `  ${s.bold("Capabilities")}`];
  const agentName = new Map(
    inventory.agents.map((agent) => [agent.id, agent.name ?? shortName(agent.target)]),
  );
  for (const kind of CAPABILITY_ORDER) {
    const tools = inventory.tools.filter((tool) =>
      tool.capabilities.some((item) => item.kind === kind),
    );
    if (tools.length === 0) continue;
    const detail = clip(unique(tools.map((tool) => tool.name)).join(", "), DETAIL_WIDTH);
    lines.push(
      `    ${`Tools that ${CAPABILITY_LABEL[kind]}`.padEnd(34)}${String(tools.length).padStart(4)}  ${s.dim(detail)}`,
    );
  }
  const coding = inventory.agents.filter((agent) =>
    agent.capabilities.some((item) => item.kind === "code" && item.tool === undefined),
  );
  if (coding.length > 0) {
    lines.push(
      `    ${"Agents that execute code".padEnd(34)}${String(coding.length).padStart(4)}  ${s.dim(clip(coding.map((agent) => agentName.get(agent.id) ?? agent.id).join(", "), DETAIL_WIDTH))}`,
    );
  }
  const reaching = inventory.entryPoints.filter((entry) =>
    entry.reaches.some((item) => item.kind === "agent" || item.kind === "llm"),
  );
  if (reaching.length > 0) {
    lines.push(
      `    ${"Entry points reaching a model".padEnd(34)}${String(reaching.length).padStart(4)}`,
    );
    for (const entry of reaching.slice(0, LIST_LIMIT)) {
      const targets = entry.reaches
        .filter((item) => item.kind === "agent" || item.kind === "llm")
        .map((item) =>
          item.kind === "agent"
            ? `agent ${agentName.get(item.target) ?? item.target}`
            : callLabel(item.target),
        );
      lines.push(
        `      ${routeLabel(entry)} ${s.dim(`→ ${clip(unique(targets).join(", "), DETAIL_WIDTH)}`)}`,
      );
    }
    if (reaching.length > LIST_LIMIT)
      lines.push(s.dim(`      … ${reaching.length - LIST_LIMIT} more`));
  }
  if (lines.length === 2) lines.push("    No tool or entry point with an outside effect found.");
  return lines;
}

function counted(items: string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([item, count]) => (count > 1 ? `${item} ×${count}` : item));
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/** The first `LIST_LIMIT` items, with a count of the rest. */
function truncatedList(items: string[]): string[] {
  return items.length <= LIST_LIMIT
    ? items
    : [...items.slice(0, LIST_LIMIT), `… ${items.length - LIST_LIMIT} more`];
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}
