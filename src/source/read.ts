import { readFile } from "node:fs/promises";

export type ReadSkipReason = "unreadable" | "too_large" | "binary" | "not_utf8";

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Reads a source file as text, or says why the scan should skip it. */
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
  if (bytes.subarray(0, 8192).includes(0)) return { reason: "binary" };
  try {
    return utf8.decode(bytes);
  } catch {
    return { reason: "not_utf8" };
  }
}

/** Bundler output such as Vite's hashed assets: large files with very long lines. */
export function looksMinified(text: string): boolean {
  return text.length >= 2048 && text.length / Math.max(countLines(text), 1) > 300;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return text.endsWith("\n") ? lines - 1 : lines;
}
