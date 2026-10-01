/**
 * Code facts: what one source file imports, defines, assigns and calls, with call
 * targets resolved through imports, local definitions, variables and `self`/`this`
 * attributes. Facts are syntactic and file-local; they never claim runtime behaviour.
 */

/** 1-based lines; 1-based columns counted in UTF-16 code units (the SARIF default). */
export interface Span {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/**
 * Where a name or call target comes from. `path` is the member path after the
 * module, definition or global, with "()" marking a call result. `name` is the
 * canonical form detectors match on:
 *
 * - Python import: dotted, e.g. `openai.OpenAI().chat.completions.create`
 * - JS/TS import: module, then `#` and the path, e.g. `openai#default().chat.completions.create`,
 *   `ai#generateText`; a path that starts with a call joins without `#`: `@anthropic-ai/sdk()`
 * - local: the definition id and path, e.g. `Agent().run`
 * - global: e.g. `fetch`, `eval`, `process.env.OPENAI_API_KEY`
 */
export type Ref =
  | { kind: "import"; module: string; path: string; name: string }
  | { kind: "local"; definition: string; path: string; name: string }
  | { kind: "global"; path: string; name: string };

/** A bounded summary of an expression. */
export type Value =
  /** String literal, f-string or template literal; interpolations appear in `template` in order. */
  | { kind: "string"; value: string; template?: Value[]; truncated?: true }
  /** String concatenation with `+`. */
  | { kind: "concat"; parts: Value[] }
  | { kind: "literal"; text: string }
  /**
   * Identifier or member access. `param` marks a root that is a parameter of the
   * enclosing function; `assignment` indexes `FileFacts.assignments` when the name is
   * a variable or `self`/`this` member whose value plenger recorded.
   */
  | { kind: "name"; text: string; ref: Ref | null; param?: true; assignment?: number }
  /** Index into `FileFacts.calls`. */
  | { kind: "call"; call: number }
  /** Id of a function or class defined inline (lambda, arrow function, function expression). */
  | { kind: "function"; definition: string }
  | { kind: "list"; items: Value[]; truncated?: true }
  /** Dict or object literal; `key` is null for spreads and computed keys. */
  | { kind: "object"; entries: { key: string | null; value: Value }[]; truncated?: true }
  | { kind: "other"; text: string };

export interface Argument {
  /** Python keyword argument name; null for positional arguments. */
  keyword: string | null;
  /** `*args`, `**kwargs` or `...spread`. */
  spread?: true;
  value: Value;
}

export interface ImportFact {
  /** Module as written: `openai`, `langchain_core.tools`, `.tools`, `@ai-sdk/openai`, `./tools.js`. */
  module: string;
  /** Imported member, `default` for JS default imports; null when the module itself is bound. */
  imported: string | null;
  /** Local name bound; null for side-effect, wildcard and re-export imports. */
  local: string | null;
  kind:
    | "module"
    | "member"
    | "default"
    | "namespace"
    | "wildcard"
    | "side_effect"
    | "require"
    | "dynamic"
    | "reexport";
  typeOnly: boolean;
  /** Definition id when the import is inside a function or class; null at module level. */
  scope: string | null;
  span: Span;
}

export interface Decorator {
  text: string;
  ref: Ref | null;
  /** Arguments when the decorator is called (`@app.post("/chat")`); null for `@tool`. */
  arguments: Argument[] | null;
  span: Span;
}

export interface DefinitionFact {
  /** Unique within the file: qualified name (`Agent.run`), with `@line:column` added for anonymous or repeated names. */
  id: string;
  /** Null for anonymous functions. Functions assigned to a variable or property take that name. */
  name: string | null;
  kind: "function" | "method" | "class";
  parent: string | null;
  async: boolean;
  /** JS/TS: exported from the module. Python: defined at module level without a leading underscore. */
  exported: boolean;
  params: string[];
  decorators: Decorator[];
  /** Base classes (`class A(B)`, `class A extends B`). */
  bases: Value[];
  /** Python docstring, truncated. */
  doc: string | null;
  span: Span;
}

export interface AssignmentFact {
  /** Target as written: `client`, `SYSTEM_PROMPT`, `self.client`, `module.exports`. */
  target: string;
  scope: string | null;
  value: Value;
  /** For destructuring (`const { text } = value`): the member of `value` the target receives. */
  member?: string;
  span: Span;
}

export interface CallFact {
  /** Callee as written, whitespace collapsed and truncated. */
  callee: string;
  ref: Ref | null;
  /** `new X()` in JS/TS. */
  new: boolean;
  /** Id of the innermost enclosing definition; null at module level. */
  scope: string | null;
  arguments: Argument[];
  span: Span;
}

export interface FileFacts {
  imports: ImportFact[];
  definitions: DefinitionFact[];
  assignments: AssignmentFact[];
  calls: CallFact[];
}
