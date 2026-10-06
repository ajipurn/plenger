import { discoverProject, formatDiscovery } from "../../redteam/discover.ts";
import { formatProjectPlan, planProject } from "../../redteam/plan.ts";
import { json } from "../../shared/json.ts";
import { COMMON_OPTIONS, parseCommandArgs, requireNonemptyPaths } from "../args.ts";
import { emit, type Io, UsageError } from "../io.ts";
import { OUTPUT_OPTIONS, textFormat } from "./output.ts";

export const REDTEAM_USAGE = `Usage:
  plenger redteam discover [path]  Discover llmfy target candidates offline (no execution)
  plenger redteam plan [path]      Review supported runtime preparation offline (no execution)
  plenger redteam run [path]       Run managed security tests using a saved provider
  plenger redteam compare          Compare exported fixed security campaigns
  plenger redteam login            Connect a ChatGPT subscription provider
  plenger redteam prepare [path]   Build and import a FastAPI project (FastAPI profile)

Options for discover and plan:
  --json                 Print the full result as JSON
  --format <format>      terminal or json (default: terminal)
  --output <file>        Write the result to a file instead of stdout
  --no-gitignore         Also read files the project's .gitignore files ignore
  --target <id>          Select a candidate for redteam plan

Run \`plenger redteam run --help\` or \`plenger redteam compare --help\` for their options.
`;

const OFFLINE_OPTIONS = {
  ...COMMON_OPTIONS,
  ...OUTPUT_OPTIONS,
  gitignore: { type: "boolean", default: true },
} as const;

/** `plenger redteam <discover|plan|run|compare>`. */
export async function redteamCommand(argv: string[], io: Io): Promise<number> {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "discover":
      return discover(rest, io);
    case "plan":
      return plan(rest, io);
    case "run": {
      const { redteamRunCommand } = await import("./redteam-run.ts");
      return redteamRunCommand(rest, io);
    }
    case "compare": {
      const { redteamCompareCommand } = await import("./redteam-compare.ts");
      return redteamCompareCommand(rest, io);
    }
    case "login": {
      const { redteamLoginCommand } = await import("./redteam-login.ts");
      return redteamLoginCommand(rest, io);
    }
    case "prepare": {
      const { redteamPrepareCommand } = await import("./redteam-prepare.ts");
      return redteamPrepareCommand(rest, io);
    }
    case undefined:
      throw new UsageError(
        "redteam needs a subcommand: discover, plan, run, compare, login or prepare",
      );
    default:
      throw new UsageError(`unknown redteam subcommand '${subcommand}'`);
  }
}

async function discover(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseCommandArgs("redteam discover", argv, OFFLINE_OPTIONS, 1);
  requireNonemptyPaths(values, ["output"]);
  const format = textFormat("redteam discover", values.format, values.json === true);
  const report = await discoverProject(positionals[0] ?? ".", { gitignore: values.gitignore });
  await emit(format === "json" ? json(report) : formatDiscovery(report), values.output, io);
  return 0;
}

async function plan(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    "redteam plan",
    argv,
    { ...OFFLINE_OPTIONS, target: { type: "string" } },
    1,
  );
  requireNonemptyPaths(values, ["output"]);
  if (values.target === "") throw new UsageError("--target needs a nonempty candidate id");
  const format = textFormat("redteam plan", values.format, values.json === true);
  const result = await planProject(positionals[0] ?? ".", {
    gitignore: values.gitignore,
    ...(values.target !== undefined ? { target: values.target } : {}),
  });
  await emit(format === "json" ? json(result) : formatProjectPlan(result), values.output, io);
  return 0;
}
