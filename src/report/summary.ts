import { styleText } from "node:util";
import type { Inventory } from "../inventory/model.ts";
import { LANGUAGE_LABEL, type Language } from "../languages.ts";
import type { ScanResult, ScanSkipReason } from "../scan.ts";
import { VERSION } from "../version.ts";

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

interface Styles {
  bold: (text: string) => string;
  dim: (text: string) => string;
  warn: (text: string) => string;
}

/** The terminal summary of a scan: files, then the agent inventory. */
export function formatSummary(result: ScanResult, color: boolean): string {
  const style = (format: Parameters<typeof styleText>[0]) => (text: string) =>
    color ? styleText(format, text) : text;
  const s: Styles = { bold: style("bold"), dim: style("dim"), warn: style("yellow") };
  return `${[...fileLines(result, s), ...inventoryLines(result.inventory, s)].join("\n")}\n`;
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
    lines.push(...listed(broken.map((file) => file.path)).map((path) => `    ${s.dim(path)}`));
  }
  if (result.skipped.length > 0) {
    const counts = new Map<ScanSkipReason, number>();
    for (const { reason } of result.skipped) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    const breakdown = [...counts].map(([reason, count]) => `${SKIP_LABEL[reason]} ${count}`);
    lines.push(`  ${plural(result.skipped.length, "file")} skipped: ${breakdown.join(", ")}`);
  }
  if (result.excludedDirs.length > 0) {
    const dirs = result.excludedDirs.map(({ path, reason }) =>
      reason === "default" ? path : `${path} (${reason})`,
    );
    lines.push(`  Excluded directories: ${s.dim(listed(dirs).join(", "))}`);
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
        `${server.name ?? "unnamed"}${server.transport === null ? "" : ` (${server.transport})`}: ${plural(server.tools.length, "tool")}`,
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
  row(
    "Entry points",
    inventory.entryPoints.length,
    unique(
      inventory.entryPoints.map((entry) => `${entry.method ?? ""} ${entry.path ?? "?"}`.trim()),
    ),
  );
  if (lines.length === 2) lines.push("    No LLM, agent, tool or MCP usage found.");
  if (inventory.unrecognised.length > 0) {
    const modules = inventory.unrecognised.map(
      (entry) => `${entry.module} (${plural(entry.files.length, "file")})`,
    );
    lines.push(s.warn(`    Not understood yet: ${clip(modules.join(", "), DETAIL_WIDTH)}`));
  }
  return lines;
}

/** `openai.OpenAI().chat.completions.create` → `chat.completions.create`; `ai#generateText` → `generateText`. */
function callLabel(target: string): string {
  const afterClient = /\(\)\.(.+)$/.exec(target)?.[1];
  return (afterClient ?? shortName(target)).replace(/\(\)/g, "");
}

function shortName(target: string): string {
  return /([\w$]+)(?:\(\))?$/.exec(target)?.[1] ?? target;
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

function listed(items: string[]): string[] {
  return items.length <= LIST_LIMIT
    ? items
    : [...items.slice(0, LIST_LIMIT), `… ${items.length - LIST_LIMIT} more`];
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}
