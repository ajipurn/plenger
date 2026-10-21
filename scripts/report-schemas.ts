import { fileURLToPath } from "node:url";
import { writeOutput } from "../src/cli/io.ts";
import { REDTEAM_SCHEMAS } from "../src/redteam/schema.ts";
import { REPORT_SCHEMAS } from "../src/report/schema.ts";
import { json } from "../src/shared/json.ts";

for (const [name, schema] of Object.entries({
  ...REPORT_SCHEMAS,
  ...REDTEAM_SCHEMAS,
})) {
  await writeOutput(fileURLToPath(new URL(`../schemas/${name}`, import.meta.url)), json(schema));
}
