// Scores the agent inventory against the reviewed expected results of each fixture corpus.
// Usage: node scripts/benchmark-inventory.ts [--write]
//   --write  replace the expected results with the current output (review the diff!)

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { scan } from "../src/scan.ts";
import { type CompactInventory, compact, score } from "../test/inventory-compact.ts";

/** Fixture directories with an expected-inventory.json. */
const CORPORA = ["frameworks", "crossfile"];

let failed = false;
for (const corpus of CORPORA) {
  const root = fileURLToPath(new URL(`../test/fixtures/${corpus}`, import.meta.url));
  const expectedPath = `${root}/expected-inventory.json`;
  const actual = compact((await scan(root)).inventory);
  if (process.argv.includes("--write")) {
    await writeFile(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`wrote ${expectedPath}`);
    continue;
  }
  const expected: CompactInventory = JSON.parse(await readFile(expectedPath, "utf8"));
  const scores = score(expected, actual);
  console.log(`\n${corpus}\nsection        expected  found  precision  recall`);
  for (const row of scores) {
    console.log(
      `${row.kind.padEnd(14)} ${String(row.expected).padStart(8)} ${String(row.found).padStart(6)} ${row.precision.toFixed(2).padStart(10)} ${row.recall.toFixed(2).padStart(7)}`,
    );
  }
  for (const row of scores.filter((item) => item.precision < 1 || item.recall < 1)) {
    failed = true;
    const want = new Set(expected[row.kind]);
    const got = new Set(actual[row.kind]);
    for (const item of got) if (!want.has(item)) console.log(`  unexpected ${row.kind}: ${item}`);
    for (const item of want) if (!got.has(item)) console.log(`  missing ${row.kind}: ${item}`);
  }
}
process.exitCode = failed ? 1 : 0;
