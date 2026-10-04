/** Drop structurally identical observations while keeping first-seen order. */
export function uniqueObservations<T>(values: T[]): T[] {
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
}
