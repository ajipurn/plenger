import { parseArgs } from "node:util";
import { formatSummary } from "./report/summary.ts";
import { type ScanResult, scan } from "./scan.ts";
import { VERSION } from "./version.ts";

export { VERSION };

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
