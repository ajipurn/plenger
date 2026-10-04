/** Pretty-printed JSON with a trailing newline, the format of every file plenger writes. */
export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
