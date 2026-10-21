import { readFileSync } from "node:fs";
import path from "node:path";

const DOCS = path.resolve("docs");

export function readDoc({ name, encoding }: { name: string; encoding?: BufferEncoding }) {
  if (!/^[\w-]+$/.test(name)) throw new Error("invalid document name");
  return readFileSync(path.join(DOCS, `${name}.md`), encoding ?? "utf8");
}
