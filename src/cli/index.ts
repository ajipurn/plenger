import { PreparationError } from "../redteam/plan.ts";
import { SourceRootError } from "../report/format.ts";
import { PolicyError } from "../report/policy.ts";
import { VERSION } from "../shared/runtime.ts";
import { REDTEAM_USAGE, redteamCommand } from "./commands/redteam.ts";
import { rulesCommand } from "./commands/rules.ts";
import { factsCommand, scanCommand } from "./commands/scan.ts";
import { SERVE_USAGE, serveCommand } from "./commands/serve.ts";
import { describe, type Io, processIo, UsageError } from "./io.ts";

export type { Io };
export { VERSION };

export const USAGE = `Usage:
  plenger scan [path]            Triage the agentic AI code under path (default: .): inventory, capabilities, findings
  plenger rules                  List the risk rules
  plenger serve [path]           Serve the local dashboard (default: .)
  plenger facts [path]           Print the imports, definitions, assignments and calls in path as JSON
  plenger redteam discover [path] Discover llmfy target candidates offline (no execution)
  plenger redteam plan [path]     Review supported runtime preparation offline (no execution)
  plenger redteam run [path]      Run managed security tests using a saved provider
  plenger redteam compare        Compare exported fixed security campaigns
  plenger --version
  plenger --help

Options:
  --json                         Print the full result (or the rule list) as JSON
  --format <format>              terminal, json, sarif or markdown (default: terminal)
  --output <file>                Write the report to a file instead of stdout
  --baseline <file>              Compare findings with a version 1 baseline
  --write-baseline <file>        Write a baseline of every detected finding
  --suppressions <file>          Apply a version 1 suppression file
  --omit-suppressed              Leave suppressed findings out of the report (they are still counted)
  --source-root <dir>            Make SARIF and Markdown paths relative to dir, such as the
                                repository root, instead of the scanned path
  --fail-on <severity>           Fail on new, unsuppressed findings at or above critical,
                                high, medium or low (default: none)
  --all                          List every finding, not only the most urgent
  --no-gitignore                 Also scan files the project's .gitignore files ignore
  --target <id>                  Select a candidate for redteam plan
  --port <0-65535>               Dashboard port; 0 chooses a free port (default: 0)
  --workspace <dir>              Dashboard project folder instead of a positional path
  --data-dir <dir>               Dashboard SQLite storage folder (default: local application data)

Each command accepts only its own options; \`plenger <command> --help\` shows them.
Exit codes: 0 success; 1 scan or I/O error; 2 invalid arguments or policy; 3 finding gate failed.
`;

interface Command {
  run: (argv: string[], io: Io) => Promise<number>;
  usage: string;
}

const COMMANDS: Record<string, Command> = {
  scan: { run: scanCommand, usage: USAGE },
  facts: { run: factsCommand, usage: USAGE },
  rules: { run: rulesCommand, usage: USAGE },
  serve: { run: serveCommand, usage: SERVE_USAGE },
  redteam: { run: redteamCommand, usage: REDTEAM_USAGE },
};

/** Runs the command line and returns the process exit code. */
export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  const [name, ...rest] = argv;
  if (name === "--version" || name === "-v") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (name === undefined || name === "--help" || name === "-h") {
    if (name === undefined) {
      io.stderr(USAGE);
      return 2;
    }
    io.stdout(USAGE);
    return 0;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    io.stderr(`plenger: unknown command '${name}'\n\n${USAGE}`);
    return 2;
  }
  const early = earlyOption(rest);
  if (early === "version") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (early === "help") {
    io.stdout(name === "redteam" && rest[0] === "run" ? await runUsage() : command.usage);
    return 0;
  }
  try {
    return await command.run(rest, io);
  } catch (error) {
    io.stderr(
      `plenger: ${describe(error)}${error instanceof UsageError ? `\n\n${command.usage}` : "\n"}`,
    );
    return exitCode(error);
  }
}

/** Options that end the command line early, wherever they appear before `--`. */
function earlyOption(argv: string[]): "help" | "version" | undefined {
  for (const argument of argv) {
    if (argument === "--") return undefined;
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--version" || argument === "-v") return "version";
  }
  return undefined;
}

async function runUsage(): Promise<string> {
  const { REDTEAM_RUN_USAGE } = await import("./commands/redteam-run.ts");
  return REDTEAM_RUN_USAGE;
}

/** 2 for anything the user can fix on the command line or in a policy file, 1 otherwise. */
function exitCode(error: unknown): number {
  return error instanceof UsageError ||
    error instanceof PolicyError ||
    error instanceof SourceRootError ||
    error instanceof PreparationError
    ? 2
    : 1;
}
