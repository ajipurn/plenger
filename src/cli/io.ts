import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isErrno } from "../shared/guards.ts";

/** Where a command writes; tests substitute buffers for the process streams. */
export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
}

/** An invalid command line; exits with code 2. */
export class UsageError extends Error {}

export function processIo(): Io {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
  };
}

/** Writes `text` to `path`, creating parent directories. */
export async function writeOutput(path: string, text: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, text, "utf8");
}

/** Writes to the output file when one is given, otherwise to stdout. */
export async function emit(text: string, path: string | undefined, io: Io): Promise<void> {
  if (path) await writeOutput(path, text);
  else io.stdout(text);
}

/** A one-line description of an error for stderr. */
export function describe(error: unknown): string {
  if (isErrno(error, "ENOENT") && "path" in error) {
    return `no such file or directory: ${error.path}`;
  }
  return error instanceof Error ? error.message : String(error);
}
