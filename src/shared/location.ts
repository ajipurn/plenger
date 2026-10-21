/** Keys and comparisons over source positions, shared by every pass that joins items by where they are. */

/** `path:line:column`, the key inventory items and calls are matched on. */
export function locationKey(location: { path: string; line: number; column: number }): string {
  return `${location.path}:${location.line}:${location.column}`;
}

/** Whether two spans or locations start at the same position (the calls of a chain do). */
export function sameStart(
  a: { line: number; column: number },
  b: { line: number; column: number },
): boolean {
  return a.line === b.line && a.column === b.column;
}

/** A position as one number that orders positions in a file: by line, then column. */
export function positionOrder(line: number, column: number): number {
  return line * 1e6 + column;
}

/** Whether a position lies inside a span, both ends included. */
export function inSpan(
  span: { line: number; column: number; endLine: number; endColumn: number },
  at: { line: number; column: number },
): boolean {
  const position = positionOrder(at.line, at.column);
  return (
    position >= positionOrder(span.line, span.column) &&
    position <= positionOrder(span.endLine, span.endColumn)
  );
}
