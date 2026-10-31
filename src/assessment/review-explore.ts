/**
 * Read-only exploration for the AI review (M9b): one model conversation per phase
 * with tools that list, read, search and outline the scan's allowlisted files, and a
 * submit tool that carries the phase's answer. The host checks every call, redacts
 * every result through `ReviewSourceReader`, bounds the session and records what was
 * read, so citations can be checked against it. Nothing here executes project code.
 */

import { randomUUID } from "node:crypto";
import { type ModelReply, type ModelRequest, reachedOutputLimit } from "../redteam/provider.ts";
import type { ScanResult } from "../scan.ts";
import { redact } from "../shared/secrets.ts";
import { mergeRanges } from "./review-excerpt.ts";
import {
  EXPLORE_LIMITS,
  EXPLORE_STOPS,
  type ExplorePhase,
  type ExploreSessionRecord,
  type ExploreStop,
  REVIEW_DISCOVERY_SCHEMA,
  REVIEW_VALIDATION_SCHEMA,
  type ReviewRange,
  type ReviewSourceFile,
} from "./review-model.ts";
import { type ReviewSourceReader, reviewPaths } from "./review-source.ts";

type SessionLimits = Record<keyof (typeof EXPLORE_LIMITS)[ExplorePhase], number>;

const NOT_ALLOWED = "not in the review allowlist";

/** What a session received, per path: merged line ranges and the file's digest. */
export class ReadLog {
  readonly #files = new Map<string, { lines: number; digest: string; ranges: ReviewRange[] }>();

  /** Initial context counts as read: whole files, or the excerpt's ranges. */
  seed(files: readonly ReviewSourceFile[]): void {
    for (const file of files)
      this.record(
        file.path,
        file.lines,
        file.digest,
        file.ranges ?? [{ line: 1, endLine: file.lines }],
      );
  }

  record(path: string, lines: number, digest: string, ranges: readonly ReviewRange[]): void {
    const known = this.#files.get(path);
    this.#files.set(path, {
      lines,
      digest,
      ranges: mergeRanges([...(known?.ranges ?? []), ...ranges], lines, 0),
    });
  }

  /** The parts of `range` already in the conversation. */
  covered(path: string, range: ReviewRange): ReviewRange[] {
    return (this.#files.get(path)?.ranges ?? []).flatMap((read) => {
      const line = Math.max(read.line, range.line);
      const endLine = Math.min(read.endLine, range.endLine);
      return line <= endLine ? [{ line, endLine }] : [];
    });
  }

  /** The read files as a citation scope: a file read in full has no ranges. */
  files(): ReviewSourceFile[] {
    return [...this.#files].map(([path, file]) => {
      const whole =
        file.ranges.length === 1 &&
        file.ranges[0]?.line === 1 &&
        file.ranges[0].endLine >= file.lines;
      return {
        path,
        lines: file.lines,
        digest: file.digest,
        ...(whole ? {} : { ranges: file.ranges }),
      };
    });
  }

  entries(): ExploreSessionRecord["reads"] {
    return this.files().map((file) => ({
      path: file.path,
      ranges: file.ranges ?? null,
      digest: file.digest,
    }));
  }
}

/**
 * The tools of a phase in the chat-completions function form the providers accept.
 * `strict` asks the provider to hold the submit tool's arguments to its schema.
 */
export function exploreTools(phase: ExplorePhase, strict = false): unknown[] {
  const read = [
    tool("list_files", "List allowlisted files under a path prefix, with their kind and size.", {
      prefix: {
        type: "string",
        description: "Path prefix, such as src/. Omit for the whole repository.",
      },
      cursor: { type: "string", description: "The next value of an earlier page." },
    }),
    tool(
      "read_file",
      `Read redacted, line-numbered lines of an allowlisted file, at most ${EXPLORE_LIMITS.readLines} lines and ${EXPLORE_LIMITS.readBytes / 1024} KiB per call. Lines already in the conversation are not sent again.`,
      {
        path: { type: "string", description: "An allowlisted path, exactly as listed." },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      ["path"],
    ),
    tool(
      "search",
      `Find lines that contain a literal string in allowlisted files, on redacted text. At most ${EXPLORE_LIMITS.searchMatches} matches. Matches are for navigation and cannot be cited; read the lines to cite them.`,
      {
        query: {
          type: "string",
          minLength: EXPLORE_LIMITS.queryMin,
          maxLength: EXPLORE_LIMITS.queryMax,
        },
        prefix: { type: "string" },
        caseSensitive: { type: "boolean" },
      },
      ["query"],
    ),
    tool(
      "outline",
      "List the definitions and imports of a parsed Python, JavaScript, TypeScript or PHP file, with line ranges. Outlines cannot be cited.",
      { path: { type: "string" } },
      ["path"],
    ),
  ];
  return [...read, submitTool(phase, strict)];
}

function submitTool(phase: ExplorePhase, strict: boolean): unknown {
  return {
    type: "function",
    function: {
      ...(phase === "discovery"
        ? {
            name: "submit_discovery",
            description:
              "Submit the review: architecture, STRIDE and findings. Cite only lines you received in the first message or from read_file.",
            parameters: REVIEW_DISCOVERY_SCHEMA,
          }
        : {
            name: "submit_decisions",
            description: "Submit one decision for every candidate.",
            parameters: REVIEW_VALIDATION_SCHEMA,
          }),
      ...(strict ? { strict: true } : {}),
    },
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): unknown {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", additionalProperties: false, properties, required },
    },
  };
}

/** The repository map and static hints of the first discovery message, within their byte caps. */
export function exploreHints(snapshot: ScanResult, reader: ReviewSourceReader, secrets: string[]) {
  const languages = new Map(snapshot.files.map((file) => [file.path, file]));
  const texts = new Map((snapshot.textFiles ?? []).map((file) => [file.path, file]));
  const map: { path: string; kind: string; lines?: number; bytes: number }[] = [];
  let mapBytes = 0;
  const allowed = reviewPaths(snapshot).filter((path) => reader.exclusion(path) === null);
  for (const path of allowed) {
    const parsed = languages.get(path);
    const text = texts.get(path);
    const entry = parsed
      ? { path, kind: parsed.language, lines: parsed.lines, bytes: parsed.bytes }
      : {
          path,
          kind: text?.kind === "config" ? "configuration" : "other code",
          bytes: text?.bytes ?? 0,
        };
    mapBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (mapBytes > EXPLORE_LIMITS.mapBytes) break;
    map.push(entry);
  }
  const at = (location: { path: string; line: number }) => `${location.path}:${location.line}`;
  const inventory = snapshot.inventory;
  const hints = {
    entryPoints: inventory.entryPoints.map((entry) => ({
      route: `${entry.method ?? ""} ${entry.path ?? ""}`.trim(),
      at: at(entry.location),
      reaches: [...new Set(entry.reaches.map((effect) => effect.kind))],
    })),
    tools: inventory.tools.map((item) => ({
      name: redact(item.name, secrets),
      at: at(item.location),
      capabilities: item.capabilities.map((effect) => `${effect.kind} at ${at(effect.location)}`),
      ...(item.trace ? { unfollowedCalls: item.trace.locations.map(at) } : {}),
    })),
  };
  let encoded = JSON.stringify(hints);
  while (
    Buffer.byteLength(encoded) > EXPLORE_LIMITS.hintsBytes &&
    hints.tools.length + hints.entryPoints.length > 0
  ) {
    if (hints.tools.length >= hints.entryPoints.length) hints.tools.pop();
    else hints.entryPoints.pop();
    encoded = JSON.stringify(hints);
  }
  return {
    map,
    mapComplete: map.length === allowed.length,
    allowedFiles: allowed.length,
    hints,
  };
}

/** Runs the read tools for one session; every result is redacted text from the reader. */
export class ExploreTools {
  readonly #snapshot: ScanResult;
  readonly #reader: ReviewSourceReader;
  readonly #secrets: string[];
  readonly #log: ReadLog;
  readonly searches: ExploreSessionRecord["searches"] = [];
  #searchedFiles = 0;
  #searchedBytes = 0;

  constructor(snapshot: ScanResult, reader: ReviewSourceReader, secrets: string[], log: ReadLog) {
    this.#snapshot = snapshot;
    this.#reader = reader;
    this.#secrets = secrets;
    this.#log = log;
  }

  #allowed(): string[] {
    return reviewPaths(this.#snapshot)
      .filter((path) => this.#reader.exclusion(path) === null)
      .sort();
  }

  async run(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "list_files":
        return this.list(args);
      case "read_file":
        return this.read(args);
      case "search":
        return this.search(args);
      case "outline":
        return this.outline(args);
      default:
        return { error: `Unknown tool ${JSON.stringify(name.slice(0, 64))}.` };
    }
  }

  list(args: Record<string, unknown>): unknown {
    const prefix = typeof args.prefix === "string" ? args.prefix : "";
    const start = Number.parseInt(typeof args.cursor === "string" ? args.cursor : "0", 10) || 0;
    const matching = this.#allowed().filter((path) => path.startsWith(prefix));
    const page = matching.slice(start, start + EXPLORE_LIMITS.listEntries);
    const parsed = new Map(this.#snapshot.files.map((file) => [file.path, file]));
    const texts = new Map((this.#snapshot.textFiles ?? []).map((file) => [file.path, file]));
    return {
      total: matching.length,
      entries: page.map((path) => {
        const file = parsed.get(path);
        const text = texts.get(path);
        return file
          ? { path, kind: file.language, lines: file.lines, bytes: file.bytes }
          : {
              path,
              kind: text?.kind === "config" ? "configuration" : "other code",
              bytes: text?.bytes ?? 0,
            };
      }),
      next: start + page.length < matching.length ? String(start + page.length) : null,
    };
  }

  async read(args: Record<string, unknown>): Promise<unknown> {
    const path = typeof args.path === "string" ? args.path : "";
    const source = this.#reader.exclusion(path) === null ? await this.#reader.read(path) : null;
    if (source === null) return { error: NOT_ALLOWED };
    const first = integer(args.startLine) ?? 1;
    if (first > source.lineCount)
      return { path, lines: source.lineCount, error: `The file has ${source.lineCount} lines.` };
    const last = Math.min(
      source.lineCount,
      integer(args.endLine) ?? source.lineCount,
      first + EXPLORE_LIMITS.readLines - 1,
    );
    const already = this.#log.covered(path, { line: first, endLine: last });
    const lines: string[] = [];
    let bytes = 0;
    let stopped: number | null = null;
    let end = first - 1;
    for (let line = first; line <= last; line++) {
      if (already.some((range) => range.line <= line && line <= range.endLine)) {
        end = line;
        continue;
      }
      const text = `${line}: ${source.lines[line - 1] ?? ""}`;
      bytes += Buffer.byteLength(text) + 1;
      if (bytes > EXPLORE_LIMITS.readBytes) {
        stopped = line;
        break;
      }
      lines.push(text);
      end = line;
    }
    if (end >= first)
      this.#log.record(path, source.lineCount, source.digest, [{ line: first, endLine: end }]);
    return {
      path,
      lines: source.lineCount,
      digest: source.digest,
      returned: end >= first ? { line: first, endLine: end } : null,
      ...(already.length ? { alreadyInConversation: already } : {}),
      text: lines.join("\n"),
      ...(stopped !== null
        ? { stoppedAt: stopped, note: "Byte limit reached; read again from stoppedAt." }
        : {}),
      ...(end < source.lineCount && stopped === null ? { moreFrom: end + 1 } : {}),
    };
  }

  async search(args: Record<string, unknown>): Promise<unknown> {
    const query = typeof args.query === "string" ? args.query : "";
    const prefix = typeof args.prefix === "string" ? args.prefix : null;
    if (query.length < EXPLORE_LIMITS.queryMin || query.length > EXPLORE_LIMITS.queryMax)
      return {
        error: `Use a query of ${EXPLORE_LIMITS.queryMin} to ${EXPLORE_LIMITS.queryMax} characters.`,
      };
    const sensitive = args.caseSensitive === true;
    const needle = sensitive ? query : query.toLowerCase();
    const matches: { path: string; line: number; text: string }[] = [];
    let exhausted = false;
    for (const path of this.#allowed()) {
      if (prefix !== null && !path.startsWith(prefix)) continue;
      if (
        this.#searchedFiles >= EXPLORE_LIMITS.searchFiles ||
        this.#searchedBytes >= EXPLORE_LIMITS.searchBytes
      ) {
        exhausted = true;
        break;
      }
      const source = await this.#reader.read(path);
      if (source === null) continue;
      this.#searchedFiles += 1;
      this.#searchedBytes += Buffer.byteLength(source.text);
      source.lines.forEach((text, index) => {
        if (matches.length >= EXPLORE_LIMITS.searchMatches) return;
        if ((sensitive ? text : text.toLowerCase()).includes(needle))
          matches.push({ path, line: index + 1, text: text.trim().slice(0, 200) });
      });
      if (matches.length >= EXPLORE_LIMITS.searchMatches) break;
    }
    this.searches.push({ query: redact(query, this.#secrets), prefix, matches: matches.length });
    return {
      matches,
      ...(matches.length >= EXPLORE_LIMITS.searchMatches
        ? { note: "Match limit reached; narrow the query or prefix." }
        : {}),
      ...(exhausted ? { note: "The session's search budget is used up." } : {}),
    };
  }

  async outline(args: Record<string, unknown>): Promise<unknown> {
    const path = typeof args.path === "string" ? args.path : "";
    const source = this.#reader.exclusion(path) === null ? await this.#reader.read(path) : null;
    if (source === null) return { error: NOT_ALLOWED };
    const facts = await this.#reader.facts(source);
    if (facts === null)
      return { path, error: "No outline for this file type. Use read_file or search." };
    return {
      path,
      definitions: facts.definitions.slice(0, 200).map((definition) => ({
        name: definition.id,
        kind: definition.kind,
        line: definition.span.line,
        endLine: definition.span.endLine,
      })),
      imports: facts.imports
        .filter((item) => item.scope === null)
        .slice(0, 100)
        .map((item) => ({ module: item.module, line: item.span.line })),
    };
  }
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** A request was not sent: it would take the session past `stop`. */
export class ExploreLimitError extends Error {
  readonly stop: ExploreStop;
  constructor(stop: ExploreStop) {
    super(`Exploring session stopped: ${stop}.`);
    this.stop = stop;
  }
}

/** A submission the host checked, or the reason it was rejected. */
export type Submission<T> = { value: T } | { error: string };

/**
 * One phase's conversation. The model calls read tools, then the submit tool, whose
 * arguments `accept` parses and checks. One rejected submission may be corrected. When
 * a limit is near, a closing turn asks for the submission and refuses other tools. The
 * session's record is added to `records` first and stays current on every exit.
 */
export async function exploreSession<T>(options: {
  phase: ExplorePhase;
  instructions: string;
  first: unknown;
  tools: ExploreTools;
  log: ReadLog;
  accept: (args: Record<string, unknown>) => Submission<T>;
  send: (request: ModelRequest) => Promise<ModelReply>;
  /** Tokens charged to the session so far, and what it may charge in all. */
  tokens: { used: () => number; limit: number };
  records: ExploreSessionRecord[];
  /** A smaller request cap for a model with a small input window. */
  requestBytes?: number;
  /** Strict submit tools, for a provider that enforces tool schemas. */
  strict?: boolean;
  /** Each read tool call, as it runs, for a live timeline. */
  onTool?: (name: string, args: Record<string, unknown>) => void;
  signal?: AbortSignal;
}): Promise<{ value: T | null; record: ExploreSessionRecord; error?: string }> {
  const limits: SessionLimits = {
    ...EXPLORE_LIMITS[options.phase],
    requestBytes: Math.min(
      EXPLORE_LIMITS[options.phase].requestBytes,
      options.requestBytes ?? Number.POSITIVE_INFINITY,
    ),
  };
  const started = performance.now();
  const all = exploreTools(options.phase, options.strict);
  const submit = all.at(-1) as { function: { name: string } };
  // What a turn adds to its messages when reserved: tool definitions, the providers'
  // 4,096-token margin and the output allowance, at one token per byte.
  const turnOverhead = Buffer.byteLength(JSON.stringify(all)) + 4096 + EXPLORE_LIMITS.outputTokens;
  const record: ExploreSessionRecord = {
    phase: options.phase,
    stop: "failed",
    modelCalls: 0,
    toolCalls: {},
    bytesReturned: 0,
    reads: [],
    searches: [],
  };
  options.records.push(record);
  const messages: unknown[] = [
    { role: "system", content: options.instructions },
    { role: "user", content: JSON.stringify(options.first) },
  ];
  // Every turn resends the conversation, so its turns share one prompt cache.
  const conversation = randomUUID();
  let corrections = 0;
  let nudges = 0;
  let closingSent = false;
  const finish = (stop: ExploreStop, value: T | null, error?: string) => {
    record.stop = stop;
    return { value, record, ...(error === undefined ? {} : { error }) };
  };
  const nearLimit = (): ExploreStop | null => {
    if (record.modelCalls >= limits.modelCalls - 1) return "model-calls";
    if (record.bytesReturned >= limits.toolBytes) return "tool-bytes";
    const size = Buffer.byteLength(JSON.stringify(messages));
    if (size >= limits.requestBytes * 0.85) return "request-size";
    if (performance.now() - started >= limits.timeMs * 0.8) return "time";
    // The next turn and the closing turn after it must both fit.
    if (options.tokens.used() + 2 * (size + turnOverhead) > options.tokens.limit) return "tokens";
    return null;
  };
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      if (record.modelCalls >= limits.modelCalls) return finish("model-calls", null);
      if (performance.now() - started >= limits.timeMs) return finish("time", null);
      if (Buffer.byteLength(JSON.stringify(messages)) > limits.requestBytes)
        return finish("request-size", null);
      const near = nearLimit();
      if (near !== null && !closingSent) {
        closingSent = true;
        messages.push({
          role: "user",
          content: `The session is near its limit (${near}). Call ${submit.function.name} now with your answer; no other tool is available.`,
        });
      }
      let reply: ModelReply;
      try {
        // Every turn offers the same tools, so earlier tool use stays valid; the host
        // answers anything but the submit tool after the closing notice.
        reply = await options.send({ messages, tools: all, cache: conversation });
      } catch (error) {
        if (error instanceof ExploreLimitError) return finish(error.stop, null);
        // A reply cut at its output allowance is incomplete and is discarded. The
        // provider charged it, so it counts as a model call; it may happen once.
        if (reachedOutputLimit(error) && (record.cutReplies ?? 0) < EXPLORE_LIMITS.cutReplies) {
          record.modelCalls += 1;
          record.cutReplies = (record.cutReplies ?? 0) + 1;
          messages.push({
            role: "user",
            content: `Your last reply reached its output limit and was discarded. Keep the next reply short. When you call ${submit.function.name}, write brief analyses and reasons, and report only the findings the code supports best.`,
          });
          continue;
        }
        throw error;
      }
      record.modelCalls += 1;
      if (!reply.toolCalls.length) {
        messages.push({ role: "assistant", content: reply.content ?? "" });
        if (++nudges > 2)
          return finish("invalid", null, "The model answered without calling a tool.");
        messages.push({
          role: "user",
          content: `Answer by calling a tool. Finish with ${submit.function.name}.`,
        });
        continue;
      }
      messages.push({
        role: "assistant",
        content: reply.content,
        tool_calls: reply.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      });
      let accepted: T | null = null;
      let rejected: string | null = null;
      for (const [index, call] of reply.toolCalls.entries()) {
        record.toolCalls[call.name] = (record.toolCalls[call.name] ?? 0) + 1;
        let result: unknown;
        if (accepted !== null) {
          result = { error: "The submission was already accepted." };
        } else if (index >= EXPLORE_LIMITS.toolsPerTurn) {
          result = { error: `At most ${EXPLORE_LIMITS.toolsPerTurn} tool calls per turn.` };
        } else if (call.name === submit.function.name) {
          const outcome = options.accept(call.arguments);
          if ("error" in outcome) record.rejected = [...(record.rejected ?? []), outcome.error];
          if ("value" in outcome) {
            accepted = outcome.value;
            result = { accepted: true };
          } else if (++corrections > 1) {
            rejected = outcome.error;
            result = { accepted: false, errors: outcome.error };
          } else
            result = {
              accepted: false,
              errors: outcome.error,
              note: "Correct the submission once.",
            };
        } else if (near !== null) {
          result = { error: `Only ${submit.function.name} is available now.` };
        } else {
          options.onTool?.(call.name, call.arguments);
          result = await options.tools.run(call.name, call.arguments);
        }
        const content = JSON.stringify(result);
        record.bytesReturned += Buffer.byteLength(content);
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
      if (accepted !== null) return finish("submitted", accepted);
      if (rejected !== null) return finish("invalid", null, rejected);
    }
  } finally {
    record.reads = options.log.entries();
    record.searches = [...options.tools.searches];
  }
}

export { EXPLORE_STOPS };
