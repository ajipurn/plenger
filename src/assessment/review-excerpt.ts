import type { DefinitionFact, FileFacts, Span } from "../facts/model.ts";
import type { ReviewFocus } from "./review-focus.ts";
import type { ReviewRange } from "./review-model.ts";

/** Lines kept on each side of a located line when its whole function does not fit. */
const CONTEXT_LINES = 8;
/** Gaps of at most this many lines are submitted instead of being marked as omitted. */
const JOIN_GAP = 2;

/** Lines an excerpt adds together, with a smaller alternative for when they do not fit. */
export interface ExcerptPart {
  ranges: ReviewRange[];
  fallback?: ReviewRange[];
  /** Context such as imports: an excerpt of only supporting parts is not submitted. */
  supporting?: true;
}

/**
 * The parts of a file to submit, most useful first. With focus: the whole functions,
 * methods and module statements that hold located lines or handlers, each with its
 * enclosing class headers, then module imports. Without focus, when nothing located
 * maps onto the file, or with `allDefinitions`: module imports, then top-level
 * definitions in source order.
 */
export function excerptParts(
  facts: FileFacts | null,
  lineCount: number,
  focus: ReviewFocus | undefined,
  allDefinitions = false,
): ExcerptPart[] {
  const definitions = facts?.definitions ?? [];
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const parts: { order: number; part: ExcerptPart }[] = [];
  const units = new Map<DefinitionFact, number[]>();
  for (const line of [...(focus?.lines ?? [])].sort((a, b) => a - b)) {
    if (line < 1 || line > lineCount) continue;
    const inner = innermost(definitions, line);
    if (inner !== undefined) {
      const unit = unitOf(inner, byId);
      units.set(unit, [...(units.get(unit) ?? []), line]);
      continue;
    }
    const statement = moduleStatement(facts, line);
    parts.push({
      order: line,
      part: {
        ranges: [statement ?? window(line, 2)],
        ...(statement ? { fallback: [window(line, CONTEXT_LINES)] } : {}),
      },
    });
  }
  for (const id of focus?.definitions ?? []) {
    const definition = byId.get(id);
    if (definition === undefined) continue;
    const unit = unitOf(definition, byId);
    if (!units.has(unit)) units.set(unit, []);
  }
  for (const [unit, lines] of units) {
    const headers = classHeaders(unit, byId);
    const body = extent(unit);
    const windows = lines.length
      ? lines.map((line) => ({
          line: Math.max(body.line, line - CONTEXT_LINES),
          endLine: Math.min(body.endLine, line + CONTEXT_LINES),
        }))
      : [{ line: body.line, endLine: Math.min(body.endLine, unit.span.line + 2 * CONTEXT_LINES) }];
    parts.push({
      order: lines[0] ?? Number.POSITIVE_INFINITY,
      part: {
        ranges: [...headers, body],
        fallback: [...headers, { line: body.line, endLine: unit.span.line }, ...windows],
      },
    });
  }
  const imports = (facts?.imports ?? [])
    .filter((fact) => fact.scope === null)
    .map((fact) => range(fact.span));
  const context: ExcerptPart[] = imports.length ? [{ ranges: imports, supporting: true }] : [];
  const ordered = parts.sort((a, b) => a.order - b.order).map((item) => item.part);
  if (ordered.length && !allDefinitions) return [...ordered, ...context];

  const outline = [...ordered, ...context];
  for (const definition of definitions) {
    if (definition.parent !== null) continue;
    outline.push({ ranges: [extent(definition)] });
    // A class too large to submit whole still contributes its methods.
    if (definition.kind === "class")
      for (const member of definitions)
        if (member.parent === definition.id && member.kind !== "class")
          outline.push({ ranges: [...classHeaders(member, byId), extent(member)] });
  }
  return outline;
}

/**
 * Adds parts in order while `fits` accepts the merged ranges, trying each fallback once.
 * A part counts only when its own lines reach outside `covered`, the lines an earlier
 * batch submitted; its fallback must too. Supporting context is sent again. Empty unless
 * such a part fits.
 */
export function selectExcerpt(
  parts: readonly ExcerptPart[],
  lineCount: number,
  fits: (ranges: ReviewRange[]) => boolean,
  covered: readonly ReviewRange[] = [],
): ReviewRange[] {
  const adds = (option: readonly ReviewRange[]) =>
    mergeRanges(option, lineCount, 0).some(
      (item) => !covered.some((done) => done.line <= item.line && item.endLine <= done.endLine),
    );
  let chosen: ReviewRange[] = [];
  let substantive = false;
  for (const part of parts) {
    // A fallback only stands in for lines that are new; it never revisits a sent part.
    if (!part.supporting && !adds(part.ranges)) continue;
    for (const option of part.fallback ? [part.ranges, part.fallback] : [part.ranges]) {
      if (!part.supporting && !adds(option)) continue;
      const trial = mergeRanges([...chosen, ...option], lineCount);
      if (fits(trial)) {
        chosen = trial;
        substantive ||= !part.supporting;
        break;
      }
    }
  }
  return substantive ? chosen : [];
}

/** Sorted, clamped ranges with gaps of at most `joinGap` lines joined. */
export function mergeRanges(
  ranges: readonly ReviewRange[],
  lineCount: number,
  joinGap = JOIN_GAP,
): ReviewRange[] {
  const merged: ReviewRange[] = [];
  const clamped = ranges
    .map((item) => ({ line: Math.max(1, item.line), endLine: Math.min(lineCount, item.endLine) }))
    .filter((item) => item.line <= item.endLine)
    .sort((a, b) => a.line - b.line || a.endLine - b.endLine);
  for (const item of clamped) {
    const last = merged.at(-1);
    if (last !== undefined && item.line <= last.endLine + joinGap + 1)
      last.endLine = Math.max(last.endLine, item.endLine);
    else merged.push({ ...item });
  }
  return merged;
}

/** True when the ranges cover every line, so the file is submitted whole. */
export function coversAll(ranges: readonly ReviewRange[], lineCount: number): boolean {
  return ranges.length === 1 && ranges[0]?.line === 1 && ranges[0].endLine >= lineCount;
}

/** UTF-8 bytes of the submitted lines, before numbering. */
export function rangeBytes(lines: readonly string[], ranges: readonly ReviewRange[]): number {
  let bytes = 0;
  for (const item of ranges)
    for (let line = item.line; line <= item.endLine; line++)
      bytes += Buffer.byteLength(lines[line - 1] ?? "") + 1;
  return bytes;
}

/**
 * Line-numbered source. An excerpt keeps original line numbers and marks every
 * omitted stretch, so the provider can tell missing lines from absent code.
 */
export function renderSource(
  lines: readonly string[],
  lineCount: number,
  ranges?: readonly ReviewRange[],
): string {
  if (ranges === undefined) return lines.map((text, index) => `${index + 1}: ${text}`).join("\n");
  const out: string[] = [];
  let next = 1;
  for (const item of ranges) {
    if (item.line > next) out.push(gap(next, item.line - 1));
    for (let line = item.line; line <= item.endLine; line++)
      out.push(`${line}: ${lines[line - 1] ?? ""}`);
    next = item.endLine + 1;
  }
  if (next <= lineCount) out.push(gap(next, lineCount));
  return out.join("\n");
}

function gap(from: number, to: number): string {
  return from === to ? `… line ${from} not submitted` : `… lines ${from}-${to} not submitted`;
}

function range(span: Span): ReviewRange {
  return { line: span.line, endLine: span.endLine };
}

function window(line: number, radius: number): ReviewRange {
  return { line: line - radius, endLine: line + radius };
}

/** A definition's lines, including its decorators. */
function extent(definition: DefinitionFact): ReviewRange {
  return {
    line: Math.min(definition.span.line, ...definition.decorators.map((item) => item.span.line)),
    endLine: definition.span.endLine,
  };
}

/** The smallest definition whose lines hold `line`. */
function innermost(
  definitions: readonly DefinitionFact[],
  line: number,
): DefinitionFact | undefined {
  let best: DefinitionFact | undefined;
  for (const definition of definitions) {
    const lines = extent(definition);
    if (line < lines.line || line > lines.endLine) continue;
    if (best === undefined || lines.endLine - lines.line < extent(best).endLine - extent(best).line)
      best = definition;
  }
  return best;
}

/** The module-level function, method or class a definition belongs to. */
function unitOf(definition: DefinitionFact, byId: Map<string, DefinitionFact>): DefinitionFact {
  let current = definition;
  for (;;) {
    const parent = current.parent === null ? undefined : byId.get(current.parent);
    if (parent === undefined || parent.kind === "class") return current;
    current = parent;
  }
}

/** Decorators and first line of every class around a method, outermost first. */
function classHeaders(
  definition: DefinitionFact,
  byId: Map<string, DefinitionFact>,
): ReviewRange[] {
  const headers: ReviewRange[] = [];
  for (
    let parent = definition.parent === null ? undefined : byId.get(definition.parent);
    parent !== undefined;
    parent = parent.parent === null ? undefined : byId.get(parent.parent)
  )
    if (parent.kind === "class")
      headers.unshift({ line: extent(parent).line, endLine: parent.span.line });
  return headers;
}

/** The outermost module-level import, assignment or call holding `line`. */
function moduleStatement(facts: FileFacts | null, line: number): ReviewRange | undefined {
  let best: ReviewRange | undefined;
  for (const fact of [
    ...(facts?.imports ?? []),
    ...(facts?.assignments ?? []),
    ...(facts?.calls ?? []),
  ]) {
    if (fact.scope !== null || line < fact.span.line || line > fact.span.endLine) continue;
    if (best === undefined || fact.span.endLine - fact.span.line > best.endLine - best.line)
      best = range(fact.span);
  }
  return best;
}
