import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { readJsonFile, writeCampaignArtifact } from "../../redteam/artifact-io.ts";
import type { CampaignReport } from "../../redteam/campaign.ts";
import { readCampaignEvidence } from "../../redteam/campaign-evidence-io.ts";
import { compareCampaigns } from "../../redteam/comparison.ts";
import { type ComparisonFormat, formatComparison } from "../../redteam/comparison-report.ts";
import { COMPARISON_MIN_EVALUABLE } from "../../redteam/constants.ts";
import { errorMessage } from "../../shared/guards.ts";
import { redact } from "../../shared/secrets.ts";
import type { Io } from "../io.ts";

export const REDTEAM_COMPARE_USAGE = `Usage:
  plenger redteam compare <before.json> <after.json> --change <description>

Compare exported campaigns under a fixed model, cases, scope and runtime.
Requires ${COMPARISON_MIN_EVALUABLE} usable trials per case in each build. Changes in source/build are
recorded; unrelated configuration changes invalidate a mitigation comparison.

Options:
  --change <text>    Describe the intended mitigation or build change (required)
  --format <format> terminal, json or markdown (default: terminal)
  --output <file>   Save comparison; input reports are never overwritten

This command makes no model calls. Rates and task completion are descriptive,
not a significance test. Existing findings still fail the after campaign's gate.
Exit: 0 eligible comparison and gate passed; 1 incomplete/incompatible comparison
or execution gate failure; 2 invalid report/arguments; 3 after finding gate failed.
`;

const EXPORT_MAX_BYTES = 64 * 1024 * 1024;
const FORMATS: ComparisonFormat[] = ["terminal", "json", "markdown"];

/** `plenger redteam compare`: an offline comparison of two exported campaigns. */
export async function redteamCompareCommand(argv: string[], io: Io): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        change: { type: "string" },
        format: { type: "string" },
        output: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      io.stdout(REDTEAM_COMPARE_USAGE);
      return 0;
    }
    if (positionals.length !== 2 || !values.change)
      throw new Error("Choose before and after campaign exports and describe --change.");
    const format = (values.format ?? "terminal") as ComparisonFormat;
    if (!FORMATS.includes(format)) throw new Error("Choose terminal, json or markdown.");
    const files = await Promise.all(positionals.map((name) => realpath(resolve(name))));
    if (values.output) {
      const destination = await realpath(resolve(values.output)).catch(() =>
        resolve(values.output as string),
      );
      if (files.includes(destination))
        throw new Error("Comparison must not overwrite an input report.");
    }
    const reports = await Promise.all(
      files.map(async (file) =>
        readCampaignEvidence(await readJsonFile(file, EXPORT_MAX_BYTES, "Campaign export")),
      ),
    );
    const comparison = compareCampaigns(
      reports[0] as CampaignReport,
      reports[1] as CampaignReport,
      values.change,
    );
    const output = formatComparison(comparison, format);
    if (values.output) {
      try {
        await writeCampaignArtifact(resolve(values.output), output);
      } catch {
        io.stderr("plenger: Could not save the comparison. Input reports were not modified.\n");
        return 1;
      }
    } else io.stdout(output);
    return comparison.afterGate.exitCode === 3
      ? 3
      : !comparison.eligible || comparison.afterGate.exitCode === 1
        ? 1
        : 0;
  } catch (error) {
    io.stderr(`plenger: ${redact(errorMessage(error) || "Invalid campaign comparison.")}\n`);
    return 2;
  }
}
