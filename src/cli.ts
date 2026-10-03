import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SERVE_USAGE, serveDashboard } from "./dashboard/command.ts";
import { discoverProject, formatDiscovery } from "./redteam/discover.ts";
import { formatProjectPlan, PreparationError, planProject } from "./redteam/plan.ts";
import {
  FORMATS,
  formatReport,
  json,
  type ReportFormat,
  SourceRootError,
  sourcePrefix,
} from "./report/format.ts";
import { createReport, type FailOn, failsGate, withoutSuppressed } from "./report/model.ts";
import { createBaseline, PolicyError, readBaseline, readSuppressions } from "./report/policy.ts";
import { formatRules } from "./report/rules.ts";
import { RULES } from "./rules/index.ts";
import { SEVERITIES } from "./rules/model.ts";
import { scan } from "./scan.ts";
import { VERSION } from "./version.ts";

export { VERSION };

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
}

const USAGE = `Usage:
  plenger scan [path]            Triage the agentic AI code under path (default: .): inventory, capabilities, findings
  plenger rules                  List the risk rules
  plenger serve [path]           Serve the local dashboard (default: .)
  plenger facts [path]           Print the imports, definitions, assignments and calls in path as JSON
  plenger redteam discover [path] Discover llmfy target candidates offline (no execution)
  plenger redteam plan [path]     Review Python project preparation offline (no execution)
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

Exit codes: 0 success; 1 scan or I/O error; 2 invalid arguments or policy; 3 finding gate failed.
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
    io.stdout(command === "serve" ? SERVE_USAGE : USAGE);
    return 0;
  }
  const discovery = command === "redteam";
  const planning = discovery && operands[0] === "plan";
  const known =
    command === "scan" ||
    command === "facts" ||
    command === "rules" ||
    command === "serve" ||
    discovery;
  if (
    !known ||
    operands.length > (command === "rules" ? 0 : discovery ? 2 : 1) ||
    (discovery && operands[0] !== "discover" && !planning)
  ) {
    io.stderr(
      command === undefined || known ? USAGE : `plenger: unknown command '${command}'\n\n${USAGE}`,
    );
    return 2;
  }
  if (command === "serve") {
    try {
      const unsupported = parsed.tokens.find(
        (token) => token.kind === "option" && !["port", "workspace"].includes(token.name),
      );
      if (unsupported?.kind === "option")
        throw new PolicyError(`--${unsupported.name} is not supported by serve`);
      if (operands[0] !== undefined && values.workspace !== undefined)
        throw new PolicyError("use a positional path or --workspace, not both");
      const workspace = values.workspace ?? operands[0];
      if (workspace === "") throw new PolicyError("serve needs a nonempty workspace path");
      const port = values.port === undefined ? 0 : Number(values.port);
      if (
        (values.port !== undefined && !/^\d+$/.test(values.port)) ||
        !Number.isInteger(port) ||
        port > 65535
      )
        throw new PolicyError("--port must be an integer between 0 and 65535");
      return await serveDashboard(workspace === undefined ? { port } : { port, workspace }, io);
    } catch (error) {
      io.stderr(`plenger: ${describe(error)}\n`);
      return error instanceof PolicyError ? 2 : 1;
    }
  }
  const facts = command === "facts";
  let format: ReportFormat;
  let threshold: FailOn;
  try {
    if (values.port !== undefined || values.workspace !== undefined)
      throw new PolicyError("--port and --workspace require the serve command");
    format = reportFormat(values.format, values.json === true, facts);
    threshold = failOn(values["fail-on"]);
    if (values.target !== undefined && (!planning || values.target === ""))
      throw new PolicyError("--target requires redteam plan and a nonempty candidate id");
    for (const key of [
      "output",
      "baseline",
      "write-baseline",
      "suppressions",
      "source-root",
    ] as const) {
      if (values[key] === "") throw new PolicyError(`--${key} needs a nonempty path`);
    }
    if (
      command !== "scan" &&
      [
        "baseline",
        "write-baseline",
        "suppressions",
        "fail-on",
        "all",
        "omit-suppressed",
        "source-root",
      ].some((key) => values[key as keyof typeof values] !== undefined)
    ) {
      throw new PolicyError(
        "baseline, suppression, gate, source root and --all options require the scan command",
      );
    }
    if ((command === "rules" || discovery) && format !== "terminal" && format !== "json") {
      throw new PolicyError(
        `${discovery ? `redteam ${operands[0]}` : "rules"} supports terminal or JSON output`,
      );
    }
    if (
      values.output &&
      values["write-baseline"] &&
      resolve(values.output) === resolve(values["write-baseline"])
    ) {
      throw new PolicyError("report output and baseline output must be different files");
    }
  } catch (error) {
    io.stderr(`plenger: ${describe(error)}\n`);
    return 2;
  }

  try {
    if (discovery) {
      if (planning) {
        const plan = await planProject(operands[1] ?? ".", {
          gitignore: values.gitignore,
          ...(values.target !== undefined ? { target: values.target } : {}),
        });
        await emit(format === "json" ? json(plan) : formatProjectPlan(plan), values.output, io);
        return 0;
      }
      const report = await discoverProject(operands[1] ?? ".", { gitignore: values.gitignore });
      await emit(format === "json" ? json(report) : formatDiscovery(report), values.output, io);
      return 0;
    }
    if (command === "rules") {
      await emit(
        format === "json" ? json({ rules: RULES }) : formatRules(RULES),
        values.output,
        io,
      );
      return 0;
    }
    const sourceRoot = values["source-root"]
      ? await realpath(values["source-root"]).catch(() => {
          throw new PolicyError(
            `--source-root is not an existing directory: ${values["source-root"]}`,
          );
        })
      : undefined;
    const baseline = values.baseline ? await readBaseline(values.baseline) : undefined;
    const suppressions = values.suppressions
      ? await readSuppressions(values.suppressions)
      : undefined;
    const result = await scan(operands[0] ?? ".", { facts, gitignore: values.gitignore });
    const reviewed = createReport(result, {
      ...(baseline ? { baseline } : {}),
      ...(suppressions ? { suppressions } : {}),
    });
    const report = values["omit-suppressed"] ? withoutSuppressed(reviewed) : reviewed;
    if (sourceRoot !== undefined) sourcePrefix(report, sourceRoot);
    if (values["write-baseline"]) {
      await writeOutput(values["write-baseline"], json(createBaseline(result.findings)));
    }
    await emit(
      formatReport(report, format, {
        color: !values.output && io.color,
        all: values.all === true,
        ...(sourceRoot !== undefined ? { sourceRoot } : {}),
      }),
      values.output,
      io,
    );
    if (failsGate(report, threshold)) {
      io.stderr(`plenger: new unsuppressed findings meet --fail-on ${threshold}\n`);
      return 3;
    }
    return 0;
  } catch (error) {
    io.stderr(`plenger: ${describe(error)}\n`);
    return error instanceof PolicyError ||
      error instanceof SourceRootError ||
      error instanceof PreparationError
      ? 2
      : 1;
  }
}

function reportFormat(value: string | undefined, jsonFlag: boolean, facts: boolean): ReportFormat {
  if (value !== undefined && !(FORMATS as readonly string[]).includes(value)) {
    throw new PolicyError(
      `unknown report format '${value}'; choose terminal, json, sarif or markdown`,
    );
  }
  if ((jsonFlag || facts) && value !== undefined && value !== "json") {
    throw new PolicyError("--json and facts require JSON output");
  }
  return (value as ReportFormat | undefined) ?? (jsonFlag || facts ? "json" : "terminal");
}

function failOn(value: string | undefined): FailOn {
  if (value !== undefined && value !== "none" && !(SEVERITIES as string[]).includes(value)) {
    throw new PolicyError(
      `unknown --fail-on severity '${value}'; choose critical, high, medium, low or none`,
    );
  }
  return (value as FailOn | undefined) ?? "none";
}

export async function writeOutput(path: string, text: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function emit(text: string, path: string | undefined, io: Io): Promise<void> {
  if (path) await writeOutput(path, text);
  else io.stdout(text);
}

function parseCommandLine(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    allowNegative: true,
    tokens: true,
    options: {
      json: { type: "boolean" },
      format: { type: "string" },
      output: { type: "string" },
      baseline: { type: "string" },
      "write-baseline": { type: "string" },
      suppressions: { type: "string" },
      "fail-on": { type: "string" },
      all: { type: "boolean" },
      "omit-suppressed": { type: "boolean" },
      "source-root": { type: "string" },
      gitignore: { type: "boolean", default: true },
      target: { type: "string" },
      port: { type: "string" },
      workspace: { type: "string" },
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
