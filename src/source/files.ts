import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import ignore, { type Ignore } from "ignore";
import { compareStrings } from "../shared/compare.ts";
import {
  classifyPath,
  type Grammar,
  type IgnoredSourceReason,
  type TextKind,
  textKindOf,
} from "./languages.ts";

/** Directories that hold dependencies, build output or tool caches rather than project code. */
const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
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
const DEFAULT_MAX_FILES = 50_000;

interface SourceFile {
  /** Path relative to the scan root, always with forward slashes. */
  path: string;
  absolutePath: string;
  grammar: Grammar;
  bytes: number;
}

export type SkipReason =
  | IgnoredSourceReason
  | "gitignored"
  | "symlink"
  | "too_large"
  | "unreadable";

interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface CollectOptions {
  maxFileBytes?: number;
  maxFiles?: number;
  /** Leave out what the project's `.gitignore` files ignore (default true). */
  gitignore?: boolean;
  /**
   * Lowercase extensions (`.md`) of non-source files to list in `resources`, under the
   * same ignore, symlink and size rules. Nothing is listed when absent.
   */
  resources?: readonly string[];
  /** Also list text files without a parser in `texts`, under the same rules. */
  texts?: boolean;
}

/** A non-source file a runtime profile may capture beside the code (prompts, templates). */
export interface ResourceFile {
  path: string;
  absolutePath: string;
  bytes: number;
}

/** A text file in another language, a template or configuration, for the AI review. */
export interface TextFile {
  path: string;
  absolutePath: string;
  kind: TextKind;
  bytes: number;
}

export interface ExcludedDir {
  path: string;
  /** `default`: dependencies, build output, caches or VCS data, by directory name. */
  reason: "default" | "virtualenv" | "gitignore";
}

interface CollectResult {
  /** The scan root with symlinks resolved. */
  root: string;
  files: SourceFile[];
  /** Files matching `options.resources`, sorted by path; empty unless asked for. */
  resources: ResourceFile[];
  /** Text files without a parser, sorted by path; empty unless `options.texts`. */
  texts: TextFile[];
  skipped: SkippedFile[];
  /** Directories not walked into, and why. */
  excludedDirs: ExcludedDir[];
  /** True when the walk stopped at `maxFiles`. */
  truncated: boolean;
}

/**
 * Lists the Python, JavaScript and TypeScript files under `root`, and with `texts` the
 * text files without a parser, without following symlinks or reading file contents.
 * Results are sorted by path. When `root` is a
 * file, the result holds just that file, relative to its directory.
 */
export async function collectSourceFiles(
  root: string,
  options: CollectOptions = {},
): Promise<CollectResult> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const absoluteRoot = await realpath(root);
  const rootStat = await stat(absoluteRoot);
  if (rootStat.isFile()) return collectSingleFile(absoluteRoot, rootStat.size, maxFileBytes);
  if (!rootStat.isDirectory()) throw new Error(`not a file or directory: ${root}`);

  const result: CollectResult = {
    root: absoluteRoot,
    files: [],
    resources: [],
    texts: [],
    skipped: [],
    excludedDirs: [],
    truncated: false,
  };
  const resourceExtensions = new Set(options.resources ?? []);
  const pending: { dir: string; rules: GitignoreRules[] }[] = [{ dir: "", rules: [] }];

  walk: while (pending.length > 0) {
    const { dir, rules: inherited } = pending.pop() as (typeof pending)[number];
    let entries: Dirent[];
    try {
      entries = await readdir(join(absoluteRoot, dir), { withFileTypes: true });
    } catch {
      result.skipped.push({ path: dir, reason: "unreadable" });
      continue;
    }
    if (dir !== "" && entries.some((entry) => entry.name === "pyvenv.cfg" && entry.isFile())) {
      result.excludedDirs.push({ path: dir, reason: "virtualenv" });
      continue;
    }
    const rules =
      options.gitignore !== false &&
      entries.some((entry) => entry.name === ".gitignore" && entry.isFile())
        ? [...inherited, ...(await readGitignore(absoluteRoot, dir))]
        : inherited;

    for (const entry of entries) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (isGitignored(rules, path, entry.isDirectory())) {
        if (entry.isDirectory()) result.excludedDirs.push({ path, reason: "gitignore" });
        else if (classifyPath(entry.name).kind !== "other") {
          result.skipped.push({ path, reason: "gitignored" });
        }
      } else if (entry.isSymbolicLink()) {
        result.skipped.push({ path, reason: "symlink" });
      } else if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name))
          result.excludedDirs.push({ path, reason: "default" });
        else pending.push({ dir: path, rules });
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
        } else {
          const resource = resourceExtensions.has(extensionOf(entry.name));
          const kind = options.texts ? textKindOf(entry.name) : null;
          if (!resource && kind === null) continue;
          if (result.files.length + result.resources.length + result.texts.length >= maxFiles) {
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
          else if (resource) result.resources.push({ path, absolutePath, bytes });
          else if (kind !== null) result.texts.push({ path, absolutePath, kind, bytes });
        }
      }
    }
  }

  result.files.sort((a, b) => compareStrings(a.path, b.path));
  result.resources.sort((a, b) => compareStrings(a.path, b.path));
  result.texts.sort((a, b) => compareStrings(a.path, b.path));
  result.skipped.sort((a, b) => compareStrings(a.path, b.path));
  result.excludedDirs.sort((a, b) => compareStrings(a.path, b.path));
  return result;
}

/** The rules from one `.gitignore`, which apply to paths below `base`. */
interface GitignoreRules {
  base: string;
  matcher: Ignore;
}

const MAX_GITIGNORE_BYTES = 256 * 1024;

async function readGitignore(root: string, dir: string): Promise<GitignoreRules[]> {
  try {
    const path = join(root, dir, ".gitignore");
    if ((await lstat(path)).size > MAX_GITIGNORE_BYTES) return [];
    return [{ base: dir, matcher: ignore().add(await readFile(path, "utf8")) }];
  } catch {
    return [];
  }
}

/**
 * Whether any `.gitignore` above `path` ignores it. Unlike git, a negation in a
 * nested file cannot re-include what a parent file ignores.
 */
function isGitignored(rules: GitignoreRules[], path: string, isDirectory: boolean): boolean {
  for (const { base, matcher } of rules) {
    const relative = base === "" ? path : path.slice(base.length + 1);
    if (matcher.ignores(isDirectory ? `${relative}/` : relative)) return true;
  }
  return false;
}

/** `.md` for `notes.md`; the empty string for a name without an extension. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function collectSingleFile(
  absolutePath: string,
  bytes: number,
  maxFileBytes: number,
): CollectResult {
  const path = basename(absolutePath);
  const result: CollectResult = {
    root: dirname(absolutePath),
    files: [],
    resources: [],
    texts: [],
    skipped: [],
    excludedDirs: [],
    truncated: false,
  };
  const classification = classifyPath(path);
  if (classification.kind === "other")
    throw new Error(`not a Python, JavaScript or TypeScript file: ${path}`);
  if (classification.kind === "ignored")
    result.skipped.push({ path, reason: classification.reason });
  else if (bytes > maxFileBytes) result.skipped.push({ path, reason: "too_large" });
  else result.files.push({ path, absolutePath, grammar: classification.grammar, bytes });
  return result;
}
