import { readFileSync } from "node:fs";
import { parseArgs, styleText } from "node:util";
import { LANGUAGE_LABEL, type Language } from "./languages.ts";
import { type ScanResult, type ScanSkipReason, scan } from "./scan.ts";

export const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
}

const USAGE = `Usage:
  plenger scan [path] [--json]   Parse the Python, JavaScript and TypeScript files under path (default: .)
  plenger facts [path]           Print the imports, definitions, assignments and calls in path as JSON
  plenger --version
  plenger --help

Options:
  --no-gitignore                 Also scan files the project's .gitignore files ignore
`;

export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    io.stderr(`plenger: ${describe(error)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  const [command, ...operands] = positionals;
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  const known = command === "scan" || command === "facts";
  if (!known || operands.length > 1) {
    io.stderr(
      command === undefined || known ? USAGE : `plenger: unknown command '${command}'\n\n${USAGE}`,
    );
    return 2;
  }

  const facts = command === "facts";
  let result: ScanResult;
  try {
    result = await scan(operands[0] ?? ".", { facts, gitignore: values.gitignore });
  } catch (error) {
    io.stderr(`plenger: ${describe(error)}\n`);
    return 1;
  }
  io.stdout(values.json || facts ? toJson(result) : formatSummary(result, io.color));
  return 0;
}

/** The JSON shape is unstable until milestone M5; `schemaVersion` 0 says so. */
function toJson(result: ScanResult): string {
  const document = { schemaVersion: 0, tool: { name: "plenger", version: VERSION }, ...result };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function parseCommandLine(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    allowNegative: true,
    options: {
      json: { type: "boolean" },
      gitignore: { type: "boolean", default: true },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

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

export function formatSummary(result: ScanResult, color: boolean): string {
  const bold = (text: string) => (color ? styleText("bold", text) : text);
  const dim = (text: string) => (color ? styleText("dim", text) : text);
  const warn = (text: string) => (color ? styleText("yellow", text) : text);
  const lines = [`${bold(`plenger ${VERSION}`)} ${dim("·")} ${result.root}`, ""];

  const perLanguage = new Map<Language, { files: number; lines: number }>();
  for (const file of result.files) {
    const entry = perLanguage.get(file.language) ?? { files: 0, lines: 0 };
    entry.files++;
    entry.lines += file.lines;
    perLanguage.set(file.language, entry);
  }
  for (const [language, entry] of [...perLanguage].sort((a, b) => b[1].files - a[1].files)) {
    lines.push(
      `  ${LANGUAGE_LABEL[language].padEnd(12)}${plural(entry.files, "file").padStart(12)}  ${dim(plural(entry.lines, "line"))}`,
    );
  }
  if (perLanguage.size === 0) lines.push("  No Python, JavaScript or TypeScript files found.");
  lines.push(
    "",
    `  ${plural(result.files.length, "file")} parsed in ${(result.durationMs / 1000).toFixed(1)}s`,
  );

  if (result.truncated) {
    lines.push(warn("  Stopped at the file limit; the rest of the project was not scanned."));
  }
  const broken = result.files.filter((file) => file.syntaxErrors);
  if (broken.length > 0) {
    lines.push(
      warn(`  ${plural(broken.length, "file")} with syntax errors; results may be partial:`),
    );
    lines.push(...listed(broken.map((file) => file.path)).map((path) => `    ${dim(path)}`));
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
    lines.push(`  Excluded directories: ${dim(listed(dirs).join(", "))}`);
  }
  return `${lines.join("\n")}\n`;
}

function listed(items: string[]): string[] {
  return items.length <= LIST_LIMIT
    ? items
    : [...items.slice(0, LIST_LIMIT), `… ${items.length - LIST_LIMIT} more`];
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

function describe(error: unknown): string {
  if (error instanceof Error && "code" in error && error.code === "ENOENT" && "path" in error) {
    return `no such file or directory: ${error.path}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function processIo(): Io {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
  };
}
