import { readFile } from "node:fs/promises";
import { extractFacts, type FileFacts } from "./facts/index.ts";
import {
  type CollectOptions,
  collectSourceFiles,
  DEFAULT_MAX_FILE_BYTES,
  type ExcludedDir,
  type SkipReason,
} from "./files.ts";
import { type Inventory, InventoryBuilder } from "./inventory/index.ts";
import { localPythonModules } from "./inventory/modules.ts";
import { LANGUAGE_OF, type Language } from "./languages.ts";
import { SourceParser } from "./parser.ts";

export interface ScannedFile {
  path: string;
  language: Language;
  bytes: number;
  lines: number;
  /** The file did not parse cleanly; anything derived from it may be incomplete. */
  syntaxErrors: boolean;
  /** Present when the scan was asked for code facts. */
  facts?: FileFacts;
}

export interface ScanOptions extends CollectOptions {
  /** Extract imports, definitions, assignments and calls from every file. */
  facts?: boolean;
}

export type ScanSkipReason = SkipReason | "binary" | "not_utf8";

export interface ScanResult {
  root: string;
  files: ScannedFile[];
  skipped: { path: string; reason: ScanSkipReason }[];
  excludedDirs: ExcludedDir[];
  truncated: boolean;
  inventory: Inventory;
  durationMs: number;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Reads and parses every supported source file under `root`. Never executes project code. */
export async function scan(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const started = performance.now();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const collected = await collectSourceFiles(root, options);
  const files: ScannedFile[] = [];
  const skipped: ScanResult["skipped"] = [...collected.skipped];
  const parser = await SourceParser.create();
  const inventory = new InventoryBuilder(
    localPythonModules(collected.files.map((file) => file.path)),
  );

  try {
    for (const file of collected.files) {
      const source = await readSource(file.absolutePath, maxFileBytes);
      if (typeof source !== "string") {
        skipped.push({ path: file.path, reason: source.reason });
        continue;
      }
      if (file.grammar !== "python" && looksMinified(source)) {
        skipped.push({ path: file.path, reason: "minified" });
        continue;
      }
      const tree = await parser.parse(file.grammar, source);
      try {
        const scanned: ScannedFile = {
          path: file.path,
          language: LANGUAGE_OF[file.grammar],
          bytes: file.bytes,
          lines: countLines(source),
          syntaxErrors: tree.rootNode.hasError,
        };
        const facts = extractFacts(tree, file.grammar);
        inventory.addFile(file.path, scanned.language, facts);
        if (options.facts) scanned.facts = facts;
        files.push(scanned);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.dispose();
  }

  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    root: collected.root,
    files,
    skipped,
    excludedDirs: collected.excludedDirs,
    truncated: collected.truncated,
    inventory: inventory.build(),
    durationMs: Math.round(performance.now() - started),
  };
}

async function readSource(
  path: string,
  maxFileBytes: number,
): Promise<string | { reason: ScanSkipReason }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return { reason: "unreadable" };
  }
  if (bytes.length > maxFileBytes) return { reason: "too_large" };
  if (bytes.subarray(0, 8192).includes(0)) return { reason: "binary" };
  try {
    return utf8.decode(bytes);
  } catch {
    return { reason: "not_utf8" };
  }
}

/** Bundler output such as Vite's hashed assets: large files with very long lines. */
export function looksMinified(text: string): boolean {
  return text.length >= 2048 && text.length / Math.max(countLines(text), 1) > 300;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return text.endsWith("\n") ? lines - 1 : lines;
}
