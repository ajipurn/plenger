import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { ProjectFileError, readProjectFile } from "../redteam/project-files.ts";
import { readGit } from "./git.ts";

/** A review scoped to the changes since a base commit. */
export interface ChangeScope {
  /** The ref the user gave, and the commit it resolved to. */
  base: string;
  commit: string;
  /** Reviewable files that differ from the base or are new, with their changed lines. */
  files: { path: string; added: boolean; ranges: { line: number; endLine: number }[] }[];
  /** Files of the base with a reviewable kind of name that are gone. */
  removed: string[];
}

export class ChangeScopeError extends Error {}

export const CHANGE_LIMITS = {
  /** Larger files are not compared; the review would not read them either. */
  fileBytes: 1024 * 1024,
  /** Edits past this count mark the whole file as changed. */
  edits: 2000,
  removed: 50,
  treeBytes: 64 * 1024 * 1024,
} as const;

/** A branch, tag or commit name: no leading dash, no spaces, no revision ranges. */
const REF = /^(?!-)[\w./@^~{}-]{1,200}$/;
export function isRefName(ref: string): boolean {
  return REF.test(ref) && !ref.includes("..");
}

/**
 * What changed in the files the review may read since `ref`. The base comes from Git
 * objects; the current text from the files on disk, compared in this process. Git never
 * reads the working tree, so the project's filter and diff drivers never run.
 */
export async function changesSince(
  root: string,
  ref: string,
  paths: readonly string[],
): Promise<ChangeScope> {
  if (!isRefName(ref))
    throw new ChangeScopeError("Name a branch, tag or commit of this project's Git repository.");
  const text = async (args: string[], maxBuffer?: number) =>
    (await readGit(root, args, maxBuffer ? { maxBuffer, timeout: 20_000 } : {}))
      .toString("utf8")
      .trim();
  let commit: string;
  let prefix: string;
  try {
    commit = await text(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    prefix = await text(["rev-parse", "--show-prefix"]);
  } catch {
    throw new ChangeScopeError(`${ref} is not a commit of this project's Git repository.`);
  }
  if (!/^[a-f0-9]{40,64}$/.test(commit))
    throw new ChangeScopeError(`${ref} is not a commit of this project's Git repository.`);
  // Blob ids of the base, for the files under the scanned folder.
  const tree = new Map<string, string>();
  const listing = await readGit(root, ["ls-tree", "-r", "-z", "--full-tree", commit], {
    maxBuffer: CHANGE_LIMITS.treeBytes,
    timeout: 20_000,
  });
  for (const entry of listing.toString("utf8").split("\0")) {
    const match = /^\d{6} blob ([a-f0-9]{40,64})\t(.+)$/s.exec(entry);
    if (!match?.[2]?.startsWith(prefix)) continue;
    tree.set(match[2].slice(prefix.length), match[1] as string);
  }
  const real = await realpath(root);
  const files: ChangeScope["files"] = [];
  for (const path of paths) {
    let current: Buffer;
    try {
      current = await readProjectFile(real, path, CHANGE_LIMITS.fileBytes);
    } catch (error) {
      if (error instanceof ProjectFileError) continue;
      throw error;
    }
    const blob = tree.get(path);
    const lines = splitLines(current);
    if (blob === undefined) {
      files.push({
        path,
        added: true,
        ranges: lines.length ? [{ line: 1, endLine: lines.length }] : [],
      });
      continue;
    }
    if (blobId(current, blob.length === 64 ? "sha256" : "sha1") === blob) continue;
    const base = await readGit(root, ["cat-file", "blob", blob], {
      maxBuffer: CHANGE_LIMITS.fileBytes * 2,
      timeout: 20_000,
    });
    files.push({ path, added: false, ranges: changedLines(splitLines(base), lines) });
  }
  const present = new Set(paths);
  const kinds = new Set(paths.map(extension));
  const removed = [...tree.keys()]
    .filter((path) => !present.has(path) && kinds.has(extension(path)))
    .sort()
    .slice(0, CHANGE_LIMITS.removed);
  // Removed files that still exist on disk but the review skips are not removed.
  const gone: string[] = [];
  for (const path of removed)
    try {
      await readProjectFile(real, path, 1);
    } catch (error) {
      if (error instanceof ProjectFileError && error.reason !== "too-large") gone.push(path);
    }
  return { base: ref, commit, files, removed: gone };
}

function blobId(content: Buffer, algorithm: "sha1" | "sha256"): string {
  return createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest("hex");
}

function splitLines(content: Buffer): string[] {
  const text = content.toString("utf8");
  if (!text) return [];
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : name;
}

/**
 * The lines of `after` that differ from `before`, as inclusive ranges: inserted or edited
 * lines, and for a deletion the line that now stands where the deleted lines were. A
 * Myers diff; past `CHANGE_LIMITS.edits` the changed middle is one range.
 */
export function changedLines(
  before: readonly string[],
  after: readonly string[],
): { line: number; endLine: number }[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  const point = (index: number) => {
    const line = Math.min(Math.max(1, index + 1), Math.max(1, after.length));
    return { line, endLine: line };
  };
  if (!a.length && !b.length) return [];
  if (!b.length) return after.length ? [point(start)] : [];
  if (!a.length) return [{ line: start + 1, endLine: start + b.length }];
  const marked = myers(a, b);
  if (marked === null) return [{ line: start + 1, endLine: start + b.length }];
  const lines = [...marked].map((index) => start + index).sort((x, y) => x - y);
  const ranges: { line: number; endLine: number }[] = [];
  for (const index of lines) {
    const { line } = point(index);
    const last = ranges.at(-1);
    if (last && line <= last.endLine + 1) last.endLine = Math.max(last.endLine, line);
    else ranges.push({ line, endLine: line });
  }
  return ranges;
}

/** Indexes of `b` that are inserted, or that follow a deletion; null past the edit limit. */
function myers(a: readonly string[], b: readonly string[]): Set<number> | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, CHANGE_LIMITS.edits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v);
    v = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[k - 1 + offset] ?? 0) < (v[k + 1 + offset] ?? 0))
          ? (v[k + 1 + offset] ?? 0)
          : (v[k - 1 + offset] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m, offset);
    }
  }
  return null;
}

/** Walks the edit path back from (n, m); `trace[d]` is the state before round d. */
function backtrack(
  trace: readonly Int32Array[],
  depth: number,
  n: number,
  m: number,
  offset: number,
): Set<number> {
  const marked = new Set<number>();
  let x = n;
  let y = m;
  for (let d = depth; d > 0; d--) {
    const previous = trace[d] as Int32Array;
    const k = x - y;
    const down =
      k === -d || (k !== d && (previous[k - 1 + offset] ?? 0) < (previous[k + 1 + offset] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = previous[prevK + offset] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (down) marked.add(prevY);
    else marked.add(y);
    x = prevX;
    y = prevY;
  }
  return marked;
}
