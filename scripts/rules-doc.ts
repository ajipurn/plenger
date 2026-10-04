// Writes docs/RULES.md from the rule catalog.
// Usage: node scripts/rules-doc.ts

import { writeFile } from "node:fs/promises";
import { rulesMarkdown } from "../src/report/rule-list.ts";
import { RULES } from "../src/rules/index.ts";

await writeFile(new URL("../docs/RULES.md", import.meta.url), rulesMarkdown(RULES));
console.log("wrote docs/RULES.md");
