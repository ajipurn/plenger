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
import { LANGUAGE_OF, type Language } from "./source/languages.ts";
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

export interface ScanOptions extends CollectOptions {
  /** Extract imports, definitions, assignments and calls from every file. */
  facts?: boolean;
}

export type ScanSkipReason = SkipReason | ReadSkipReason;

export interface ScanResult {
  root: string;
  files: ScannedFile[];
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
  const result: ScanResult = {
    root: collected.root,
    files,
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

/** A file's text, or undefined when it is missing or unreadable. */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}
