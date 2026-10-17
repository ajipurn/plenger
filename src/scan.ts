import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeCapabilities } from "./capabilities/analyze.ts";
import { extractFacts, type FileFacts } from "./facts/index.ts";
import { literalCredentials } from "./facts/query.ts";
import { buildInventory, type Inventory } from "./inventory/index.ts";
import { Project, type ProjectFile } from "./project/project.ts";
import { evaluateRules, type Finding } from "./rules/index.ts";
import { attachSnippets } from "./rules/snippets.ts";
import { compareStrings } from "./shared/compare.ts";
import { redactReport } from "./shared/secrets.ts";
import {
  type CollectOptions,
  collectSourceFiles,
  DEFAULT_MAX_FILE_BYTES,
  type ExcludedDir,
  type SkipReason,
} from "./source/files.ts";
import { type BinaryKind, LANGUAGE_OF, type Language, type TextKind } from "./source/languages.ts";
import { SourceParser } from "./source/parser.ts";
import { countLines, looksMinified, type ReadSkipReason, readSource } from "./source/read.ts";

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

/** A text file the scan lists for the AI review without reading or parsing it. */
export interface ListedTextFile {
  path: string;
  kind: TextKind;
  bytes: number;
}

/** A compiled or packaged file in the project, listed so a reader knows it was not analysed. */
export interface ListedBinary {
  path: string;
  kind: BinaryKind;
  bytes: number;
  /** Of the file's contents; null above `HASH_LIMIT` bytes or when it cannot be read. */
  sha256: string | null;
}

/** Binaries larger than this are listed without a hash. */
const HASH_LIMIT = 64 * 1024 * 1024;

export interface ScanOptions extends CollectOptions {
  /** Extract imports, definitions, assignments and calls from every file. */
  facts?: boolean;
}

export type ScanSkipReason = SkipReason | ReadSkipReason;

export interface ScanResult {
  root: string;
  files: ScannedFile[];
  /**
   * Text files without a parser, in any language, that the AI review may read as plain
   * text. Present when the scan was asked for them with `texts`.
   */
  textFiles?: ListedTextFile[];
  /** Compiled or packaged files the scan cannot read; present when there are any. */
  binaries?: ListedBinary[];
  skipped: { path: string; reason: ScanSkipReason }[];
  excludedDirs: ExcludedDir[];
  truncated: boolean;
  inventory: Inventory;
  /** Risk findings, most urgent first. */
  findings: Finding[];
  durationMs: number;
}

/** Reads and parses every supported source file under `root`. Never executes project code. */
export async function scan(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const started = performance.now();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const collected = await collectSourceFiles(root, options);
  const files: ScannedFile[] = [];
  const parsed: ProjectFile[] = [];
  const skipped: ScanResult["skipped"] = [...collected.skipped];
  const parser = await SourceParser.create();

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
        parsed.push({ path: file.path, language: scanned.language, facts });
        if (options.facts) scanned.facts = facts;
        files.push(scanned);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.dispose();
  }

  // Facts are per file; linking points imports of project files at what those files define.
  const project = Project.link(collected.root, parsed, {
    tsconfig: await readOptional(join(collected.root, "tsconfig.json")),
  });
  const inventory = buildInventory(project);
  analyzeCapabilities(project, inventory);
  const findings = evaluateRules(project, inventory);
  await attachSnippets(collected.root, findings);

  skipped.sort((a, b) => compareStrings(a.path, b.path));
  const binaries: ListedBinary[] = [];
  for (const file of collected.binaries)
    binaries.push({
      path: file.path,
      kind: file.kind,
      bytes: file.bytes,
      sha256: file.bytes <= HASH_LIMIT ? await sha256(file.absolutePath) : null,
    });
  const result: ScanResult = {
    root: collected.root,
    files,
    ...(options.texts
      ? { textFiles: collected.texts.map(({ path, kind, bytes }) => ({ path, kind, bytes })) }
      : {}),
    ...(binaries.length > 0 ? { binaries } : {}),
    skipped,
    excludedDirs: collected.excludedDirs,
    truncated: collected.truncated,
    inventory,
    findings,
    durationMs: 0,
  };
  redactReport(result, literalCredentials(parsed));
  result.durationMs = Math.round(performance.now() - started);
  return result;
}

/** SHA-256 of a file read as a stream, or null when it cannot be read. */
async function sha256(path: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/** A file's text, or undefined when it is missing or unreadable. */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}
