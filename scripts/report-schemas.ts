import { fileURLToPath } from "node:url";
import { writeOutput } from "../src/cli.ts";
import { json } from "../src/report/format.ts";
import { REPORT_SCHEMAS } from "../src/report/schema.ts";

for (const [name, schema] of Object.entries(REPORT_SCHEMAS)) {
  await writeOutput(fileURLToPath(new URL(`../schemas/${name}`, import.meta.url)), json(schema));
}
