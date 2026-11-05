/**
 * Proof tests (docs/design/proof-tests.md): the records a proof worker reports and the
 * host's rules for deciding an outcome from them. No `node:` imports, so the dashboard
 * bundle can show the same types.
 */
import { isRecord } from "../shared/guards.ts";
import {
  PROOF_LIMITS,
  PROOF_WEAKNESSES,
  type ProofOutcome,
  type ProofWeakness,
} from "./constants.ts";

export type { ProofOutcome, ProofWeakness };

/** The test language a project family runs; PHP has no proof image yet. */
export type ProofFamily = "python" | "javascript";
export type ProofRuntime = "proof-python" | "proof-node";
export const PROOF_RUNTIME_OF: Record<ProofFamily, ProofRuntime> = {
  python: "proof-python",
  javascript: "proof-node",
};
/** The file name the worker gives the test, by runtime. */
export const PROOF_TEST_FILE: Record<ProofRuntime, string> = {
  "proof-python": "test_proof.py",
  "proof-node": "test_proof.mjs",
};

/** Inclusive lines of one project file, relative to the project root. */
export interface ProofRange {
  path: string;
  line: number;
  endLine: number;
}
export interface ProofFrame {
  path: string;
  line: number;
}
/** One watched operation, as the harness saw it. */
export interface ProofEffect {
  /** `file`: an operation on a path. `process`: a process start. */
  kind: "file" | "process";
  /** The audited event or wrapped function, such as `open` or `execSync`. */
  operation: string;
  /** The path, or the command and its arguments, cut to `PROOF_LIMITS.targetCharacters`. */
  target: string;
  /** The path is under a folder the harness guards. Always false for processes. */
  guarded: boolean;
  /** The process is a shell given a command string. Always false for files. */
  shell: boolean;
  /** The innermost and outermost project frames of the call; null when none ran it. */
  innermost: ProofFrame | null;
  outermost: ProofFrame | null;
}
export const PROOF_CASE_NAMES = ["intended", "weakness"] as const;
export type ProofCaseName = (typeof PROOF_CASE_NAMES)[number];
export const PROOF_CASE_STATUSES = ["passed", "failed", "error", "timeout"] as const;
/** What one test case did, from the worker's `case` frame. */
export interface ProofCase {
  name: ProofCaseName;
  /** `failed`: an assertion failed. `error`: anything else was raised. */
  status: (typeof PROOF_CASE_STATUSES)[number];
  /** `import`: the test module could not load. `test`: the case function raised. */
  failedAt: "import" | "test" | null;
  error: string | null;
  output: string;
  effects: ProofEffect[];
  /** Effects past the limit, counted but not listed. */
  effectsDropped: number;
  /** Lines of the entry and cited files that ran during the case call. */
  reached: Record<string, number[]>;
  /** Project or watched standard-library names the case changed. */
  replaced: string[];
  /** The run's command canary existed after the case. */
  canary: boolean;
}
export interface ProofRunInput {
  family: ProofFamily;
  weakness: ProofWeakness;
  sources: { path: string; content: string }[];
  /** The test file's text. */
  test: string;
  /** Where the input enters: the function bodies a proof must go through. */
  entry: ProofRange[];
  /** The finding's evidence; an effect must come from one of these files. */
  cited: ProofRange[];
}
export interface ProofRunResult {
  outcome: ProofOutcome;
  reason: string;
  /** The run's marker; absent when the host refused the test before a run. */
  marker: string | null;
  cases: ProofCase[];
  /** The effects that decided a Proven outcome. */
  evidence: ProofEffect[];
  runtime: { name: ProofRuntime; version: string; packages: Record<string, string> } | null;
  isolationChecks: string[];
}

/** `PLENGER_` and 32 hex digits, as the llmfy file canary uses. */
export const PROOF_MARKER = /^PLENGER_[a-f0-9]{32}$/;

const PYTHON_RULES: [RegExp, string][] = [
  [
    /^\s*(?:import\s+(?:[\w.]+\s*,\s*)*|from\s+)(?:subprocess|_posixsubprocess|ctypes|cffi|multiprocessing|pty|signal|importlib|gc|inspect)\b/m,
    "The test may not use process, native, import or interpreter modules.",
  ],
  [
    /\bfrom\s+os\s+import\b[^\n]*\b(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*|fork\w*|kill\w*|write|dup2?|fdopen|_exit)\b/,
    "The test may not start processes or write to file descriptors.",
  ],
  [
    /\bsys\s*\.\s*(?:addaudithook|audit|settrace|setprofile|monitoring|_getframe|modules)\b/,
    "The test may not use interpreter hooks or the module table.",
  ],
  [
    /\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*|fork\w*|kill\w*|write|dup2?|fdopen|_exit)\b/,
    "The test may not start processes or write to file descriptors.",
  ],
  [
    /\b(?:__import__|__code__|__globals__|__closure__|__builtins__|__dict__|__class__|builtins|vars|f_back|f_locals|f_globals)\b/,
    "The test may not reach interpreter internals.",
  ],
  // A file function handed to project code as a callback would run in a project frame.
  [
    /(?<![\w.])open\b|\bfrom\s+os\s+import\b|^\s*(?:import\s+(?:[\w.]+\s*,\s*)*|from\s+)(?:io|shutil|tempfile|glob)\b|\bos\s*\.\s*(?!path\b|environ\b|sep\b|getcwd\b)\w+|\.(?:read_text|read_bytes|write_text|write_bytes|unlink|rmdir|mkdir|touch|iterdir|symlink_to|hardlink_to|chmod)\b/m,
    "The test may not use file functions; use plenger.write, plenger.read and plenger.folder.",
  ],
  [/\bchdir\b|\bgetcwd\s*=/, "The test may not change the working directory."],
];
const JAVASCRIPT_RULES: [RegExp, string][] = [
  [
    /\bchild_process\b|["'](?:node:)?(?:worker_threads|cluster|inspector|inspector\/promises|vm|module|v8|repl)["']/,
    "The test may not use process, worker, inspector, vm or module APIs.",
  ],
  [
    /\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen|kill|exit|reallyExit|stdout|stderr)\b|\binternalBinding\b/,
    "The test may not use process internals.",
  ],
  [
    /\b(?:prepareStackTrace|captureStackTrace|stackTraceLimit|syncBuiltinESMExports|registerHooks)\b/,
    "The test may not change stack traces or module hooks.",
  ],
  [/\beval\s*\(|\bFunction\s*\(/, "The test may not evaluate generated code."],
  [/\bchdir\b|\bprocess\s*\.\s*cwd\s*=/, "The test may not change the working directory."],
  // A file function handed to project code as a callback would run in a project frame.
  [
    /["'](?:node:)?fs(?:\/promises)?["']/,
    "The test may not use file functions; use plenger.write, plenger.read and plenger.folder.",
  ],
];
const SHARED_RULES: [RegExp, string][] = [
  [
    /\/opt\/plenger|\/tmp\/proof\/(?:outside|effects|test|result)|\/tmp\/proof\/base-|PLENGER_|\/proc\//,
    "The test may not name the harness, its guarded folders or the marker; use the helper.",
  ],
];

/**
 * The first rule the test text breaks, as a sentence for the model, or null. A second
 * line behind attribution: it catches a test that would tamper with the harness.
 * `checkProofTestStructure` in proof-run.ts adds the top-level shape.
 */
export function proofTestRule(family: ProofFamily, text: string): string | null {
  if (new TextEncoder().encode(text).length > PROOF_LIMITS.testBytes)
    return `The test is larger than ${PROOF_LIMITS.testBytes / 1024} KiB.`;
  const rules = family === "python" ? PYTHON_RULES : JAVASCRIPT_RULES;
  for (const [pattern, message] of [...rules, ...SHARED_RULES])
    if (pattern.test(text)) return message;
  return null;
}

function within(range: ProofRange, frame: ProofFrame): boolean {
  return frame.path === range.path && frame.line >= range.line && frame.line <= range.endLine;
}

function reachedAny(ranges: ProofRange[], reached: Record<string, number[]>): boolean {
  return ranges.some((range) =>
    (reached[range.path] ?? []).some((line) => line >= range.line && line <= range.endLine),
  );
}

function firstLine(text: string | null): string {
  const line = (text ?? "").split("\n").find((item) => item.trim()) ?? "no message";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** An effect the weakness allows, carrying this run's marker. */
function relevant(weakness: ProofWeakness, marker: string, effect: ProofEffect): boolean {
  if (!effect.target.includes(marker)) return false;
  return weakness === "CWE-22"
    ? effect.kind === "file" && effect.guarded
    : effect.kind === "process" && effect.shell;
}

/**
 * The host's decision. The worker only reports what it saw; the outcome follows from
 * this run's marker, the entry and the cited files, never from the test's assertions.
 */
export function decideProof(options: {
  weakness: ProofWeakness;
  marker: string;
  entry: ProofRange[];
  cited: ProofRange[];
  cases: ProofCase[];
}): Pick<ProofRunResult, "outcome" | "reason" | "evidence"> {
  const { weakness, marker, entry, cited } = options;
  const couldNotRun = (reason: string) => ({
    outcome: "could-not-run" as const,
    reason,
    evidence: [],
  });
  const intended = options.cases.find((item) => item.name === "intended");
  const attack = options.cases.find((item) => item.name === "weakness");
  if (!intended || !attack) return couldNotRun("The run did not report both cases.");
  for (const item of [intended, attack])
    if (item.failedAt === "import")
      return couldNotRun(`The test could not load: ${firstLine(item.error)}`);
  if (attack.status === "timeout") return couldNotRun("The weakness case timed out.");
  const candidates = attack.effects.filter((effect) => relevant(weakness, marker, effect));
  const attributed = candidates.filter(
    (effect) =>
      effect.innermost !== null &&
      effect.outermost !== null &&
      cited.some((range) => range.path === effect.innermost?.path) &&
      entry.some((range) => effect.outermost !== null && within(range, effect.outermost)),
  );
  // A command canary is proof only when the injected command actually ran.
  const evidence = weakness === "CWE-78" && !attack.canary ? [] : attributed;
  const elsewhere =
    candidates.length > attributed.length
      ? " An effect with the marker came from code outside the entry or the cited files."
      : "";
  const entryReached = reachedAny(entry, attack.reached);
  // Changed code decides nothing either way: it can create an effect or suppress one.
  if (attack.replaced.length)
    return couldNotRun(
      `The test replaced ${attack.replaced.slice(0, 3).join(", ")}; a proof cannot rely on changed code.`,
    );
  if (!entryReached) return couldNotRun(`The test did not reach the entry lines.${elsewhere}`);
  if (evidence.length) {
    const [first] = evidence;
    const at = `${first?.innermost?.path}:${first?.innermost?.line}`;
    return {
      outcome: "proven",
      reason:
        weakness === "CWE-22"
          ? `${at} reached a file outside its folder (${first?.operation}).`
          : `${at} started a shell that ran the injected command.`,
      evidence,
    };
  }
  if (intended.status !== "passed")
    return couldNotRun(`The intended case ${intended.status}: ${firstLine(intended.error)}`);
  return {
    outcome: "not-reproduced",
    reason: `The entry ran and no effect came from the cited code. This is not evidence of safety.${elsewhere}`,
    evidence: [],
  };
}

function frame(value: unknown): ProofFrame | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !Number.isSafeInteger(value.line) ||
    (value.line as number) < 1
  )
    throw new Error("Invalid proof frame.");
  return { path: value.path, line: value.line as number };
}

function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit) throw new Error("Invalid proof text.");
  return value;
}

/** Validate a worker's `case` frame; anything unexpected fails the run. */
export function parseProofCase(message: Record<string, unknown>): ProofCase {
  const { name, status, failedAt } = message;
  if (!PROOF_CASE_NAMES.includes(name as ProofCaseName)) throw new Error("Invalid case name.");
  if (!PROOF_CASE_STATUSES.includes(status as ProofCase["status"]))
    throw new Error("Invalid case status.");
  if (failedAt !== null && failedAt !== "import" && failedAt !== "test")
    throw new Error("Invalid case stage.");
  const effects = message.effects;
  if (!Array.isArray(effects) || effects.length > PROOF_LIMITS.effects)
    throw new Error("Invalid case effects.");
  const reached = message.reached;
  if (!isRecord(reached)) throw new Error("Invalid reached lines.");
  let lines = 0;
  const reachedLines: Record<string, number[]> = {};
  for (const [path, list] of Object.entries(reached)) {
    if (!Array.isArray(list) || !list.every((line) => Number.isSafeInteger(line) && line > 0))
      throw new Error("Invalid reached lines.");
    lines += list.length;
    reachedLines[path] = list as number[];
  }
  if (lines > PROOF_LIMITS.reachedLines) throw new Error("Too many reached lines.");
  const replaced = message.replaced;
  if (
    !Array.isArray(replaced) ||
    replaced.length > 64 ||
    !replaced.every((item) => typeof item === "string" && item.length <= 200)
  )
    throw new Error("Invalid replaced names.");
  if (!Number.isSafeInteger(message.effectsDropped) || (message.effectsDropped as number) < 0)
    throw new Error("Invalid effect count.");
  if (typeof message.canary !== "boolean") throw new Error("Invalid canary state.");
  return {
    name: name as ProofCaseName,
    status: status as ProofCase["status"],
    failedAt,
    error: message.error === null ? null : text(message.error, PROOF_LIMITS.errorBytes),
    output: text(message.output, PROOF_LIMITS.outputBytes),
    effects: effects.map((item: unknown) => {
      if (!isRecord(item) || (item.kind !== "file" && item.kind !== "process"))
        throw new Error("Invalid effect.");
      if (
        typeof item.guarded !== "boolean" ||
        typeof item.shell !== "boolean" ||
        (item.kind === "process" && item.guarded) ||
        (item.kind === "file" && item.shell)
      )
        throw new Error("Invalid effect.");
      return {
        kind: item.kind,
        operation: text(item.operation, 64),
        target: text(item.target, PROOF_LIMITS.targetCharacters),
        guarded: item.guarded,
        shell: item.shell,
        innermost: frame(item.innermost),
        outermost: frame(item.outermost),
      };
    }),
    effectsDropped: message.effectsDropped as number,
    reached: reachedLines,
    replaced: replaced as string[],
    canary: message.canary,
  };
}

export function isProofWeakness(value: unknown): value is ProofWeakness {
  return PROOF_WEAKNESSES.includes(value as ProofWeakness);
}
