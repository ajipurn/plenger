import path from "node:path";

export function isWithin(base: string, target: string): boolean {
  return path.resolve(target).startsWith(path.resolve(base));
}
