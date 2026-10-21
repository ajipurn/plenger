import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { UsageError } from "./io.ts";

/** Options every command accepts; `--help` is handled before a command runs. */
export const COMMON_OPTIONS = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export interface ParsedCommand<T extends ParseArgsOptionsConfig> {
  values: ReturnType<typeof parseArgs<{ options: T; allowPositionals: true }>>["values"];
  positionals: string[];
}

/**
 * Parses the arguments of one command with only that command's options, so an option
 * of another command is reported as unsupported rather than silently ignored.
 */
export function parseCommandArgs<T extends ParseArgsOptionsConfig>(
  command: string,
  argv: string[],
  options: T,
): ParsedCommand<T> {
  let parsed: ReturnType<typeof parseArgs<{ options: T; allowPositionals: true }>>;
  try {
    parsed = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
      allowNegative: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unknown = /^Unknown option '([^']+)'/.exec(message);
    if (unknown) throw new UsageError(`${unknown[1]} is not supported by ${command}`);
    throw new UsageError(message.replace(/\. To specify .*$/s, ""));
  }
  if (parsed.positionals.length > 0) throw new UsageError(`${command} takes no path`);
  return parsed;
}
