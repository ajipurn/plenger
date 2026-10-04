import { formatRules } from "../../report/rule-list.ts";
import { RULES } from "../../rules/index.ts";
import { json } from "../../shared/json.ts";
import { COMMON_OPTIONS, parseCommandArgs, requireNonemptyPaths } from "../args.ts";
import { emit, type Io } from "../io.ts";
import { OUTPUT_OPTIONS, textFormat } from "./output.ts";

/** `plenger rules`: list the risk rules as text or JSON. */
export async function rulesCommand(argv: string[], io: Io): Promise<number> {
  const { values } = parseCommandArgs("rules", argv, { ...COMMON_OPTIONS, ...OUTPUT_OPTIONS }, 0);
  requireNonemptyPaths(values, ["output"]);
  const format = textFormat("rules", values.format, values.json === true);
  await emit(format === "json" ? json({ rules: RULES }) : formatRules(RULES), values.output, io);
  return 0;
}
