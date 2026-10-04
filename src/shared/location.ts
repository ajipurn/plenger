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
