type Cell = string | number | boolean | null | undefined;

/** One CSV field; cells that a spreadsheet would read as a formula are prefixed with a quote. */
export function field(value: Cell): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((row) => row.map(field).join(",")).join("\r\n");
}
