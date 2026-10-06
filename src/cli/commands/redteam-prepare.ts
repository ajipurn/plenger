import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  type FastapiPreparation,
  prepareFastapiProject,
  validateSettings,
} from "../../redteam/fastapi-prepare.ts";
import { PreparationError, planProject } from "../../redteam/plan.ts";
import { errorMessage } from "../../shared/guards.ts";
import { json } from "../../shared/json.ts";
import { redact } from "../../shared/secrets.ts";
import { type Io, UsageError, writeOutput } from "../io.ts";

export const REDTEAM_PREPARE_USAGE = `Usage:
  plenger redteam prepare [path] [--target <id>] [--env NAME=value]... [--env-file <file>]
                          [--json] [--output <file>]

Prepare a FastAPI project for the FastAPI profile: build an image with the project's
declared dependencies (wheels only), start disposable MySQL and Redis services on a
private network, import the application in an isolated worker with every llmfy model
class routed to the host broker, and probe GET /. No model is contacted.

Options:
  --target <id>       Application target from redteam plan (automatic when there is one)
  --env NAME=value    An application setting the import needs; repeatable
  --env-file <file>   Settings in NAME=value lines; the project's own .env is never read
  --json              Print the preparation report as JSON
  --output <file>     Save the JSON report

Service settings (MYSQL_*, REDIS_*) are always plenger's disposable services. Standard
SDK credentials (AWS_*, OPENAI_API_KEY, ...) get placeholders unless supplied: the worker
has no route out, so no value can reach a provider. Reports list setting names only.

Exit: 0 the application imported and answered; 1 build, service or import failure;
2 the project does not use the FastAPI profile or its plan is blocked.
`;

/** `plenger redteam prepare`: the FastAPI profile's build and import stage. */
export async function redteamPrepareCommand(argv: string[], io: Io): Promise<number> {
  let values: {
    target?: string;
    env?: string[];
    "env-file"?: string;
    json?: boolean;
    output?: string;
    help?: boolean;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        target: { type: "string" },
        env: { type: "string", multiple: true },
        "env-file": { type: "string" },
        json: { type: "boolean" },
        output: { type: "string" },
      },
    }));
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
  if (values.help) {
    io.stdout(REDTEAM_PREPARE_USAGE);
    return 0;
  }
  if (positionals.length > 1) throw new UsageError("redteam prepare takes at most one path");
  if (values.target === "" || values.output === "" || values["env-file"] === "")
    throw new UsageError("--target, --output and --env-file need a value");
  const settings = await collectSettings(values.env ?? [], values["env-file"]);
  const root = positionals[0] ?? ".";
  const plan = await planProject(root, values.target ? { target: values.target } : {});
  if (!plan.fastapiProfile)
    throw new PreparationError(
      "This project does not use the FastAPI profile. Run plenger redteam plan to see the profile it prepared.",
    );
  if (plan.preparation.status !== "ready")
    throw new PreparationError(
      `Project preparation blocked: ${plan.preparation.reasons.join(", ")}`,
    );
  const report = await prepareFastapiProject(root, {
    ...(values.target ? { target: values.target } : {}),
    expectedDigest: plan.sourceDigest,
    settings,
  });
  io.stdout(redact(values.json ? json(report) : formatPreparation(report)));
  if (values.output) await writeOutput(values.output, redact(json(report)));
  return report.state === "completed" ? 0 : 1;
}

/** `NAME=value` arguments and an optional file of such lines; later entries win. */
async function collectSettings(
  pairs: string[],
  file: string | undefined,
): Promise<Record<string, string>> {
  const settings: Record<string, string> = {};
  const lines = [...pairs];
  if (file) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      throw new UsageError(`cannot read --env-file ${file}`);
    }
    if (text.length > 256 * 1024) throw new UsageError("--env-file is too large");
    lines.unshift(
      ...text
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*export\s+/, "").trim())
        .filter((line) => line && !line.startsWith("#")),
    );
  }
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new UsageError(`settings need NAME=value, got: ${line.slice(0, 40)}`);
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    settings[name] = value;
  }
  try {
    validateSettings(settings);
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
  return settings;
}

/** Terminal rendering of a preparation report. */
export function formatPreparation(report: FastapiPreparation): string {
  const lines = [
    `plenger · FastAPI profile preparation (${report.state})`,
    report.root,
    `Stage reached: ${report.stage}; source digest ${report.sourceDigest}`,
  ];
  if (report.runtime)
    lines.push(
      `Image: ${report.runtime.image} (${report.runtime.platform}); Python ${report.runtime.python || "?"}, llmfy ${report.runtime.llmfy || "?"}`,
    );
  if (report.packages.length)
    lines.push(`Packages installed: ${report.packages.length} (resolved in the build stage)`);
  for (const service of report.services)
    lines.push(
      `Service ${service.name}: ${service.host}:${service.port} ${service.ready ? "ready" : "not ready"}`,
    );
  if (report.settings.supplied.length || report.settings.placeholders.length)
    lines.push(
      `Settings: ${report.settings.supplied.length} supplied (${report.settings.supplied.join(", ") || "none"}); placeholders for ${report.settings.placeholders.join(", ") || "none"}`,
    );
  if (report.isolationChecks.length)
    lines.push(`Isolation checks passed: ${report.isolationChecks.length}`);
  if (report.adapter)
    lines.push(
      `Broker adapter: llmfy ${report.adapter.llmfy}, patched ${report.adapter.patched.length} names`,
    );
  if (report.imported)
    lines.push(
      `Imported ${report.imported.application} in ${report.imported.durationMs} ms with ${report.imported.routes.length} routes`,
    );
  if (report.probe)
    lines.push(
      `Probe ${report.probe.method} ${report.probe.path}: HTTP ${report.probe.status ?? "no response"}`,
    );
  if (report.toolEvents) lines.push(`Tool handlers observed: ${report.toolEvents}`);
  if (report.failure)
    lines.push(
      `Failure at ${report.failure.stage}: ${report.failure.error.type}: ${report.failure.error.message}`,
    );
  if (report.error && !report.failure) lines.push(`Error: ${report.error}`);
  lines.push(
    `Cleanup confirmed: ${report.cleanupConfirmed ? "yes" : "no"}; model calls: ${report.modelCalls}`,
  );
  return `${lines.join("\n")}\n`;
}
