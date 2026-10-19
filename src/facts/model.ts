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
export type Ref = (
  | { kind: "import"; module: string; path: string; name: string }
  | { kind: "local"; definition: string; path: string; name: string }
  | { kind: "global"; path: string; name: string }
) &
  ProjectLinks;

/** Added by project linking (src/project) when a ref crosses into another project file. */
interface ProjectLinks {
  /** For a local ref: the project file its definition is in, when that is another file. */
  file?: string;
  /** The module-level variable of another project file the ref goes through. */
  origin?: { path: string; assignment: number };
  /** That variable's value, when it is a constant: strings, numbers, and lists and dicts of them. */
  constant?: Value;
}

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
  | {
      kind: "name";
      text: string;
      ref: Ref | null;
      param?: true;
      assignment?: number;
      /** For a member of a variable (`body.question`, `body["q"]`): the variable's assignment. */
      base?: number;
      /** For a member of a call's result (`requests.get(url).text`): index into `FileFacts.calls`. */
      of?: number;
    }
  /** Index into `FileFacts.calls`. */
  | { kind: "call"; call: number }
  /** Id of a function or class defined inline (lambda, arrow function, function expression). */
  | { kind: "function"; definition: string }
  | { kind: "list"; items: Value[]; truncated?: true }
  /** Dict or object literal; `key` is null for spreads and computed keys. */
  | { kind: "object"; entries: { key: string | null; value: Value }[]; truncated?: true }
  /**
   * Any other expression. `parts` are the values it is computed from, for operators,
   * conditionals, subscripts and comprehensions (`a or b`, `data[i]`, `[d.text for d in docs]`).
   * `subscript` marks a lookup (`CHECKS[name]`): the first part is the collection.
   */
  | { kind: "other"; text: string; parts?: Value[]; subscript?: true };

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
  /** See `CallFact.receiver`. */
  receiver?: number;
  /** Arguments when the decorator is called (`@app.post("/chat")`); null for `@tool`. */
  arguments: Argument[] | null;
  span: Span;
}

/** The name stand-in for functions and classes that have none, in definition ids and tool names. */
export const ANONYMOUS = "<anonymous>";

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
  /** Values the function returns directly (not from nested functions), at most 10. */
  returns?: Value[];
  /** Python: parameters a framework fills in from a dependency (`Depends(...)`), not from the caller. */
  injected?: string[];
  /** Python: parameters annotated with a number, boolean, UUID or date type (`id: int`). */
  scalars?: string[];
  span: Span;
}

export interface AssignmentFact {
  /** Target as written: `client`, `SYSTEM_PROMPT`, `self.client`, `module.exports`. */
  target: string;
  scope: string | null;
  value: Value;
  /** For destructuring (`const { text } = value`): the member of `value` the target receives. */
  member?: string;
  /** The code later changes the value in place (`CHECKS[k] = v`, `del CHECKS[k]`, `HOSTS.add(h)`). */
  mutated?: true;
  span: Span;
}

export interface CallFact {
  /** Callee as written, whitespace collapsed and truncated. */
  callee: string;
  ref: Ref | null;
  /** `new X()` in JS/TS. */
  new: boolean;
  /**
   * Index into `FileFacts.assignments` of the variable or `self`/`this` attribute the
   * callee is reached through (`llm` in `llm.invoke()`, `self.client` in
   * `self.client.messages.create()`), so calls on the same instance can be grouped.
   */
  receiver?: number;
  /** Id of the innermost enclosing definition; null at module level. */
  scope: string | null;
  arguments: Argument[];
  /** For a method called on a parenthesized expression (`(BASE / name).read_text()`): that expression. */
  object?: Value;
  /**
   * For an unresolved callee read from a collection (`HANDLERS[name](x)`, `TOOLS.run(x)`
   * on a dict or object, `fn = TOOLS.get(name); fn(x)`): the callee as a value, so
   * tracing can follow the functions a fixed collection holds.
   */
  lookup?: Value;
  span: Span;
}

/**
 * An `if` test that limits a value to fixed alternatives in the code it protects: the
 * rest of the block after an `if` whose body always leaves it
 * (`if name not in CHECKS: raise`), or the body of an `if` that runs only while the
 * test holds (`if (HOSTS.has(url.hostname)) { ... }`).
 */
export interface GuardFact {
  scope: string | null;
  /** The value the test limits (`name`, `url.hostname`). */
  subject: Value;
  /**
   * What the test establishes, with `allowed` as its operand. Absent: the subject is in
   * the collection `allowed`, or equals it. `matches`: it fully matches the regular
   * expression `allowed` (`re.match(r"^[a-z]+$", name)`). `excludes`: it does not
   * contain the text `allowed` (`".." not in name`). `within`: it starts with `allowed`
   * (`str(path).startswith(str(BASE) + os.sep)`). `inside`: it is a path inside
   * `allowed` component by component (`path.is_relative_to(BASE)`). `relative`: it is
   * not an absolute path (`not name.startswith("/")`, `not os.path.isabs(name)`).
   */
  test?: "matches" | "excludes" | "within" | "inside" | "relative";
  allowed: Value;
  /** The code that runs only while the limit holds. */
  region: Span;
}

export interface FileFacts {
  imports: ImportFact[];
  definitions: DefinitionFact[];
  assignments: AssignmentFact[];
  calls: CallFact[];
  /** Present when the file has any. */
  guards?: GuardFact[];
  /** JS/TS: the module-level name `export default` refers to (`default` for an anonymous one). */
  defaultExport?: string;
}
