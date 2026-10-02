import type { Node } from "web-tree-sitter";
import type {
  AssignmentFact,
  CallFact,
  Decorator,
  DefinitionFact,
  FileFacts,
  ImportFact,
  Ref,
  Span,
  Value,
} from "./model.ts";

export const LIMITS = {
  /** Characters kept from a string literal. */
  string: 2000,
  /** Characters kept from code shown as text (callees, targets, `other` values). */
  text: 160,
  /** Items kept from a list, dict or argument list. */
  items: 50,
  /** Nesting depth of a value summary. */
  valueDepth: 6,
  /** Steps followed when resolving a name through variables and attributes. */
  resolveDepth: 16,
  /** Characters kept from a docstring. */
  doc: 1000,
};

/** The `member` of an assignment that binds a loop variable to the items of what it iterates. */
export const LOOP_ITEM = "[*]";

export type Binding =
  | { kind: "import"; ref: Ref; offset: number }
  | { kind: "definition"; definition: string; offset: number }
  /**
   * A variable bound to an expression; `path` selects a destructured member and
   * `assignment` indexes the recorded `AssignmentFact`, when there is one.
   */
  | { kind: "value"; node: Node; scope: Scope; path: string; offset: number; assignment?: number }
  | { kind: "param"; offset: number }
  /** `self`/`cls` in a Python method. */
  | { kind: "receiver"; owner: ClassInfo; offset: number }
  /** Bound to something plenger does not follow (loop variables, tuple unpacking). */
  | { kind: "unknown"; offset: number };

/** Members of one class: methods, class attributes and `self.x`/`this.x` assignments. */
export interface ClassInfo {
  definition: string;
  members: Map<string, Binding[]>;
}

export class Scope {
  readonly kind: "module" | "function" | "class";
  /** Id of the definition that opens this scope; null for the module. */
  readonly definition: string | null;
  readonly parent: Scope | null;
  /** For a class scope, the class; for a JS method or field, the class `this` refers to. */
  readonly owner: ClassInfo | null;
  readonly bindings = new Map<string, Binding[]>();

  constructor(
    kind: Scope["kind"],
    definition: string | null,
    parent: Scope | null,
    owner: ClassInfo | null = null,
  ) {
    this.kind = kind;
    this.definition = definition;
    this.parent = parent;
    this.owner = owner;
  }

  bind(name: string, binding: Binding): void {
    addBinding(this.bindings, name, binding);
  }
}

export function addBinding(map: Map<string, Binding[]>, name: string, binding: Binding): void {
  const list = map.get(name);
  if (list === undefined) map.set(name, [binding]);
  else list.push(binding);
}

/** Phase-two work for a definition: decorators and bases resolve in the enclosing scope. */
interface DefinitionDraft {
  fact: DefinitionFact;
  decorators: Node[];
  bases: Node[];
  scope: Scope;
}

interface AssignmentDraft {
  target: string;
  member: string;
  value: Node;
  scope: Scope;
  span: Span;
}

/** What each language provides to turn syntax into facts. */
export interface LanguageHooks {
  resolve(node: Node, scope: Scope, depth: number): Ref | null;
  value(node: Node, scope: Scope, depth: number): Value;
  call(node: Node, scope: Scope): CallFact;
  decorator(node: Node, scope: Scope): Decorator;
}

/**
 * Per-file state shared by the language extractors. Phase one walks the tree,
 * opening scopes and recording bindings, imports and the nodes to describe. Phase
 * two (`finish`) resolves names once every binding in the file is known.
 */
export class Context {
  readonly language: "python" | "javascript";
  readonly module = new Scope("module", null, null);
  readonly imports: ImportFact[] = [];
  readonly classes = new Map<string, ClassInfo>();
  readonly #definitions: DefinitionDraft[] = [];
  readonly #assignments: AssignmentDraft[] = [];
  readonly #calls: { node: Node; scope: Scope }[] = [];
  readonly #returns: { node: Node; scope: Scope }[] = [];
  /** JS/TS: the name `export default` refers to. */
  defaultExport: string | undefined;
  readonly #callIndex = new Map<number, number>();
  readonly #inlineDefinitions = new Map<number, string>();
  readonly #ids = new Set<string>();
  readonly #resolving = new Set<Binding>();
  readonly #resolved = new Map<Binding, Ref | null>();
  #hooks: LanguageHooks | undefined;

  constructor(language: "python" | "javascript") {
    this.language = language;
  }

  allocateId(parent: string | null, name: string | null, node: Node): string {
    const base = name ?? "<anonymous>";
    let id = parent === null ? base : `${parent}.${base}`;
    if (name === null || this.#ids.has(id)) {
      id += `@${node.startPosition.row + 1}:${node.startPosition.column + 1}`;
    }
    this.#ids.add(id);
    return id;
  }

  addDefinition(fact: DefinitionFact, scope: Scope, decorators: Node[], bases: Node[]): void {
    this.#definitions.push({ fact, decorators, bases, scope });
  }

  /** Records that an inline function or class node defines `id`, so values can point at it. */
  markInline(node: Node, id: string): void {
    this.#inlineDefinitions.set(node.id, id);
  }

  inlineDefinition(node: Node): string | undefined {
    return this.#inlineDefinitions.get(node.id);
  }

  /**
   * Records `target = value` (or `target = value.member` for destructuring) and
   * returns a binding linked to it. Callers decide where the binding lives.
   */
  assign(target: Node, value: Node, scope: Scope, offset: number, member = ""): Binding {
    const assignment = this.#assignments.length;
    this.#assignments.push({ target: textOf(target), member, value, scope, span: spanOf(target) });
    return { kind: "value", node: value, scope, path: member, offset, assignment };
  }

  /** The assignment a name refers to, when it is a variable or member with a recorded value. */
  assignmentOf(binding: Binding | undefined): number | undefined {
    return binding?.kind === "value" ? binding.assignment : undefined;
  }

  memberBinding(owner: ClassInfo, name: string): Binding | undefined {
    const bindings = owner.members.get(name);
    return bindings?.[bindings.length - 1];
  }

  addCall(node: Node, scope: Scope): void {
    this.#callIndex.set(node.id, this.#calls.length);
    this.#calls.push({ node, scope });
  }

  /** Records a value returned directly by the function that opens `scope`. */
  addReturn(node: Node, scope: Scope): void {
    if (scope.kind === "function" && scope.definition !== null) this.#returns.push({ node, scope });
  }

  callIndex(node: Node): number | undefined {
    return this.#callIndex.get(node.id);
  }

  /** Finds the binding a name refers to at `offset`, looking outward from `from`. */
  lookup(name: string, from: Scope, offset: number): Binding | undefined {
    for (let scope: Scope | null = from; scope !== null; scope = scope.parent) {
      // Class bodies are not visible from the functions nested in them.
      if (scope !== from && scope.kind === "class") continue;
      const bindings = scope.bindings.get(name);
      if (bindings === undefined) continue;
      if (scope === from) {
        let nearest: Binding | undefined;
        for (const binding of bindings) if (binding.offset <= offset) nearest = binding;
        return nearest ?? bindings[0];
      }
      // Code in an inner function usually runs after the outer scope is set up.
      return bindings[bindings.length - 1];
    }
    return undefined;
  }

  resolveName(name: string, scope: Scope, offset: number, depth: number): Ref | null {
    const binding = this.lookup(name, scope, offset);
    if (binding === undefined) return this.globalRef(name);
    return this.resolveBinding(binding, depth);
  }

  resolveBinding(binding: Binding, depth: number): Ref | null {
    switch (binding.kind) {
      case "import":
        return binding.ref;
      case "definition":
        return this.localRef(binding.definition, "");
      case "receiver":
        return this.localRef(binding.owner.definition, "()");
      case "value": {
        // Loop items are recorded for data flow; what they are is not followed.
        if (binding.path === LOOP_ITEM) return null;
        if (this.#resolved.has(binding)) return this.#resolved.get(binding) ?? null;
        if (this.#resolving.has(binding) || depth > LIMITS.resolveDepth) return null;
        this.#resolving.add(binding);
        const base = this.hooks.resolve(binding.node, binding.scope, depth + 1);
        this.#resolving.delete(binding);
        const ref = base === null || binding.path === "" ? base : this.extend(base, binding.path);
        this.#resolved.set(binding, ref);
        return ref;
      }
      default:
        return null;
    }
  }

  /** Resolves `self.name` / `this.name` against what the class assigns or defines. */
  resolveMember(owner: ClassInfo, name: string, depth: number): Ref | null {
    const binding = this.memberBinding(owner, name);
    if (binding !== undefined) return this.resolveBinding(binding, depth);
    return this.extend(this.localRef(owner.definition, "()"), name);
  }

  importRef(module: string, path: string): Ref {
    return { kind: "import", module, path, name: this.#importName(module, path) };
  }

  localRef(definition: string, path: string): Ref {
    return { kind: "local", definition, path, name: joinPath(definition, path) };
  }

  globalRef(path: string): Ref {
    return { kind: "global", path, name: path };
  }

  /** Appends member segments ("chat.completions") or a call ("()") to a ref. */
  extend(ref: Ref, segment: string): Ref {
    const path = joinPath(ref.path, segment);
    switch (ref.kind) {
      case "import":
        return this.importRef(ref.module, path);
      case "local":
        return this.localRef(ref.definition, path);
      case "global":
        return this.globalRef(path);
    }
  }

  #importName(module: string, path: string): string {
    if (path === "") return module;
    if (path.startsWith("(")) return module + path;
    if (this.language === "javascript") return `${module}#${path}`;
    return module.endsWith(".") ? module + path : `${module}.${path}`;
  }

  get hooks(): LanguageHooks {
    if (this.#hooks === undefined) throw new Error("facts context used before finish()");
    return this.#hooks;
  }

  finish(hooks: LanguageHooks): FileFacts {
    this.#hooks = hooks;
    const definitions = this.#definitions.map(({ fact, decorators, bases, scope }) => ({
      ...fact,
      decorators: decorators.map((node) => hooks.decorator(node, scope)),
      bases: bases.map((node) => hooks.value(node, scope, 0)),
    }));
    const assignments = this.#assignments.map((draft) => {
      const fact: AssignmentFact = {
        target: draft.target,
        scope: draft.scope.definition,
        value: hooks.value(draft.value, draft.scope, 0),
        span: draft.span,
      };
      if (draft.member !== "") fact.member = draft.member;
      return fact;
    });
    const calls = this.#calls.map(({ node, scope }) => hooks.call(node, scope));
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    for (const { node, scope } of this.#returns) {
      const definition = byId.get(scope.definition as string);
      if (definition === undefined) continue;
      definition.returns ??= [];
      if (definition.returns.length < 10) definition.returns.push(hooks.value(node, scope, 0));
    }
    const facts: FileFacts = { imports: this.imports, definitions, assignments, calls };
    if (this.defaultExport !== undefined) facts.defaultExport = this.defaultExport;
    return facts;
  }
}

export function joinPath(path: string, segment: string): string {
  if (segment === "") return path;
  if (path === "" || segment.startsWith("(")) return path + segment;
  return `${path}.${segment}`;
}

export function spanOf(node: Node): Span {
  return {
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Source text with whitespace collapsed, clipped for display. */
export function textOf(node: Node): string {
  return clip(node.text.replace(/\s+/g, " "), LIMITS.text);
}

export function hasChild(node: Node, type: string): boolean {
  for (const child of node.children) if (child?.type === type) return true;
  return false;
}

/** Truncates a list of values, flagging the result when items were dropped. */
export function listValue(items: Node[], build: (node: Node) => Value): Value {
  const values = items.slice(0, LIMITS.items).map(build);
  return items.length > LIMITS.items
    ? { kind: "list", items: values, truncated: true }
    : { kind: "list", items: values };
}

export function stringValue(value: string, template: Value[] | null): Value {
  const truncated = value.length > LIMITS.string;
  const result: Value = { kind: "string", value: truncated ? clip(value, LIMITS.string) : value };
  if (template !== null) result.template = template;
  if (truncated) result.truncated = true;
  return result;
}

export function otherValue(node: Node): Value {
  return { kind: "other", text: textOf(node) };
}

/** Expressions whose value comes from their operands. */
const COMPOSITE = new Set([
  // Python
  "boolean_operator",
  "binary_operator",
  "conditional_expression",
  "not_operator",
  "unary_operator",
  "subscript",
  "named_expression",
  "list_comprehension",
  "generator_expression",
  "set_comprehension",
  "dictionary_comprehension",
  // JavaScript and TypeScript
  "binary_expression",
  "ternary_expression",
  "unary_expression",
  "subscript_expression",
  "sequence_expression",
]);
const MAX_PARTS = 4;

/**
 * An expression plenger does not model, with the operands it is computed from. For a
 * comprehension, those are its element and what it iterates (`for d in docs`).
 */
export function compositeValue(node: Node, value: (operand: Node) => Value): Value {
  const other = otherValue(node);
  if (!COMPOSITE.has(node.type) || other.kind !== "other") return other;
  const operands: Node[] = [];
  for (const child of node.namedChildren) {
    if (child === null || child.type === "comment" || child.type === "if_clause") continue;
    if (child.type === "for_in_clause") {
      const right = child.childForFieldName("right");
      if (right !== null) operands.push(right);
    } else {
      operands.push(child);
    }
  }
  const parts = operands.slice(0, MAX_PARTS).map(value);
  if (parts.length > 0) other.parts = parts;
  return other;
}
