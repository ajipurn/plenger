/**
 * Reading and parsing source files into code facts, on worker threads for larger
 * projects. Results keep the order of the files, so a scan is the same either way.
 * Workers only read and parse; nothing in a project is run.
 */

import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { extractFacts, type FileFacts } from "./facts/index.ts";
import { type Grammar, LANGUAGE_OF, type Language } from "./source/languages.ts";
import { SourceParser } from "./source/parser.ts";
import { countLines, looksMinified, type ReadSkipReason, readSource } from "./source/read.ts";

/** A file to parse, as the file collector lists it. */
export interface ParseTask {
  path: string;
  absolutePath: string;
  grammar: Grammar;
  bytes: number;
}

export type ParseResult =
  | { kind: "skipped"; path: string; reason: ReadSkipReason | "minified" }
  | {
      kind: "parsed";
      path: string;
      language: Language;
      bytes: number;
      lines: number;
      syntaxErrors: boolean;
      facts: FileFacts;
    };

/** Below this many files, starting workers costs more than it saves. */
const WORKER_THRESHOLD = 64;
/** Workers to start at most, leaving a core for the rest of the scan. */
const MAX_WORKERS = 4;

/** Parses one file with `parser`. */
export async function parseOne(
  parser: SourceParser,
  task: ParseTask,
  maxFileBytes: number,
): Promise<ParseResult> {
  const source = await readSource(task.absolutePath, maxFileBytes);
  if (typeof source !== "string")
    return { kind: "skipped", path: task.path, reason: source.reason };
  if (task.grammar !== "python" && looksMinified(source))
    return { kind: "skipped", path: task.path, reason: "minified" };
  const tree = await parser.parse(task.grammar, source);
  try {
    return {
      kind: "parsed",
      path: task.path,
      language: LANGUAGE_OF[task.grammar],
      bytes: task.bytes,
      lines: countLines(source),
      syntaxErrors: tree.rootNode.hasError,
      facts: extractFacts(tree, task.grammar),
    };
  } finally {
    tree.delete();
  }
}

/**
 * Parses every task, in order. `workers` caps the worker threads; 0 parses on this
 * thread. By default larger projects use up to four workers.
 */
export async function parseFiles(
  tasks: readonly ParseTask[],
  maxFileBytes: number,
  workers?: number,
): Promise<ParseResult[]> {
  const count =
    workers ??
    (tasks.length < WORKER_THRESHOLD
      ? 0
      : Math.min(MAX_WORKERS, Math.max(1, availableParallelism() - 1)));
  const results: (ParseResult | undefined)[] = new Array(tasks.length);
  if (count > 0) await parseOnWorkers(tasks, maxFileBytes, count, results).catch(() => undefined);
  // Whatever workers did not parse (none started, or one failed) is parsed here.
  const missing = tasks.flatMap((_task, index) => (results[index] === undefined ? [index] : []));
  if (missing.length > 0) {
    const parser = await SourceParser.create();
    try {
      for (const index of missing)
        results[index] = await parseOne(parser, tasks[index] as ParseTask, maxFileBytes);
    } finally {
      parser.dispose();
    }
  }
  return results as ParseResult[];
}

async function parseOnWorkers(
  tasks: readonly ParseTask[],
  maxFileBytes: number,
  count: number,
  results: (ParseResult | undefined)[],
): Promise<void> {
  // The sources run as TypeScript under `pnpm dev` and tests, and as JavaScript once built.
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const url = new URL(`./parse-worker.${extension}`, import.meta.url);
  let next = 0;
  const run = () =>
    new Promise<void>((resolve, reject) => {
      const worker = new Worker(url, { workerData: { maxFileBytes } });
      const send = () => {
        if (next >= tasks.length) {
          void worker.terminate();
          resolve();
          return;
        }
        const index = next++;
        worker.postMessage({ index, task: tasks[index] });
      };
      worker.on("message", (message: { index: number; result: ParseResult }) => {
        results[message.index] = message.result;
        send();
      });
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (code !== 0 && next < tasks.length) reject(new Error(`parse worker exited ${code}`));
      });
      send();
    });
  await Promise.all(Array.from({ length: count }, run));
}
