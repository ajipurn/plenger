// Scores the agent inventory and the risk findings against the reviewed expected results
// of each fixture corpus.
// Usage: node scripts/benchmark.ts [--write]
//   --write  replace the expected results with the current output (review the diff!)

import { readFile, writeFile } from "node:fs/promises";
import { scan } from "../src/scan.ts";
import {
  type CompactInventory,
  compact,
  compactFindings,
  type Score,
  score,
  scoreFindings,
} from "../test/support/compact.ts";
import { CORPORA } from "../test/support/corpora.ts";
import { fixturePath } from "../test/support/fixtures.ts";

let failed = false;
for (const corpus of CORPORA) {
  const root = fixturePath(corpus);
  const result = await scan(root);
  const inventory = compact(result.inventory);
  const findings = compactFindings(result.findings);
  if (process.argv.includes("--write")) {
    await writeFile(`${root}/expected-inventory.json`, `${JSON.stringify(inventory, null, 2)}\n`);
    await writeFile(`${root}/expected-findings.json`, `${JSON.stringify(findings, null, 2)}\n`);
    console.log(`wrote the expected results of ${corpus}`);
    continue;
  }
  const expectedInventory: CompactInventory = JSON.parse(
    await readFile(`${root}/expected-inventory.json`, "utf8"),
  );
  const expectedFindings: string[] = JSON.parse(
    await readFile(`${root}/expected-findings.json`, "utf8"),
  );
  report(`${corpus}: inventory`, "section", score(expectedInventory, inventory), (kind) => [
    expectedInventory[kind] ?? [],
    inventory[kind] ?? [],
  ]);
  report(`${corpus}: findings`, "rule", scoreFindings(expectedFindings, findings), (rule) => {
    const of = (lines: string[]) =>
      rule === "all" ? [] : lines.filter((line) => line.startsWith(`${rule} `));
    return [of(expectedFindings), of(findings)];
  });
}
process.exitCode = failed ? 1 : 0;

function report(
  title: string,
  label: string,
  scores: Score[],
  items: (kind: string) => [string[], string[]],
): void {
  console.log(`\n${title}\n${label.padEnd(14)} expected  found  precision  recall`);
  for (const row of scores) {
    console.log(
      `${row.kind.padEnd(14)} ${String(row.expected).padStart(8)} ${String(row.found).padStart(6)} ${row.precision.toFixed(2).padStart(10)} ${row.recall.toFixed(2).padStart(7)}`,
    );
  }
  for (const row of scores.filter((item) => item.precision < 1 || item.recall < 1)) {
    failed = true;
    const [expected, actual] = items(row.kind);
    const want = new Set(expected);
    const got = new Set(actual);
    for (const item of got) if (!want.has(item)) console.log(`  unexpected ${row.kind}: ${item}`);
    for (const item of want) if (!got.has(item)) console.log(`  missing ${row.kind}: ${item}`);
  }
}
