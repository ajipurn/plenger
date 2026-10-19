import path from "node:path";

const REPORTS = path.resolve("reports");

export function reportPath(name: string): string {
  const resolved = path.resolve(REPORTS, name);
  if (!resolved.startsWith(REPORTS + path.sep)) throw new Error("outside the reports directory");
  return resolved;
}
