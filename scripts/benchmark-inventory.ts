// Scores the agent inventory against the expected results for the fixture corpus.
// Usage: node scripts/benchmark-inventory.ts [--write]
//   --write  replace the expected results with the current output (review the diff!)

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { scan } from "../src/scan.ts";
import { type CompactInventory, compact, score } from "../test/inventory-compact.ts";

const corpus = fileURLToPath(new URL("../test/fixtures/frameworks", import.meta.url));
const expectedPath = fileURLToPath(
  new URL("../test/fixtures/frameworks/expected-inventory.json", import.meta.url),
);

const actual = compact((await scan(corpus)).inventory);
if (process.argv.includes("--write")) {
  await writeFile(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`wrote ${expectedPath}`);
} else {
  const expected: CompactInventory = JSON.parse(await readFile(expectedPath, "utf8"));
  const scores = score(expected, actual);
  console.log("section        expected  found  precision  recall");
  for (const row of scores) {
    console.log(
      `${row.kind.padEnd(14)} ${String(row.expected).padStart(8)} ${String(row.found).padStart(6)} ${row.precision.toFixed(2).padStart(10)} ${row.recall.toFixed(2).padStart(7)}`,
    );
  }
  const misses = scores.filter((row) => row.precision < 1 || row.recall < 1);
  for (const row of misses) {
    const want = new Set(expected[row.kind]);
    const got = new Set(actual[row.kind]);
    for (const item of got) if (!want.has(item)) console.log(`  unexpected ${row.kind}: ${item}`);
    for (const item of want) if (!got.has(item)) console.log(`  missing ${row.kind}: ${item}`);
  }
  process.exitCode = misses.length > 0 ? 1 : 0;
}
