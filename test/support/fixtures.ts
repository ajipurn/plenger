import { fileURLToPath } from "node:url";

/** Absolute path of a file or directory under `test/fixtures/`. */
export function fixturePath(relative: string): string {
  return fileURLToPath(new URL(`../fixtures/${relative}`, import.meta.url));
}
