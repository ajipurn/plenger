import type { FileFacts } from "../facts/model.ts";
import { Project } from "../project/project.ts";
import { readProjectFile } from "../redteam/project-files.ts";
import type { ScanResult } from "../scan.ts";
import {
  coversAll,
  excerptParts,
  rangeBytes,
  renderedJsonBytes,
  renderSource,
  selectExcerpt,
} from "./review-excerpt.ts";
import type { ReviewFocus } from "./review-focus.ts";
import type { RelatedSourceFile, ReviewRange } from "./review-model.ts";
import type { ReviewContext, ReviewSourceReader } from "./review-source.ts";

const EMPTY_FACTS: FileFacts = { imports: [], definitions: [], assignments: [], calls: [] };

export interface RelatedBudget {
  /** Serialized bytes of every related entry together. */
  bytes: number;
  /** Source bytes of one related file. */
  fileBytes: number;
  files: number;
}

interface Relation {
  path: string;
  relation: RelatedSourceFile["relation"];
  /** The cited file it relates to. */
  via: string;
  lines: Set<number>;
  definitions: Set<string>;
}

/**
 * Context for a second review that a batch may lack: the project files that the cited
 * files import (with the imported definitions) and the project files that call them
 * (with the calling functions). Guards, middleware and callers often live there. Files
 * come from the scan's allowlist through the same reader as the batch, as redacted
 * excerpts with original line numbers, and never repeat lines the batch already holds.
 */
export async function captureRelatedSource(
  reader: ReviewSourceReader,
  snapshot: ScanResult,
  batch: ReviewContext,
  cited: readonly string[],
  budget: RelatedBudget,
  signal?: AbortSignal,
): Promise<(RelatedSourceFile & { source: string })[]> {
  const citedSet = new Set(cited);
  const parsed = new Map<string, FileFacts>();
  for (const path of cited) {
    const source = await reader.read(path);
    const facts = source === null ? null : await reader.facts(source);
    if (facts !== null) parsed.set(path, facts);
  }
  // Only a file that names a cited module can import it; parse just those.
  const stems = [...citedSet].map(moduleStem);
  for (const file of snapshot.files) {
    signal?.throwIfAborted();
    if (citedSet.has(file.path) || reader.exclusion(file.path) !== null) continue;
    const source = await reader.read(file.path);
    if (source === null || !stems.some((stem) => source.text.includes(stem))) continue;
    const facts = await reader.facts(source);
    if (facts !== null) parsed.set(file.path, facts);
  }
  const project = Project.link(
    reader.root,
    snapshot.files.map((file) => ({
      path: file.path,
      language: file.language,
      facts: parsed.get(file.path) ?? EMPTY_FACTS,
    })),
    { tsconfig: await readTsconfig(reader.root) },
  );

  const relations = new Map<string, Relation>();
  const relate = (path: string, relation: Relation["relation"], via: string) => {
    let entry = relations.get(path);
    if (entry === undefined) {
      entry = { path, relation, via, lines: new Set(), definitions: new Set() };
      relations.set(path, entry);
    }
    return entry;
  };
  for (const path of cited) {
    for (const fact of parsed.get(path)?.imports ?? []) {
      const target = project.resolveModule(path, fact.module);
      if (target === undefined || target === path || citedSet.has(target)) continue;
      const entry = relate(target, "imported", path);
      if (fact.imported !== null && fact.imported !== "default")
        entry.definitions.add(fact.imported);
    }
  }
  for (const [path, facts] of parsed) {
    if (citedSet.has(path)) continue;
    for (const fact of facts.imports) {
      const target = project.resolveModule(path, fact.module);
      if (target === undefined || !citedSet.has(target)) continue;
      const entry = relations.get(path) ?? relate(path, "caller", target);
      const names = new Set([fact.local, fact.imported].filter((name) => name !== null));
      for (const call of facts.calls) {
        const root = call.callee.split(/[.([]/)[0] ?? "";
        if (call.ref?.file === target || names.has(root)) entry.lines.add(call.span.line);
      }
    }
  }

  const related: (RelatedSourceFile & { source: string })[] = [];
  let used = 2;
  for (const relation of relations.values()) {
    signal?.throwIfAborted();
    if (related.length >= budget.files || used >= budget.bytes) break;
    const inBatch = batch.files.find((file) => file.path === relation.path);
    if (inBatch !== undefined && inBatch.ranges === undefined) continue;
    const source = await reader.read(relation.path);
    if (source === null) continue;
    const focus: ReviewFocus = {
      traced: false,
      lines: relation.lines,
      definitions: relation.definitions,
    };
    const parts = excerptParts(await reader.facts(source), source.lineCount, focus);
    const header = (ranges: ReviewRange[] | undefined) =>
      Buffer.byteLength(
        JSON.stringify({
          path: relation.path,
          lines: source.lineCount,
          digest: source.digest,
          ...(ranges ? { ranges } : {}),
          relation: relation.relation,
          via: relation.via,
          source: "",
        }),
      ) - 2;
    const ranges = selectExcerpt(
      parts,
      source.lineCount,
      (trial) =>
        rangeBytes(source.measure, trial) <= budget.fileBytes &&
        used + 1 + header(trial) + renderedJsonBytes(source.measure, source.lineCount, trial) <=
          budget.bytes,
      inBatch?.ranges,
    );
    if (!ranges.length) continue;
    const submitted = coversAll(ranges, source.lineCount) ? undefined : ranges;
    const entry = {
      path: relation.path,
      lines: source.lineCount,
      digest: source.digest,
      ...(submitted ? { ranges: submitted } : {}),
      relation: relation.relation,
      via: relation.via,
      source: renderSource(source.lines, source.lineCount, submitted),
    };
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (used + 1 + size > budget.bytes) continue;
    used += 1 + size;
    related.push(entry);
  }
  return related;
}

/** The name an import of a project file uses: its file name, or its folder for an index file. */
function moduleStem(path: string): string {
  const parts = path.split("/");
  const base = (parts.at(-1) ?? path).replace(/\.[^.]+$/, "");
  return (base === "index" || base === "__init__") && parts.length > 1
    ? (parts.at(-2) ?? base)
    : base;
}

async function readTsconfig(root: string): Promise<string | undefined> {
  try {
    return (await readProjectFile(root, "tsconfig.json", 1024 * 1024)).toString("utf8");
  } catch {
    return undefined;
  }
}
