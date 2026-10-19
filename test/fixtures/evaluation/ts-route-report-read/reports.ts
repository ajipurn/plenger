import path from "node:path";

const REPORTS = path.resolve("reports");

export function reportPath(name: string): string {
  return path.join(REPORTS, name);
}
