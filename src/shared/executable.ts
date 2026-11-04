/**
 * Finding the programs plenger runs on the host by an absolute path, so that a program
 * planted in the reviewed project never runs in place of the one on PATH.
 */

import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Windows extensions that run without a shell; `.bat` and `.cmd` need one. */
const WINDOWS_EXTENSIONS = [".exe", ".com"];

/**
 * The absolute path of `name` in the PATH directories, or null. Relative and empty
 * PATH entries are skipped: they name the current directory, usually the project
 * being reviewed, and Windows also looks in the current directory before PATH when
 * a bare name is run.
 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const path = env.PATH ?? env.Path ?? "";
  const names = platform === "win32" ? WINDOWS_EXTENSIONS.map((ext) => `${name}${ext}`) : [name];
  for (const directory of path.split(delimiter)) {
    if (directory === "" || !isAbsolute(directory)) continue;
    for (const file of names) {
      const candidate = join(directory, file);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not in this directory.
      }
    }
  }
  return null;
}

/**
 * Windows PowerShell at its fixed place under the system root, never looked up on PATH
 * or in the current directory.
 */
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}
