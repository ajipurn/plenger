#!/usr/bin/env node
import { readFileSync } from "node:fs";

// npm only warns about `engines`, so stop with a clear message before the CLI
// loads built-ins that older Node.js versions lack, such as node:sqlite.
const { engines } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { engines: { node: string } };
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const [minMajor = 0, minMinor = 0] = engines.node.replace(/^>=/, "").split(".").map(Number);

if (major < minMajor || (major === minMajor && minor < minMinor)) {
  process.stderr.write(
    `plenger: Node.js ${minMajor}.${minMinor} or newer is required; found ${process.versions.node}.\n`,
  );
  process.exitCode = 1;
} else {
  const { main } = await import("./cli/index.ts");
  process.exitCode = await main(process.argv.slice(2));
}
