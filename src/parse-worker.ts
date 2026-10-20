/** A worker thread that parses the files `parseFiles` sends it, one at a time. */

import { parentPort, workerData } from "node:worker_threads";
import { type ParseTask, parseOne } from "./parse-files.ts";
import { SourceParser } from "./source/parser.ts";

const parser = await SourceParser.create();
const { maxFileBytes } = workerData as { maxFileBytes: number };

parentPort?.on("message", async (message: { index: number; task: ParseTask }) => {
  const result = await parseOne(parser, message.task, maxFileBytes);
  parentPort?.postMessage({ index: message.index, result });
});
