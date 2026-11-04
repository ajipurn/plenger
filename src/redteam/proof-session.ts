/**
 * The proof session (M11b, docs/design/proof-tests.md): a model reads the project with
 * the review's read tools, writes a proof test and runs it through `run_test` until a
 * run is Proven, it gives up or a limit is reached. Every outcome comes from the host's
 * rules in `decideProof`; the model's own words decide nothing.
 */
import { randomUUID } from "node:crypto";
import { BudgetStoppedError } from "./budget.ts";
import {
  PROOF_PACKAGES,
  PROOF_SESSION_LIMITS,
  type ProofOutcome,
  type ProofSessionStop,
} from "./constants.ts";
import type { ProofEntries } from "./proof-entry.ts";
import {
  PROOF_RUNTIME_OF,
  PROOF_TEST_FILE,
  type ProofFamily,
  type ProofRange,
  type ProofRunInput,
  type ProofRunResult,
  type ProofWeakness,
} from "./proof-model.ts";
import { runProofTest } from "./proof-run.ts";
import { type ModelReply, type ModelRequest, reachedOutputLimit } from "./provider.ts";

/** The finding a session tries to prove, as the review reported it. */
export interface ProofFinding {
  title: string;
  weakness: ProofWeakness;
  summary: string;
  attackPath: string;
  validation: string;
  evidence: { path: string; line: number; endLine: number; snippet: string }[];
}

/**
 * Read tools the caller supplies, such as the review's `list_files`, `read_file`,
 * `search` and `outline`. `redteam` does not import the review, so they come in here.
 * Every result must already be redacted.
 */
export interface ProofReadTools {
  definitions: unknown[];
  run(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ProofSessionRun {
  test: string;
  result: ProofRunResult;
}

export interface ProofSessionRecord {
  stop: ProofSessionStop;
  modelCalls: number;
  toolCalls: Record<string, number>;
  /** The `give_up` reason, cut to `PROOF_SESSION_LIMITS.reasonCharacters`. */
  gaveUp?: string;
  cutReplies?: number;
  durationMs: number;
}

export interface ProofSessionResult {
  outcome: ProofOutcome;
  reason: string;
  /** The deciding run: the first Proven one, or else the last. Null when nothing ran. */
  deciding: ProofSessionRun | null;
  runs: ProofSessionRun[];
  record: ProofSessionRecord;
}

export interface ProofSessionOptions {
  image: string;
  family: ProofFamily;
  finding: ProofFinding;
  /** From `proofEntries`; a session needs at least one range. */
  entries: ProofEntries;
  cited: ProofRange[];
  sources: ProofRunInput["sources"];
  /** Redacted, line-numbered text of the entry and cited files for the first message. */
  files: { path: string; text: string }[];
  tools: ProofReadTools;
  send: (request: ModelRequest) => Promise<ModelReply>;
  /** Tokens charged to the session so far, and what it may charge in all. */
  tokens: { used: () => number; limit: number };
  /** Runs one test; tests pass a substitute. Defaults to `runProofTest` on `image`. */
  run?: (input: ProofRunInput, signal?: AbortSignal) => Promise<ProofRunResult>;
  signal?: AbortSignal;
}

const HELPERS: Record<ProofFamily, string> = {
  python: `Write Python. The file defines test_intended(plenger) and test_weakness(plenger); either may be async. Import project modules by their path from the project root (\`import tools\`, \`from app.main import app\`). The helper: plenger.base() is the test's folder and the working directory; plenger.folder(name), plenger.write(name, text) and plenger.read(name) make, write and read files under it; plenger.canary() is a file in a guarded folder outside base(); plenger.sibling_canary() is one in a guarded sibling folder whose name starts with base()'s; plenger.shell_payloads() lists strings to append to an ordinary value, each of which injects a command if a shell runs it.`,
  javascript: `Write a JavaScript ES module. It exports async functions testIntended(plenger) and testWeakness(plenger). Import project files by absolute path under /tmp/project (\`import app from "/tmp/project/server.ts"\`); TypeScript loads directly. Start an Express app with app.listen(0, "127.0.0.1") and call it with fetch; the loopback works, nothing else does. The helper: plenger.base() is the test's folder and the working directory; plenger.folder(name), plenger.write(name, text) and plenger.read(name) make, write and read files under it; plenger.canary() is a file in a guarded folder outside base(); plenger.siblingCanary() is one in a guarded sibling folder whose name starts with base()'s; plenger.shellPayloads() lists strings to append to an ordinary value, each of which injects a command if a shell runs it.`,
};

const ORACLES: Record<ProofWeakness, string> = {
  "CWE-22":
    "Path traversal is Proven when project code opens, lists, creates, writes, renames or deletes a path under a guarded folder. Pass the canary path, or a relative path that climbs to it, as the input the finding names. An attempt counts even if the file is missing.",
  "CWE-78":
    "Command injection is Proven when project code starts a shell whose command carries one of the payloads and the injected command runs. Append a payload to an ordinary value of the input the finding names.",
};

function instructions(family: ProofFamily, weakness: ProofWeakness): string {
  return [
    "You write one proof test for a security finding that a review supported with source. Plenger runs it against a read-only copy of the project in a container without network, and a harness watches what the project code does. The host decides the outcome from what the harness saw, never from your assertions or your words.",
    ORACLES[weakness],
    "The effect counts only when it comes from the project code the finding cites, reached by calling the entry: the route handler, tool or function given in the first message. Calling an inner helper directly does not count, because the entry may hold the check. A route is called through its framework's test client or a local server; a tool through its own call method.",
    "test_intended (testIntended) calls the entry with ordinary input and asserts the ordinary result. test_weakness (testWeakness) calls it with the input the finding names. Not reproduced needs the intended case to pass and the entry to run.",
    HELPERS[family],
    `The image has these packages and the standard library only: ${PROOF_PACKAGES[PROOF_RUNTIME_OF[family]].join(", ")}. Replace network calls of a package (requests.get, fetch) with fakes that return the input the finding names.`,
    "The test may not start processes, use file functions (use the helper), use interpreter, import or stack-trace hooks, or name the harness's folders or the marker. Its top level holds only imports, functions and constants of literal values. It may point a project setting or environment variable at a folder under plenger.base(), and nowhere else. It may not change project functions, the standard library or built-ins; any such change makes the run Could not run.",
    `Read the code with the read tools, then call run_test with the whole file. Each result gives the outcome, the reason and what the harness observed. Fix the test and run it again if it did not reach the entry or failed for a reason of its own. At most ${PROOF_SESSION_LIMITS.runs} runs. Call give_up with a short reason when the finding cannot show under these conditions: the code is safe after all, it needs a package or service the image lacks, or it only fails on another system.`,
  ].join("\n\n");
}

function tool(name: string, description: string, properties: Record<string, unknown>) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties,
        required: Object.keys(properties),
      },
    },
  };
}

function sessionTools(family: ProofFamily, read: ProofReadTools): unknown[] {
  return [
    ...read.definitions,
    tool(
      "run_test",
      `Run the whole ${PROOF_TEST_FILE[PROOF_RUNTIME_OF[family]]} test file once and return what the harness observed.`,
      { source: { type: "string", description: "The complete test file." } },
    ),
    tool("give_up", "End the session without a Proven run, and say why.", {
      reason: {
        type: "string",
        maxLength: PROOF_SESSION_LIMITS.reasonCharacters,
        description: "One or two sentences.",
      },
    }),
  ];
}

function cut(text: string | null): string | null {
  if (text === null) return null;
  const bytes = Buffer.byteLength(text);
  if (bytes <= PROOF_SESSION_LIMITS.caseTextBytes) return text;
  // The end of the output holds the error, so keep the tail.
  const tail = Buffer.from(text).subarray(bytes - PROOF_SESSION_LIMITS.caseTextBytes);
  return `…${tail.toString("utf8")}`;
}

/** A run as the model sees it: no marker, output cut to its tail. */
function observed(result: ProofRunResult, runsLeft: number): unknown {
  return {
    outcome: result.outcome,
    reason: result.reason,
    runsLeft,
    cases: result.cases.map((item) => ({
      name: item.name,
      status: item.status,
      error: cut(item.error),
      output: cut(item.output),
      reached: item.reached,
      effects: item.effects.map((effect) => ({
        kind: effect.kind,
        operation: effect.operation,
        shell: effect.shell,
        at: effect.innermost && `${effect.innermost.path}:${effect.innermost.line}`,
        through: effect.outermost && `${effect.outermost.path}:${effect.outermost.line}`,
      })),
      ...(item.replaced.length ? { replaced: item.replaced } : {}),
    })),
  };
}

/** The first Proven run, or else the last one. */
function decidingRun(runs: ProofSessionRun[]): ProofSessionRun | null {
  return runs.find((item) => item.result.outcome === "proven") ?? runs.at(-1) ?? null;
}

const STOP_REASONS: Record<Exclude<ProofSessionStop, "proven">, string> = {
  "gave-up": "The model gave up",
  runs: `The session used its ${PROOF_SESSION_LIMITS.runs} runs`,
  "model-calls": `The session reached ${PROOF_SESSION_LIMITS.modelCalls} model calls`,
  time: "The session ran out of time",
  tokens: "The session reached its token limit",
  "request-size": "The conversation grew past its size limit",
  invalid: "The model stopped calling tools",
  refused: "The provider refused the request",
};

/**
 * Run one session. Cancellation rethrows; a provider failure rethrows too, since the
 * caller owns the connection. Every other end is a result.
 */
export async function proofSession(options: ProofSessionOptions): Promise<ProofSessionResult> {
  if (!options.entries.ranges.length)
    throw new Error("A proof session needs an entry; check proofEntries first.");
  const started = performance.now();
  const limits = PROOF_SESSION_LIMITS;
  const runTest =
    options.run ??
    ((input: ProofRunInput, signal?: AbortSignal) =>
      runProofTest(options.image, input, signal ? { signal } : {}));
  const tools = sessionTools(options.family, options.tools);
  const turnOverhead = Buffer.byteLength(JSON.stringify(tools)) + 4096 + limits.outputTokens;
  const record: ProofSessionRecord = {
    stop: "invalid",
    modelCalls: 0,
    toolCalls: {},
    durationMs: 0,
  };
  const runs: ProofSessionRun[] = [];
  const messages: unknown[] = [
    { role: "system", content: instructions(options.family, options.finding.weakness) },
    {
      role: "user",
      content: JSON.stringify({
        finding: options.finding,
        entry: {
          ranges: options.entries.ranges,
          note:
            options.entries.via === "public-function"
              ? "The project has no route or tool; the entry is the public function that holds the cited code."
              : "The handlers of the routes or tools whose traced effects reach the cited code.",
        },
        files: options.files,
        testFile: PROOF_TEST_FILE[PROOF_RUNTIME_OF[options.family]],
      }),
    },
  ];
  const conversation = randomUUID();
  let nudges = 0;
  let closingSent = false;
  const finish = (stop: ProofSessionStop): ProofSessionResult => {
    record.stop = stop;
    record.durationMs = Math.round(performance.now() - started);
    const deciding = decidingRun(runs);
    if (deciding)
      return {
        outcome: deciding.result.outcome,
        reason: deciding.result.reason,
        deciding,
        runs,
        record,
      };
    const why = stop === "proven" ? "" : STOP_REASONS[stop];
    return {
      outcome: "could-not-run",
      reason: `${why} before any test ran.${record.gaveUp ? ` ${record.gaveUp}` : ""}`,
      deciding: null,
      runs,
      record,
    };
  };
  const nearLimit = (): ProofSessionStop | null => {
    if (record.modelCalls >= limits.modelCalls - 1) return "model-calls";
    if (runs.length >= limits.runs) return "runs";
    const size = Buffer.byteLength(JSON.stringify(messages));
    if (size >= limits.requestBytes * 0.85) return "request-size";
    if (performance.now() - started >= limits.timeMs * 0.8) return "time";
    if (options.tokens.used() + 2 * (size + turnOverhead) > options.tokens.limit) return "tokens";
    return null;
  };
  for (;;) {
    options.signal?.throwIfAborted();
    if (record.modelCalls >= limits.modelCalls) return finish("model-calls");
    if (performance.now() - started >= limits.timeMs) return finish("time");
    const size = Buffer.byteLength(JSON.stringify(messages));
    if (size > limits.requestBytes) return finish("request-size");
    if (options.tokens.used() + size + turnOverhead > options.tokens.limit) return finish("tokens");
    const near = nearLimit();
    if (near === "runs") return finish("runs");
    if (near !== null && !closingSent) {
      closingSent = true;
      messages.push({
        role: "user",
        content: `The session is near its limit (${near}). Call run_test once more with your best test, or give_up.`,
      });
    }
    let reply: ModelReply;
    try {
      reply = await options.send({ messages, tools, cache: conversation });
    } catch (error) {
      // The connection's budget can stop a request the session's own estimate let through.
      if (error instanceof BudgetStoppedError && error.reason !== "cancelled")
        return finish(
          error.reason === "token-limit"
            ? "tokens"
            : error.reason === "model-call-limit"
              ? "model-calls"
              : "time",
        );
      if (reachedOutputLimit(error) && (record.cutReplies ?? 0) < limits.cutReplies) {
        record.modelCalls += 1;
        record.cutReplies = (record.cutReplies ?? 0) + 1;
        messages.push({
          role: "user",
          content:
            "Your last reply reached its output limit and was discarded. Keep the test short.",
        });
        continue;
      }
      throw error;
    }
    record.modelCalls += 1;
    if (reply.refusal !== undefined) return finish("refused");
    if (!reply.toolCalls.length) {
      messages.push({ role: "assistant", content: reply.content ?? "" });
      if (++nudges > 2) return finish("invalid");
      messages.push({ role: "user", content: "Answer by calling a tool: run_test or give_up." });
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
    let stop: ProofSessionStop | null = null;
    for (const [index, call] of reply.toolCalls.entries()) {
      record.toolCalls[call.name] = (record.toolCalls[call.name] ?? 0) + 1;
      let result: unknown;
      if (stop !== null) result = { error: "The session has ended." };
      else if (index >= limits.toolsPerTurn)
        result = { error: `At most ${limits.toolsPerTurn} tool calls per turn.` };
      else if (call.name === "give_up") {
        const reason = typeof call.arguments.reason === "string" ? call.arguments.reason : "";
        record.gaveUp = reason.slice(0, limits.reasonCharacters);
        stop = "gave-up";
        result = { ended: true };
      } else if (call.name === "run_test") {
        const source = call.arguments.source;
        if (typeof source !== "string" || !source.trim())
          result = { error: "Pass the whole test file as source." };
        else if (runs.length >= limits.runs) result = { error: "No runs are left. Call give_up." };
        else {
          const run = await runTest(
            {
              family: options.family,
              weakness: options.finding.weakness,
              sources: options.sources,
              test: source,
              entry: options.entries.ranges,
              cited: options.cited,
            },
            options.signal,
          );
          runs.push({ test: source, result: run });
          result = observed(run, limits.runs - runs.length);
          if (run.outcome === "proven") stop = "proven";
        }
      } else if (near !== null) result = { error: "Only run_test and give_up are available now." };
      else result = await options.tools.run(call.name, call.arguments);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
    if (stop !== null) return finish(stop);
    if (runs.length >= limits.runs) return finish("runs");
  }
}
