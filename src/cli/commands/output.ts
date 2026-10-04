import type { ParseArgsOptionsConfig } from "node:util";
import { FORMATS, type ReportFormat } from "../../report/format.ts";
import { UsageError } from "../io.ts";

/** `--json`, `--format` and `--output`, shared by every command that prints a result. */
export const OUTPUT_OPTIONS = {
  json: { type: "boolean" },
  format: { type: "string" },
  output: { type: "string" },
} as const satisfies ParseArgsOptionsConfig;

/** The report format of `scan`, from `--format` and the `--json` alias. */
export function reportFormat(value: string | undefined, jsonFlag: boolean): ReportFormat {
  if (value !== undefined && !(FORMATS as readonly string[]).includes(value)) {
    throw new UsageError(
      `unknown report format '${value}'; choose terminal, json, sarif or markdown`,
    );
  }
  if (jsonFlag && value !== undefined && value !== "json") {
    throw new UsageError("--json and --format disagree; choose one");
  }
  return (value as ReportFormat | undefined) ?? (jsonFlag ? "json" : "terminal");
}

/** Commands other than `scan` print text or JSON only. */
export function textFormat(
  command: string,
  value: string | undefined,
  jsonFlag: boolean,
): "terminal" | "json" {
  const format = reportFormat(value, jsonFlag);
  if (format !== "terminal" && format !== "json") {
    throw new UsageError(`${command} supports terminal or JSON output`);
  }
  return format;
}
