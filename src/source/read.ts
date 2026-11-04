import { readFile } from "node:fs/promises";

/**
 * `not_utf8` is no longer produced: text that is not valid UTF-8 is read with
 * replacement characters. Reports written before that may still carry it.
 */
export type ReadSkipReason = "unreadable" | "too_large" | "binary";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const lossyUtf8 = new TextDecoder("utf-8");

/** Bytes inspected for NUL bytes, as Git does. */
const BINARY_PROBE_BYTES = 8192;

/**
 * Reads a source file as text, or says why the scan should skip it.
 *
 * One stray byte must not hide a file from the scan, so a file is binary only when
 * NUL bytes come with bytes that are not UTF-8, or when NUL bytes are at least a tenth
 * of its start (UTF-16 text and binary data). Other bytes that are not UTF-8 are read
 * as replacement characters, which keeps every other position in the file.
 */
export async function readSource(
  path: string,
  maxFileBytes: number,
): Promise<string | { reason: ReadSkipReason }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return { reason: "unreadable" };
  }
  if (bytes.length > maxFileBytes) return { reason: "too_large" };
  const probe = bytes.subarray(0, BINARY_PROBE_BYTES);
  let nul = 0;
  for (let at = probe.indexOf(0); at !== -1; at = probe.indexOf(0, at + 1)) nul++;
  if (nul > 0 && nul * 10 >= probe.length) return { reason: "binary" };
  try {
    return utf8.decode(bytes);
  } catch {
    if (nul > 0) return { reason: "binary" };
    return lossyUtf8.decode(bytes);
  }
}

/** Lines at least this long are bundler output rather than written code. */
const LONG_LINE = 300;
/** Written lines a bundle may hold besides comments: an `export {…}` or a directive. */
const BUNDLE_CODE_LINES = 3;

/**
 * Bundler output such as Vite's hashed assets: a large file with nine tenths of its
 * text on very long lines, and besides those only comments (a licence header, a source
 * map URL) and at most a few short lines. One long line in written code, such as a
 * long comment or string, does not make a file minified.
 */
export function looksMinified(text: string): boolean {
  if (text.length < 2048) return false;
  let long = 0;
  let written = 0;
  for (let start = 0; start <= text.length; ) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    if (end - start >= LONG_LINE) long += end - start;
    else if (!isCommentLine(text.slice(start, end).trim()) && ++written > BUNDLE_CODE_LINES)
      return false;
    start = end + 1;
  }
  return long * 10 >= text.length * 9;
}

function isCommentLine(line: string): boolean {
  return (
    line === "" ||
    line.startsWith("//") ||
    line.startsWith("/*") ||
    line.startsWith("*") ||
    line.startsWith("#!")
  );
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return text.endsWith("\n") ? lines - 1 : lines;
}
