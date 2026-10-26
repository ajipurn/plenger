import { createHash } from "node:crypto";
import { extractFacts } from "../facts/index.ts";
import type { FileFacts } from "../facts/model.ts";
import { decodeSource, isSensitiveSourcePath, readProjectFile } from "../redteam/project-files.ts";
import type { ScanResult } from "../scan.ts";
import { redact } from "../shared/secrets.ts";
import { collectSourceFiles, DEFAULT_MAX_FILE_BYTES } from "../source/files.ts";
import type { Grammar } from "../source/languages.ts";
import { SourceParser } from "../source/parser.ts";
import { countLines, looksMinified } from "../source/read.ts";
import {
  coversAll,
  excerptParts,
  type LineSizes,
  lineSizes,
  mergeRanges,
  rangeBytes,
  renderedJsonBytes,
  renderSource,
  selectExcerpt,
} from "./review-excerpt.ts";
import { type ReviewFocus, reviewFocus } from "./review-focus.ts";
import {
  SECURITY_REVIEW_LIMITS as LIMITS,
  type ReviewBudget,
  type ReviewRange,
  type ReviewSourceFile,
  reviewBudget,
} from "./review-model.ts";

export interface ReviewContext {
  /** Sent to the provider. */
  files: (ReviewSourceFile & { source: string })[];
  omitted: { path: string; reason: string }[];
  /** Redacted lines of each submitted file, for host-supplied snippets. Never sent. */
  lines: Map<string, string[]>;
}
export class ReviewSourceError extends Error {}

const SECURITY_NAME =
  /(?:auth|permission|tenant|route|handler|api|server|database|query|store|service|security|middleware|controller|tool|agent)/i;
/** Below this many bytes of remaining context, no further file can fit. */
const MIN_ENTRY_BYTES = 256;
/** Tests, fixtures and examples: reviewed after the code they exercise. */
const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|specs?|fixtures|__fixtures__|testdata|e2e|mocks|__mocks__|examples?)\/|(?:^|[/._-])(?:test|spec)[._-][^/]*$/i;
/** CI definitions: hidden paths that hold no credentials and run with repository secrets. */
const CI_DEFINITION =
  /^(?:\.github\/workflows\/[^/]+|\.github\/actions\/.+\/action|\.gitlab-ci|\.circleci\/config)\.ya?ml$/;

interface CapturedSource {
  /** Absent for a text file without a parser, which has no facts. */
  grammar?: Grammar;
  text: string;
  /** Redacted, split on newlines. */
  lines: string[];
  /** Measures excerpts without rendering them. */
  measure: LineSizes;
  lineCount: number;
  /** Bytes read from disk. */
  bytes: number;
  digest: string;
  facts?: FileFacts | null;
}
type Entry = ReviewSourceFile & { source: string };

/** The batch budget of a model whose input window is unknown. */
const DEFAULT_BUDGET = reviewBudget([]);

/**
 * Reads redacted source within a saved scan's allowlist, under the current ignore and
 * source rules, through the bounded regular-file reader. Never loads project modules.
 * One reader serves a review's batch and its second-review context; dispose it after.
 */
export class ReviewSourceReader {
  readonly root: string;
  readonly collected: Awaited<ReturnType<typeof collectSourceFiles>>;
  readonly #available: Map<string, { grammar?: Grammar }>;
  readonly #secrets: string[];
  readonly #captured = new Map<string, CapturedSource | null>();
  #parser: SourceParser | undefined;

  private constructor(
    collected: Awaited<ReturnType<typeof collectSourceFiles>>,
    available: Map<string, { grammar?: Grammar }>,
    secrets: string[],
  ) {
    this.root = collected.root;
    this.collected = collected;
    this.#available = available;
    this.#secrets = secrets;
  }

  static async open(snapshot: ScanResult, secrets: string[]): Promise<ReviewSourceReader> {
    // The scan's own limit, so that every file it listed can still be found.
    const collected = await collectSourceFiles(snapshot.root, { texts: true }).catch(() => {
      throw new ReviewSourceError(
        "Source is no longer available at the selected project path. Run a new scan before reviewing it.",
      );
    });
    // A changed root (including a replaced symlink) must never widen the authorized scope.
    if (collected.root !== snapshot.root)
      throw new ReviewSourceError("The project path changed. Run a new scan before reviewing it.");
    const allowed = new Set(reviewPaths(snapshot));
    const available = new Map<string, { grammar?: Grammar }>([
      ...collected.files
        .filter((file) => allowed.has(file.path))
        .map((file) => [file.path, file] as const),
      ...collected.texts
        .filter((file) => allowed.has(file.path))
        .map((file) => [file.path, {}] as const),
    ]);
    return new ReviewSourceReader(collected, available, secrets);
  }

  /** Why a scanned path may not be read, or null when it may. */
  exclusion(path: string): string | null {
    if (redact(path, this.#secrets) !== path) return "Credential-like source path excluded.";
    if (!this.#available.has(path))
      return "No longer available under the scan's ignore and source rules.";
    if (isSensitiveSourcePath(path) && !CI_DEFINITION.test(path))
      return "Hidden or credential-related path excluded.";
    return null;
  }

  /** Redacted source with original line numbers, or null when it cannot be read safely. */
  async read(path: string): Promise<CapturedSource | null> {
    const cached = this.#captured.get(path);
    if (cached !== undefined) return cached;
    const file = this.#available.get(path);
    let source: CapturedSource | null = null;
    if (file !== undefined && this.exclusion(path) === null) {
      try {
        const bytes = await readProjectFile(this.root, path, DEFAULT_MAX_FILE_BYTES);
        const raw = decodeSource(bytes);
        if (looksMinified(raw)) throw new Error("minified");
        // Keep original line numbers when a multiline private key is removed.
        const text = redact(
          raw.replace(
            /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+)?PRIVATE KEY-----|$)/g,
            (block) => `<redacted>${"\n".repeat((block.match(/\n/g) ?? []).length)}`,
          ),
          this.#secrets,
        );
        const lineCount = countLines(text);
        if (!text.trim() || lineCount !== countLines(raw)) throw new Error("empty-or-line-change");
        const lines = text.split("\n");
        source = {
          ...(file.grammar ? { grammar: file.grammar } : {}),
          text,
          lines,
          measure: lineSizes(lines),
          lineCount,
          bytes: bytes.byteLength,
          digest: createHash("sha256").update(text).digest("hex"),
        };
      } catch {
        source = null;
      }
    }
    this.#captured.set(path, source);
    return source;
  }

  /** Facts parsed from the redacted text at review time, or null when parsing fails. */
  async facts(source: CapturedSource): Promise<FileFacts | null> {
    if (source.facts !== undefined) return source.facts;
    const grammar = source.grammar;
    if (grammar === undefined) {
      source.facts = null;
      return null;
    }
    try {
      this.#parser ??= await SourceParser.create();
      const tree = await this.#parser.parse(grammar, source.text);
      try {
        source.facts = extractFacts(tree, grammar);
      } finally {
        tree.delete();
      }
    } catch {
      source.facts = null;
    }
    return source.facts;
  }

  dispose(): void {
    this.#parser?.dispose();
    this.#parser = undefined;
  }
}

/**
 * Line-numbered source within the saved scan's allowlist. Never loads project modules.
 * Files on the scan's traced entry point, tool and model output paths are submitted
 * first, as function excerpts if needed, so a batch can follow a path end to end. Spare
 * budget then turns those excerpts into whole files and takes the remaining files.
 * `submitted` lists what earlier batches of the same scan sent: whole files are skipped,
 * and an excerpted file continues with the functions not sent yet.
 */
export async function captureReviewSource(
  snapshot: ScanResult,
  secrets: string[],
  signal?: AbortSignal,
  submitted: readonly ReviewSourceFile[] = [],
  options: {
    reader?: ReviewSourceReader;
    budget?: Pick<ReviewBudget, "contextBytes" | "fileBytes" | "files">;
  } = {},
): Promise<{
  context: ReviewContext;
  scope: {
    capturedAt: string;
    files: ReviewSourceFile[];
    eligibleFiles: number;
    omittedFiles: number;
    excludedEntries: number;
    partial: boolean;
    contextDigest: string;
  };
}> {
  const capturedAt = new Date().toISOString();
  const budget = options.budget ?? DEFAULT_BUDGET;
  const reader = options.reader ?? (await ReviewSourceReader.open(snapshot, secrets));
  const collected = reader.collected;
  const scannedLines = new Map(snapshot.files.map((file) => [file.path, file.lines]));
  const covered = previousCoverage(submitted);
  const focus = reviewFocus(snapshot.inventory, snapshot.findings);
  const order = reviewOrder(snapshot, focus);

  const reasons = new Map<string, string>();
  for (const path of order) {
    const exclusion = reader.exclusion(path);
    if (covered.get(path)?.ranges === null) reasons.set(path, "Included in an earlier round.");
    else if (exclusion !== null) reasons.set(path, exclusion);
  }

  const captured = new Map<string, CapturedSource>();
  async function capture(path: string): Promise<CapturedSource | null> {
    const source = await reader.read(path);
    if (source === null) {
      reasons.set(path, "File too large, linked, changed, unreadable, binary, empty, or minified.");
      return null;
    }
    // Earlier ranges describe the earlier text; a changed file cannot continue from them.
    const previous = covered.get(path);
    if (previous !== undefined && previous.digest !== source.digest) {
      reasons.set(path, "Changed after an earlier round submitted part of it.");
      return null;
    }
    captured.set(path, source);
    return source;
  }
  const factsOf = (source: CapturedSource) => reader.facts(source);
  /** Located lines are only trusted while the file still has the line count the scan saw. */
  function focusOf(path: string, source: CapturedSource): ReviewFocus | undefined {
    const located = focus.get(path);
    if (located === undefined || scannedLines.get(path) === source.lineCount) return located;
    return { ...located, lines: new Set() };
  }

  const entries = new Map<string, Entry>();
  const sizes = new Map<string, number>();
  const entryOf = (
    path: string,
    source: CapturedSource,
    ranges?: ReviewRange[],
    text = renderSource(source.lines, source.lineCount, ranges),
  ): Entry => ({
    path,
    lines: source.lineCount,
    digest: source.digest,
    ...(ranges ? { ranges } : {}),
    source: text,
  });
  /** Serialized context bytes if `path` held an entry of `size` bytes. */
  const contextWith = (path: string, size: number) => {
    let total = 2 + size;
    for (const [other, bytes] of sizes) if (other !== path) total += bytes + 1;
    return total;
  };
  const remaining = () => budget.contextBytes - contextWith("", 0);
  /**
   * Whether an entry stays within the per-file and context budgets, measured from line
   * sizes: choosing an excerpt tries many range sets, and rendering each would be quadratic.
   */
  function fits(path: string, source: CapturedSource, ranges?: ReviewRange[]): boolean {
    const submitted = ranges ?? [{ line: 1, endLine: source.lineCount }];
    if (rangeBytes(source.measure, submitted) > budget.fileBytes) return false;
    // The empty source's two quote bytes are counted again by the rendered size.
    const size =
      Buffer.byteLength(JSON.stringify(entryOf(path, source, ranges, ""))) -
      2 +
      renderedJsonBytes(source.measure, source.lineCount, ranges);
    return contextWith(path, size) <= budget.contextBytes;
  }
  function tryAdd(path: string, source: CapturedSource, ranges?: ReviewRange[]): boolean {
    if (!fits(path, source, ranges)) return false;
    const entry = entryOf(path, source, ranges);
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (contextWith(path, size) > budget.contextBytes) return false;
    entries.set(path, entry);
    sizes.set(path, size);
    return true;
  }
  /**
   * Adds an excerpt; "done" when an earlier batch already sent every part of the file.
   * With `keep`, extends that excerpt with the file's other definitions.
   */
  async function addExcerpt(
    path: string,
    source: CapturedSource,
    keep?: ReviewRange[],
  ): Promise<"added" | "no-room" | "done"> {
    const sent = covered.get(path)?.ranges ?? undefined;
    // Blank lines hold nothing to review, so they never make a sent part look new.
    const blank = source.lines.flatMap((text, index) =>
      text.trim() ? [] : [{ line: index + 1, endLine: index + 1 }],
    );
    const previous = sent && mergeRanges([...sent, ...blank], source.lineCount, 0);
    const located = excerptParts(
      await factsOf(source),
      source.lineCount,
      focusOf(path, source),
      keep !== undefined || previous !== undefined,
    );
    const parts = keep ? [{ ranges: keep }, ...located] : located;
    const ranges = selectExcerpt(
      parts,
      source.lineCount,
      (trial) => fits(path, source, trial),
      previous,
    );
    if (ranges.length)
      return tryAdd(path, source, coversAll(ranges, source.lineCount) ? undefined : ranges)
        ? "added"
        : "no-room";
    const left = previous && selectExcerpt(parts, source.lineCount, () => true, previous);
    return left && !left.length ? "done" : "no-room";
  }

  try {
    // 1. Traced paths, as excerpts of the functions on them. A file an earlier batch
    // excerpted already sent its path functions; it continues in step 3. Traced tests
    // wait for step 3, after the other code.
    for (const path of order) {
      signal?.throwIfAborted();
      if (!focus.get(path)?.traced || TEST_PATH.test(path)) continue;
      if (reasons.has(path) || covered.has(path)) continue;
      if (entries.size >= budget.files || remaining() < MIN_ENTRY_BYTES) break;
      const source = await capture(path);
      if (source !== null) await addExcerpt(path, source);
    }
    // 2. Whole files where the excerpts leave room.
    for (const [path, entry] of [...entries]) {
      const source = captured.get(path);
      if (entry.ranges && source && source.bytes <= budget.fileBytes) tryAdd(path, source);
    }
    // 3. Everything else in review order. Continued files only add lines not sent yet.
    for (const path of order) {
      signal?.throwIfAborted();
      if (entries.has(path) || reasons.has(path)) continue;
      if (entries.size >= budget.files) {
        reasons.set(path, "Review file limit reached.");
        continue;
      }
      if (remaining() < MIN_ENTRY_BYTES) {
        reasons.set(path, "Review source budget reached.");
        continue;
      }
      const source = await capture(path);
      if (source === null) continue;
      const continued = covered.has(path);
      if (!continued && source.bytes <= budget.fileBytes && tryAdd(path, source)) continue;
      const excerpt =
        continued || source.bytes > budget.fileBytes || focus.has(path)
          ? await addExcerpt(path, source)
          : "no-room";
      if (excerpt === "done") reasons.set(path, "Included in an earlier round.");
      else if (excerpt === "no-room") reasons.set(path, "Review source budget reached.");
    }
    // 4. Spare budget extends excerpts with their files' other definitions.
    for (const [path, entry] of [...entries]) {
      signal?.throwIfAborted();
      const source = captured.get(path);
      if (entry.ranges && source && remaining() >= MIN_ENTRY_BYTES)
        await addExcerpt(path, source, entry.ranges);
    }
  } finally {
    if (options.reader === undefined) reader.dispose();
  }

  const context: ReviewContext = {
    files: order.flatMap((path) => entries.get(path) ?? []),
    omitted: order.flatMap((path) => {
      const reason = reasons.get(path);
      return reason === undefined ? [] : [{ path, reason }];
    }),
    lines: new Map([...entries.keys()].map((path) => [path, captured.get(path)?.lines ?? []])),
  };
  if (!context.files.length)
    throw new ReviewSourceError(
      "No source files fit this review. Select a smaller source folder and scan it first.",
    );
  // Omission details stay local. The provider receives only included files and a count.
  const encoded = JSON.stringify(context.files);
  const excludedEntries = new Set([
    ...collected.skipped.map((file) => file.path),
    ...collected.excludedDirs.map((file) => file.path),
    ...snapshot.skipped.map((file) => file.path),
  ]).size;
  return {
    context,
    scope: {
      capturedAt,
      files: context.files.map(({ source: _source, ...file }) => file),
      eligibleFiles: order.length,
      omittedFiles: context.omitted.length,
      excludedEntries,
      partial:
        context.omitted.length > 0 ||
        context.files.some((file) => file.ranges !== undefined) ||
        collected.truncated ||
        excludedEntries > 0 ||
        snapshot.truncated,
      contextDigest: createHash("sha256").update(encoded).digest("hex"),
    },
  };
}

/** What earlier batches sent per path. `ranges` is null once nothing is left to continue. */
function previousCoverage(
  submitted: readonly ReviewSourceFile[],
): Map<string, { digest: string; ranges: ReviewRange[] | null }> {
  const coverage = new Map<string, { digest: string; ranges: ReviewRange[] | null }>();
  for (const file of submitted) {
    const known = coverage.get(file.path);
    // A whole file, or one that changed between earlier batches, does not continue.
    if (!file.ranges || known?.ranges === null || (known && known.digest !== file.digest)) {
      coverage.set(file.path, { digest: file.digest, ranges: null });
      continue;
    }
    const ranges = mergeRanges([...(known?.ranges ?? []), ...file.ranges], file.lines, 0);
    coverage.set(file.path, {
      digest: file.digest,
      ranges: coversAll(ranges, file.lines) ? null : ranges,
    });
  }
  return coverage;
}

/**
 * How many files a review of `root` could read and their size, listed under the scan's
 * ignore and source rules without reading contents. An estimate: binary, minified or
 * changed files are only found when read.
 */
export async function reviewSourceSize(
  root: string,
): Promise<{ files: number; bytes: number; truncated: boolean }> {
  const collected = await collectSourceFiles(root, { texts: true });
  const readable = [...collected.files, ...collected.texts].filter(
    (file) => !isSensitiveSourcePath(file.path) || CI_DEFINITION.test(file.path),
  );
  return {
    files: readable.length,
    bytes: readable.reduce((sum, file) => sum + file.bytes, 0),
    truncated: collected.truncated,
  };
}

/** Parsed source files and listed text files: every path a review may read. */
export function reviewPaths(snapshot: ScanResult): string[] {
  return [
    ...snapshot.files.map((file) => file.path),
    ...(snapshot.textFiles ?? []).map((file) => file.path),
  ];
}

/**
 * Traced files in path order and other focused files, then the rest: code in any
 * language before configuration, security-related names first, then path order. Tests,
 * fixtures and examples follow in the same order, after everything else.
 */
function reviewOrder(snapshot: ScanResult, focus: Map<string, ReviewFocus>): string[] {
  const kinds = new Map((snapshot.textFiles ?? []).map((file) => [file.path, file.kind]));
  const listed = new Set(reviewPaths(snapshot));
  const rank = (path: string) =>
    (kinds.get(path) === "config" ? 2 : 0) + (SECURITY_NAME.test(path) ? 0 : 1);
  const order = [
    ...[...focus.keys()].filter((path) => listed.has(path)),
    ...[...listed]
      .filter((path) => !focus.has(path))
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)),
  ];
  return [
    ...order.filter((path) => !TEST_PATH.test(path)),
    ...order.filter((path) => TEST_PATH.test(path)),
  ];
}

export function reviewSnippet(
  context: ReviewContext,
  path: string,
  line: number,
  endLine: number,
): string {
  const previewEnd = Math.min(endLine, line + LIMITS.snippetLines - 1);
  const snippet = (context.lines.get(path) ?? [])
    .slice(line - 1, previewEnd)
    .map((text, index) => `${line + index}: ${text}`)
    .join("\n");
  return snippet && previewEnd < endLine
    ? `${snippet}\n… ${endLine - previewEnd} more cited lines (through line ${endLine}).`
    : snippet;
}
