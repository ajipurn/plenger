/**
 * Runs one proof test in its family's proof image (docs/design/proof-tests.md). The
 * host checks the test before a run, validates every frame and decides the outcome from
 * what the harness reports; the worker never decides it.
 */
import { randomBytes } from "node:crypto";
import { errorMessage, isRecord } from "../shared/guards.ts";
import { redact } from "../shared/secrets.ts";
import type { Grammar } from "../source/languages.ts";
import { SourceParser } from "../source/parser.ts";
import {
  PROOF_ISOLATION_CHECKS,
  PROOF_LIMITS,
  PROOF_RUNTIME,
  SOURCE_BYTE_CAP,
  WORKER_PROTOCOL_VERSION,
} from "./constants.ts";
import {
  decideProof,
  isProofWeakness,
  PROOF_CASE_NAMES,
  PROOF_RUNTIME_OF,
  type ProofCase,
  type ProofFamily,
  type ProofRange,
  type ProofRunInput,
  type ProofRunResult,
  type ProofRuntime,
  parseProofCase,
  proofTestRule,
} from "./proof-model.ts";
import { runWorker, type WorkerHandler } from "./worker.ts";

/** Launches the proof worker; tests pass a substitute that replays frames. */
export type ProofLauncher = (
  image: string,
  runtime: ProofRuntime,
  request: Record<string, unknown>,
  onMessage: WorkerHandler,
  signal?: AbortSignal,
) => Promise<void>;

const launchWorker: ProofLauncher = async (image, runtime, request, onMessage, signal) => {
  await runWorker(image, {
    projectRequest: request,
    runtime,
    timeoutMs: PROOF_LIMITS.runTimeoutMs,
    onMessage,
    ...(signal ? { signal } : {}),
  });
};

const SOURCE_PATH = /^[\w@+-][\w@+.-]*(?:\/[\w@+-][\w@+.-]*)*$/;
const TEST_GRAMMAR: Record<ProofFamily, Grammar> = {
  python: "python",
  javascript: "javascript",
};
const PYTHON_TOP = new Set([
  "import_statement",
  "import_from_statement",
  "future_import_statement",
  "function_definition",
  "comment",
]);
const JAVASCRIPT_TOP = new Set(["import_statement", "function_declaration", "comment"]);
const LITERALS = new Set([
  "string",
  "concatenated_string",
  "integer",
  "float",
  "number",
  "true",
  "false",
  "none",
  "null",
]);

interface SyntaxNode {
  type: string;
  text: string;
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
}

function literal(node: SyntaxNode | null): boolean {
  if (!node) return false;
  if (node.type === "template_string")
    return !node.namedChildren.some((child) => child.type === "template_substitution");
  return LITERALS.has(node.type);
}

function allowedTop(family: ProofFamily, node: SyntaxNode): boolean {
  if (family === "python") {
    if (PYTHON_TOP.has(node.type)) return true;
    if (node.type !== "expression_statement" || node.namedChildren.length !== 1) return false;
    const [child] = node.namedChildren;
    if (child?.type === "string") return true;
    // A constant: a plain name given a literal, never an attribute of a project module.
    return (
      child?.type === "assignment" &&
      child.childForFieldName("left")?.type === "identifier" &&
      literal(child.childForFieldName("right"))
    );
  }
  if (JAVASCRIPT_TOP.has(node.type)) return true;
  if (node.type === "export_statement")
    return node.childForFieldName("declaration")?.type === "function_declaration";
  if (node.type === "lexical_declaration")
    return (
      node.text.startsWith("const") &&
      node.namedChildren.every((child) => literal(child.childForFieldName("value")))
    );
  return false;
}

/**
 * The test's top level may hold imports, functions and constants of literal values
 * only. Nothing then runs between importing the project and the harness recording the
 * project's modules, so a change the test makes is seen.
 */
export async function proofTestStructure(
  family: ProofFamily,
  text: string,
): Promise<string | null> {
  const parser = await SourceParser.create();
  try {
    const tree = await parser.parse(TEST_GRAMMAR[family], text);
    try {
      if (tree.rootNode.hasError) return "The test does not parse.";
      const top = tree.rootNode.namedChildren as unknown as SyntaxNode[];
      const other = top.find((node) => !allowedTop(family, node));
      return other
        ? `The test's top level may hold only imports, functions and constants (found ${other.type}).`
        : null;
    } finally {
      tree.delete();
    }
  } finally {
    parser.dispose();
  }
}

function checkRanges(ranges: ProofRange[], paths: Set<string>, name: string): void {
  if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > PROOF_LIMITS.ranges)
    throw new Error(`A proof test needs 1 to ${PROOF_LIMITS.ranges} ${name} ranges.`);
  for (const range of ranges)
    if (
      !paths.has(range.path) ||
      !Number.isSafeInteger(range.line) ||
      !Number.isSafeInteger(range.endLine) ||
      range.line < 1 ||
      range.endLine < range.line
    )
      throw new Error(`Invalid ${name} range.`);
}

/** Programming errors, not outcomes: the caller built an input the worker would refuse. */
export function validateProofInput(input: ProofRunInput): void {
  if (!isProofWeakness(input.weakness))
    throw new Error(`Proof tests do not support ${String(input.weakness)}.`);
  if (!(input.family in PROOF_RUNTIME_OF)) throw new Error("Unsupported proof family.");
  const paths = new Set<string>();
  let bytes = 0;
  for (const source of input.sources) {
    if (
      !SOURCE_PATH.test(source.path) ||
      source.path.split("/").some((part) => part.startsWith(".")) ||
      source.path === "node_modules" ||
      paths.has(source.path)
    )
      throw new Error(`Invalid proof source path ${JSON.stringify(source.path.slice(0, 80))}.`);
    paths.add(source.path);
    bytes += Buffer.byteLength(source.content);
  }
  if (!paths.size) throw new Error("A proof test needs the project's sources.");
  if (bytes > SOURCE_BYTE_CAP) throw new Error("The proof sources exceed 4 MiB.");
  checkRanges(input.entry, paths, "entry");
  checkRanges(input.cited, paths, "cited");
}

function parseReady(
  runtime: ProofRuntime,
  message: Record<string, unknown>,
): Pick<ProofRunResult, "runtime" | "isolationChecks"> {
  const expected = PROOF_ISOLATION_CHECKS[runtime];
  const checks = message.isolationChecks;
  const version = runtime === "proof-python" ? message.python : message.node;
  const wanted = runtime === "proof-python" ? PROOF_RUNTIME.python : PROOF_RUNTIME.node;
  const packages = message.packages;
  if (
    message.protocolVersion !== WORKER_PROTOCOL_VERSION ||
    version !== wanted ||
    !Array.isArray(checks) ||
    checks.length !== expected.length ||
    !expected.every((name) => checks.includes(name)) ||
    !isRecord(packages) ||
    Object.keys(packages).length > 64 ||
    !Object.values(packages).every((item) => typeof item === "string" && item.length <= 64)
  )
    throw new Error("The proof worker's ready frame did not match its image.");
  return {
    runtime: { name: runtime, version: wanted, packages: packages as Record<string, string> },
    isolationChecks: checks as string[],
  };
}

function redactCase(item: ProofCase): ProofCase {
  return {
    ...item,
    output: redact(item.output),
    error: item.error === null ? null : redact(item.error),
  };
}

/**
 * Run the test once against the given sources. Cancellation rethrows; every other
 * failure is a Could not run result with the reason.
 */
export async function runProofTest(
  image: string,
  input: ProofRunInput,
  options: { signal?: AbortSignal; launch?: ProofLauncher } = {},
): Promise<ProofRunResult> {
  validateProofInput(input);
  const runtime = PROOF_RUNTIME_OF[input.family];
  const refused =
    proofTestRule(input.family, input.test) ?? (await proofTestStructure(input.family, input.test));
  const empty = { cases: [], evidence: [], runtime: null, isolationChecks: [] };
  if (refused)
    return {
      ...empty,
      outcome: "could-not-run",
      reason: `The host refused the test. ${refused}`,
      marker: null,
    };
  const marker = `PLENGER_${randomBytes(16).toString("hex")}`;
  const cases: ProofCase[] = [];
  let ready: Pick<ProofRunResult, "runtime" | "isolationChecks"> | null = null;
  let finished = false;
  const handler: WorkerHandler = async (message) => {
    if (!isRecord(message) || finished) throw new Error("Unexpected proof frame.");
    if (ready === null) {
      if (message.type !== "ready") throw new Error("The proof worker did not start.");
      ready = parseReady(runtime, message);
      return undefined;
    }
    if (message.type === "case") {
      const item = parseProofCase(message);
      if (item.name !== PROOF_CASE_NAMES[cases.length]) throw new Error("Proof case out of order.");
      cases.push(item);
      return undefined;
    }
    if (message.type === "finished" && message.completed === true && cases.length === 2) {
      finished = true;
      return undefined;
    }
    throw new Error("Unexpected proof frame.");
  };
  const request = {
    sources: input.sources,
    test: input.test,
    entry: input.entry,
    cited: input.cited,
    weakness: input.weakness,
    marker,
  };
  let failure: string | null = null;
  try {
    await (options.launch ?? launchWorker)(image, runtime, request, handler, options.signal);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    failure = errorMessage(error);
  }
  const reported = cases.map(redactCase);
  const started = (ready ?? { runtime: null, isolationChecks: [] }) as Pick<
    ProofRunResult,
    "runtime" | "isolationChecks"
  >;
  if (failure !== null || !finished)
    return {
      ...empty,
      ...started,
      cases: reported,
      outcome: "could-not-run",
      reason: `The test container failed: ${redact(failure ?? "it ended early")}`,
      marker,
    };
  const decided = decideProof({
    weakness: input.weakness,
    marker,
    entry: input.entry,
    cited: input.cited,
    cases,
  });
  return { ...decided, ...started, marker, cases: reported };
}
