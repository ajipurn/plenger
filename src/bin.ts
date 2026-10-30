#!/usr/bin/env node
import { readFileSync } from "node:fs";

// npm only warns about `engines`, so stop with a clear message before the CLI
// loads built-ins that older Node.js versions lack, such as node:sqlite. Each
// release line has its own minimum patch: the one that fixes the Brotli decoder
// (CVE-2026-111497), which `fetch` runs on every provider response.
const { engines } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { engines: { node: string } };
const version = process.versions.node.split(".").map(Number);

function atLeast(minimum: number[]): boolean {
  for (let index = 0; index < 3; index++) {
    const difference = (version[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

// Ranges are `^x.y.z` (that major only) or `>=x.y.z`, joined by `||`.
const supported = engines.node.split("||").some((range) => {
  const trimmed = range.trim();
  const minimum = trimmed
    .replace(/^(\^|>=)/, "")
    .split(".")
    .map(Number);
  return atLeast(minimum) && (!trimmed.startsWith("^") || version[0] === minimum[0]);
});

if (!supported) {
  process.stderr.write(
    `plenger: Node.js ${engines.node} is required; found ${process.versions.node}.\n`,
  );
  process.exitCode = 1;
} else {
  const { main } = await import("./cli/index.ts");
  process.exitCode = await main(process.argv.slice(2));
}
