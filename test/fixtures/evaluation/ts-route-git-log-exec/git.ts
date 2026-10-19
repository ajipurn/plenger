import { execSync } from "node:child_process";

export function gitLog(branch: string): string {
  return execSync(`git log --oneline -20 ${branch}`, { encoding: "utf8" });
}
