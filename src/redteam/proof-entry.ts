/**
 * Where a finding's input enters, for a proof test (docs/design/proof-tests.md). The
 * host derives it from the static inventory, never from the model: a model that chose
 * its own entry could call an inner helper and skip the check that guards it.
 */
import type { Capability, Location } from "../inventory/model.ts";
import type { ScanResult } from "../scan.ts";
import { PROOF_LIMITS } from "./constants.ts";
import type { ProofRange } from "./proof-model.ts";

interface Candidate {
  handler: string | null;
  handlerPath?: string;
  location: Location;
  effects: Capability[];
}

function overlaps(range: ProofRange, place: { path: string; line: number; endLine: number }) {
  return place.path === range.path && place.line <= range.endLine && place.endLine >= range.line;
}

/** Entry ranges and how they were found; `via` is null when there is none. */
export interface ProofEntries {
  ranges: ProofRange[];
  /**
   * `inventory`: routes and tools whose traced effects reach the cited lines.
   * `public-function`: the project has no route or tool at all (a job, a library), so
   * the entry is the public function that encloses the first cited range.
   */
  via: "inventory" | "public-function" | null;
}

/**
 * Where the input of a finding enters. The scan must include code facts
 * (`scan(root, { facts: true })`). A project with routes or tools gets entries only
 * from them, so a helper they guard never becomes the entry.
 */
export function proofEntries(snapshot: ScanResult, cited: readonly ProofRange[]): ProofEntries {
  const definitions = new Map(
    snapshot.files.map((file) => [file.path, file.facts?.definitions ?? []]),
  );
  const { entryPoints, tools } = snapshot.inventory;
  if (entryPoints.length === 0 && tools.length === 0) {
    const [first] = cited;
    const enclosing = (definitions.get(first?.path ?? "") ?? [])
      .filter(
        (item) =>
          first !== undefined &&
          item.kind !== "class" &&
          item.exported &&
          item.span.line <= first.line &&
          item.span.endLine >= first.endLine,
      )
      .sort((a, b) => b.span.endLine - b.span.line - (a.span.endLine - a.span.line))[0];
    return enclosing && first
      ? {
          ranges: [
            { path: first.path, line: enclosing.span.line, endLine: enclosing.span.endLine },
          ],
          via: "public-function",
        }
      : { ranges: [], via: null };
  }
  const ranges = inventoryEntries(snapshot, definitions, cited);
  return { ranges, via: ranges.length ? "inventory" : null };
}

/**
 * The handler bodies of the routes and tools whose traced effects reach the cited
 * lines, best first: an effect or a call on the way to it inside a cited range, then
 * one in a cited file.
 */
function inventoryEntries(
  snapshot: ScanResult,
  definitions: Map<string, NonNullable<ScanResult["files"][number]["facts"]>["definitions"]>,
  cited: readonly ProofRange[],
): ProofRange[] {
  const candidates: Candidate[] = [
    ...snapshot.inventory.entryPoints.map((entry) => ({ ...entry, effects: entry.reaches })),
    ...snapshot.inventory.tools.map((tool) => ({ ...tool, effects: tool.capabilities })),
  ];
  const found = new Map<string, { range: ProofRange; score: number }>();
  for (const candidate of candidates) {
    if (candidate.handler === null) continue;
    const path = candidate.handlerPath ?? candidate.location.path;
    const definition = definitions
      .get(path)
      ?.find((item) => item.id === candidate.handler && item.kind !== "class");
    if (!definition) continue;
    const range = { path, line: definition.span.line, endLine: definition.span.endLine };
    const places = candidate.effects.flatMap((effect) => [effect.location, ...effect.via]);
    const score =
      cited.some((item) => overlaps(item, range)) ||
      places.some((place) => cited.some((item) => overlaps(item, place)))
        ? 2
        : places.some((place) => cited.some((item) => item.path === place.path))
          ? 1
          : 0;
    if (score === 0) continue;
    const key = `${range.path}:${range.line}:${range.endLine}`;
    const known = found.get(key);
    if (!known || known.score < score) found.set(key, { range, score });
  }
  const ranked = [...found.values()].sort(
    (a, b) =>
      b.score - a.score || a.range.path.localeCompare(b.range.path) || a.range.line - b.range.line,
  );
  const best = ranked[0]?.score ?? 0;
  return ranked
    .filter((item) => item.score === best)
    .slice(0, PROOF_LIMITS.ranges)
    .map((item) => item.range);
}
