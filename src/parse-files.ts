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
  // Whatever workers did not parse (none started, or one failed and all were stopped)
  // is parsed here.
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

/** The worker script, run as TypeScript under `pnpm dev` and tests and as JavaScript once built. */
const WORKER_URL = new URL(
  `./parse-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
  import.meta.url,
);

/**
 * Parses tasks on `count` workers into `results`. When one fails, or exits before it has
 * no task left, every worker is stopped before this rejects, so none writes to `results`
 * afterwards and nothing is left running.
 */
export async function parseOnWorkers(
  tasks: readonly ParseTask[],
  maxFileBytes: number,
  count: number,
  results: (ParseResult | undefined)[],
  url: URL = WORKER_URL,
): Promise<void> {
  let next = 0;
  let stopped = false;
  const workers: Worker[] = [];
  const run = () =>
    new Promise<void>((resolve, reject) => {
      const worker = new Worker(url, { workerData: { maxFileBytes } });
      workers.push(worker);
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        if (error === undefined) resolve();
        else reject(error);
      };
      const send = () => {
        if (stopped || next >= tasks.length) {
          finish();
          void worker.terminate();
          return;
        }
        const index = next++;
        worker.postMessage({ index, task: tasks[index] });
      };
      worker.on("message", (message: { index: number; result: ParseResult }) => {
        if (stopped) return;
        results[message.index] = message.result;
        send();
      });
      worker.on("error", (error) => finish(error));
      // An exit while a task is still out, whatever its code, leaves that task unparsed.
      worker.on("exit", (code) => finish(new Error(`parse worker exited ${code}`)));
      send();
    });
  try {
    await Promise.all(Array.from({ length: count }, run));
  } catch (error) {
    stopped = true;
    await Promise.all(workers.map((worker) => worker.terminate()));
    throw error;
  }
}
