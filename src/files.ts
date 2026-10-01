import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { classifyPath, type Grammar, type IgnoredSourceReason } from "./languages.ts";

/** Directories that hold dependencies, build output or tool caches rather than project code. */
export const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  ".plenger",
  "node_modules",
  "bower_components",
  "jspm_packages",
  ".pnpm-store",
  ".yarn",
  ".venv",
  "venv",
  "__pycache__",
  "site-packages",
  ".eggs",
  ".tox",
  ".nox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".turbo",
  ".vercel",
  ".cache",
  "coverage",
  "vendor",
]);

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_FILES = 50_000;

export interface SourceFile {
  /** Path relative to the scan root, always with forward slashes. */
  path: string;
  absolutePath: string;
  grammar: Grammar;
  bytes: number;
}

export type SkipReason = IgnoredSourceReason | "symlink" | "too_large" | "unreadable";

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface CollectOptions {
  maxFileBytes?: number;
  maxFiles?: number;
}

export interface CollectResult {
  /** The scan root with symlinks resolved. */
  root: string;
  files: SourceFile[];
  skipped: SkippedFile[];
  /** Directories left out because they are dependencies, build output or virtualenvs. */
  excludedDirs: string[];
  /** True when the walk stopped at `maxFiles`. */
  truncated: boolean;
}

/**
 * Lists the Python, JavaScript and TypeScript files under `root` without following
 * symlinks or reading file contents. Results are sorted by path.
 */
export async function collectSourceFiles(
  root: string,
  options: CollectOptions = {},
): Promise<CollectResult> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const absoluteRoot = await realpath(root);
  if (!(await stat(absoluteRoot)).isDirectory()) {
    throw new Error(`not a directory: ${root}`);
  }

  const result: CollectResult = {
    root: absoluteRoot,
    files: [],
    skipped: [],
    excludedDirs: [],
    truncated: false,
  };
  const pending = [""];

  walk: while (pending.length > 0) {
    const dir = pending.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(join(absoluteRoot, dir), { withFileTypes: true });
    } catch {
      result.skipped.push({ path: dir, reason: "unreadable" });
      continue;
    }
    if (dir !== "" && entries.some((entry) => entry.name === "pyvenv.cfg" && entry.isFile())) {
      result.excludedDirs.push(dir);
      continue;
    }

    for (const entry of entries) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        result.skipped.push({ path, reason: "symlink" });
      } else if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) result.excludedDirs.push(path);
        else pending.push(path);
      } else if (entry.isFile()) {
        const classification = classifyPath(entry.name);
        if (classification.kind === "ignored") {
          result.skipped.push({ path, reason: classification.reason });
        } else if (classification.kind === "source") {
          if (result.files.length >= maxFiles) {
            result.truncated = true;
            break walk;
          }
          const absolutePath = join(absoluteRoot, path);
          let bytes: number;
          try {
            bytes = (await lstat(absolutePath)).size;
          } catch {
            result.skipped.push({ path, reason: "unreadable" });
            continue;
          }
          if (bytes > maxFileBytes) result.skipped.push({ path, reason: "too_large" });
          else result.files.push({ path, absolutePath, grammar: classification.grammar, bytes });
        }
      }
    }
  }

  result.files.sort((a, b) => comparePaths(a.path, b.path));
  result.skipped.sort((a, b) => comparePaths(a.path, b.path));
  result.excludedDirs.sort(comparePaths);
  return result;
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
