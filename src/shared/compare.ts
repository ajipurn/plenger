/** Code-unit string order: deterministic across locales, unlike `localeCompare`. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
