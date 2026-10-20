import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { formatReport, sourcePrefix } from "../../report/format.ts";
import { createReport, type FailOn, failsGate, withoutSuppressed } from "../../report/model.ts";
import { createBaseline, readBaseline, readSuppressions } from "../../report/policy.ts";
import { SEVERITIES } from "../../rules/model.ts";
import { scan } from "../../scan.ts";
import { json } from "../../shared/json.ts";
import { COMMON_OPTIONS, parseCommandArgs, requireNonemptyPaths } from "../args.ts";
import { emit, type Io, UsageError, writeOutput } from "../io.ts";
import { OUTPUT_OPTIONS, reportFormat } from "./output.ts";

const SCAN_OPTIONS = {
  ...COMMON_OPTIONS,
  ...OUTPUT_OPTIONS,
  baseline: { type: "string" },
  "write-baseline": { type: "string" },
  suppressions: { type: "string" },
  "fail-on": { type: "string" },
  all: { type: "boolean" },
  "omit-suppressed": { type: "boolean" },
  "source-root": { type: "string" },
  gitignore: { type: "boolean", default: true },
  "inline-suppressions": { type: "boolean", default: true },
} as const;

const PATH_OPTIONS = [
  "output",
  "baseline",
  "write-baseline",
  "suppressions",
  "source-root",
] as const;

/** `plenger scan [path]`: inventory, capabilities and findings with optional baseline and gate. */
export async function scanCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseCommandArgs("scan", argv, SCAN_OPTIONS, 1);
  requireNonemptyPaths(values, PATH_OPTIONS);
  const format = reportFormat(values.format, values.json === true);
  const threshold = failOn(values["fail-on"]);
  if (
    values.output &&
    values["write-baseline"] &&
    resolve(values.output) === resolve(values["write-baseline"])
  ) {
    throw new UsageError("report output and baseline output must be different files");
  }

  const sourceRoot = values["source-root"]
    ? await realpath(values["source-root"]).catch(() => {
        throw new UsageError(
          `--source-root is not an existing directory: ${values["source-root"]}`,
        );
      })
    : undefined;
  const baseline = values.baseline ? await readBaseline(values.baseline) : undefined;
  const suppressions = values.suppressions
    ? await readSuppressions(values.suppressions)
    : undefined;
  const result = await scan(positionals[0] ?? ".", { gitignore: values.gitignore });
  const reviewed = createReport(result, {
    ...(baseline ? { baseline } : {}),
    ...(suppressions ? { suppressions } : {}),
    inline: values["inline-suppressions"],
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
}

/** `plenger facts [path]`: the imports, definitions, assignments and calls as JSON. */
export async function factsCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    "facts",
    argv,
    { ...COMMON_OPTIONS, ...OUTPUT_OPTIONS, gitignore: { type: "boolean", default: true } },
    1,
  );
  requireNonemptyPaths(values, ["output"]);
  if (values.format !== undefined && values.format !== "json") {
    throw new UsageError("facts supports JSON output only");
  }
  const result = await scan(positionals[0] ?? ".", { facts: true, gitignore: values.gitignore });
  await emit(formatReport(createReport(result), "json", { color: false }), values.output, io);
  return 0;
}

function failOn(value: string | undefined): FailOn {
  if (value !== undefined && value !== "none" && !(SEVERITIES as string[]).includes(value)) {
    throw new UsageError(
      `unknown --fail-on severity '${value}'; choose critical, high, medium, low or none`,
    );
  }
  return (value as FailOn | undefined) ?? "none";
}
