import type { Node } from "web-tree-sitter";
import {
  addBinding,
  type Binding,
  type ClassInfo,
  Context,
  clip,
  compositeValue,
  hasChild,
  type LanguageHooks,
  LIMITS,
  type Limit,
  LOOP_ITEM,
  listValue,
  otherValue,
  Scope,
  spanOf,
  stringValue,
  textOf,
} from "./core.ts";
import type {
  Argument,
  CallFact,
  Decorator,
  DefinitionFact,
  FileFacts,
  Ref,
  Value,
} from "./model.ts";

export function extractPython(root: Node): FileFacts {
  const extractor = new PythonExtractor();
  extractor.visitChildren(root, extractor.cx.module);
  return extractor.cx.finish(extractor);
}

const LITERALS = new Set(["integer", "float", "true", "false", "none", "ellipsis"]);
/** Returned values that are always false. */
const FALSY = /^(?:False|None|0|""|'')$/;
const PATTERN_TARGETS = new Set(["pattern_list", "tuple_pattern", "list_pattern", "tuple", "list"]);
/** Statements that leave the enclosing block. */
const EXITS = new Set([
  "return_statement",
  "raise_statement",
  "continue_statement",
  "break_statement",
]);

/**
 * The values an `if` test limits while it is `truth`: `x in S` and `x == "a"` when it
 * holds, `x not in S` and `x != "a"` when it fails, `re.match(P, x)` and
 * `x.startswith(BASE)` when they hold, `".." in x` and `x.startswith("/")` when they
 * fail, through `not`,
 * parentheses, `and` (holding) and `or` (failing).
 */
function limits(node: Node, truth: boolean): Limit[] {
  switch (node.type) {
    case "parenthesized_expression": {
      const inner = node.namedChildren[0];
      return inner == null ? [] : limits(inner, truth);
    }
    case "not_operator": {
      const argument = node.childForFieldName("argument");
      return argument === null ? [] : limits(argument, !truth);
    }
    case "boolean_operator": {
      const operator = node.childForFieldName("operator")?.type;
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left === null || right === null) return [];
      return (operator === "and" && truth) || (operator === "or" && !truth)
        ? [...limits(left, truth), ...limits(right, truth)]
        : [];
    }
    case "comparison_operator": {
      const operands = node.namedChildren.filter((child): child is Node => child !== null);
      const operators = node.childrenForFieldName("operators");
      const [left, right] = operands;
      if (operands.length !== 2 || operators.length !== 1 || !left || !right) return [];
      const operator = operators[0]?.type;
      // `".." in name` failing: the name does not contain that text.
      if (
        left.type === "string" &&
        ((operator === "in" && !truth) || (operator === "not in" && truth))
      )
        return [{ subject: right, allowed: left, test: "excludes" }];
      // `rel != ".."` holding: the value is not that text.
      if (
        right.type === "string" &&
        ((operator === "!=" && truth) || (operator === "==" && !truth))
      )
        return [{ subject: left, allowed: right, test: "differs" }];
      const holds =
        ((operator === "in" || operator === "==") && truth) ||
        ((operator === "not in" || operator === "!=") && !truth);
      if (!holds) return [];
      if (operator === "in" || operator === "not in") return [{ subject: left, allowed: right }];
      return LITERALS.has(left.type) || left.type === "string"
        ? [{ subject: right, allowed: left }]
        : [{ subject: left, allowed: right }];
    }
    case "call": {
      const callee = node.childForFieldName("function");
      const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter(
        (arg): arg is Node => arg !== null && arg.type !== "comment",
      );
      const object = callee?.type === "attribute" ? callee.childForFieldName("object") : null;
      const method = callee?.childForFieldName("attribute")?.text;
      // `is_within(BASE, path)` holding: what the function checks, read later.
      const helper: Limit[] = truth ? [{ subject: node, allowed: node, test: "call" }] : [];
      if (object === null || object === undefined)
        return callee?.type === "identifier" ? helper : [];
      // `name.startswith("/")` or `os.path.isabs(name)` failing: a relative path.
      const [first] = args;
      if (!truth && first !== undefined && args.length === 1) {
        if (method === "startswith" && /^["'][/\\]+["']$/.test(first.text))
          return [{ subject: object, allowed: first, test: "relative" }];
        // `rel.startswith("..")` failing: a relative path that does not climb out.
        if (method === "startswith" && /^f?["']\.\.(?:[/\\]|\{os\.sep\})?["']$/.test(first.text))
          return [{ subject: object, allowed: first, test: "descends" }];
        if (callee?.text === "os.path.isabs")
          return [{ subject: first, allowed: first, test: "relative" }];
      }
      if (!truth) return [];
      // `name.endswith(".json")`
      if (method === "endswith" && args.length === 1 && first?.type === "string")
        return [{ subject: object, allowed: first, test: "ends" }];
      // `re.match(PATTERN, name)`, `PATTERN.fullmatch(name)`
      const [pattern, value] = args;
      const test = method === "fullmatch" ? "fullmatches" : "matches";
      if (object.text === "re" && REGEX_TESTS.has(method ?? "") && pattern && value)
        return [{ subject: value, allowed: pattern, test }];
      if (REGEX_TESTS.has(method ?? "") && method !== "search" && args.length === 1 && pattern)
        return [{ subject: pattern, allowed: object, test }];
      // `str(path).startswith(str(BASE) + os.sep)`, `path.is_relative_to(BASE)`
      if ((method === "startswith" || method === "is_relative_to") && args.length === 1 && pattern)
        return [
          {
            subject: unwrapStr(object),
            allowed: unwrapStr(pattern),
            test: method === "startswith" ? "within" : "inside",
          },
        ];
      return helper;
    }
    default:
      return [];
  }
}

const REGEX_TESTS = new Set(["match", "fullmatch", "search"]);

/** Calls that never return: `abort(400)` in Flask, `sys.exit()`. */
const EXIT_CALLS =
  /^(?:(?:flask|werkzeug\.exceptions)\.)?abort$|^(?:sys\.|os\._)?exit$|^os\._exit$/;

/** Whether a statement leaves its block: `return`, `raise`, `continue`, `break`, or a call that never returns. */
function leaves(statement: Node): boolean {
  if (EXITS.has(statement.type)) return true;
  const expression = statement.type === "expression_statement" ? statement.namedChildren[0] : null;
  const callee =
    expression?.type === "call" ? expression.childForFieldName("function")?.text : undefined;
  return callee !== undefined && EXIT_CALLS.test(callee);
}

/** Whether a block's last statement leaves it. */
function exits(block: Node | null | undefined): boolean {
  const last = block?.namedChildren.filter((child) => child?.type !== "comment").at(-1);
  return last != null && leaves(last);
}

/**
 * The block whose rest an exiting `if` protects: the one it is in, or, when that is the
 * body of a `try` whose handlers all exit too, the block around the `try`.
 */
function protectedBlock(node: Node): Node | null {
  let block = node.parent;
  for (let owner = block?.parent; owner?.type === "try_statement"; owner = block?.parent) {
    if (owner.childForFieldName("body")?.id !== block?.id) break;
    const handlers = owner.namedChildren.filter(
      (child) => child?.type === "except_clause" || child?.type === "except_group_clause",
    );
    if (!handlers.every((handler) => exits(handler?.namedChildren.at(-1)))) break;
    block = owner.parent;
  }
  return block;
}

/** `x` for `str(x)`, the node itself otherwise. */
function unwrapStr(node: Node): Node {
  const args = node.childForFieldName("arguments")?.namedChildren ?? [];
  return node.type === "call" &&
    node.childForFieldName("function")?.text === "str" &&
    args.length === 1 &&
    args[0] != null
    ? args[0]
    : node;
}

class PythonExtractor implements LanguageHooks {
  readonly cx = new Context("python");

  // Phase one: scopes, bindings and the nodes to describe.

  visitChildren(node: Node, scope: Scope): void {
    for (const child of node.namedChildren) if (child !== null) this.visit(child, scope);
  }

  visit(node: Node, scope: Scope): void {
    switch (node.type) {
      case "import_statement":
        this.importStatement(node, scope);
        return;
      case "import_from_statement":
        this.importFrom(node, scope);
        return;
      case "future_import_statement":
        return;
      case "decorated_definition": {
        const decorators = node.namedChildren.filter((child) => child?.type === "decorator");
        const definition = node.childForFieldName("definition");
        if (definition !== null) this.definition(definition, scope, decorators as Node[]);
        return;
      }
      case "function_definition":
      case "class_definition":
        this.definition(node, scope, []);
        return;
      case "lambda":
        this.lambda(node, scope, null);
        return;
      case "assignment":
        this.assignment(node, scope);
        return;
      case "named_expression": {
        const name = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        if (name !== null && value !== null) {
          scope.bind(name.text, {
            kind: "value",
            node: value,
            scope,
            path: "",
            offset: node.endIndex,
          });
          this.visit(value, scope);
        }
        return;
      }
      case "as_pattern":
        this.asPattern(node, scope);
        return;
      case "for_statement": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left !== null && right !== null) this.bindLoop(left, right, scope, node.startIndex);
        break;
      }
      case "call":
        this.cx.addCall(node, scope);
        break;
      case "return_statement": {
        const value = node.namedChildren[0];
        if (value != null)
          this.cx.addReturn(value, scope, limits(value, true), FALSY.test(value.text));
        break;
      }
      case "augmented_assignment": {
        const left = node.childForFieldName("left");
        if (left?.type === "subscript") this.cx.markMutated(left.childForFieldName("value"), scope);
        break;
      }
      case "delete_statement":
        for (const target of node.namedChildren.flatMap((child) =>
          child?.type === "expression_list" ? child.namedChildren : [child],
        ))
          if (target?.type === "subscript")
            this.cx.markMutated(target.childForFieldName("value"), scope);
        break;
      case "if_statement": {
        const condition = node.childForFieldName("condition");
        const body = node.childForFieldName("consequence");
        if (condition === null) break;
        const last = body?.namedChildren.filter((child) => child?.type !== "comment").at(-1);
        const exits = last != null && leaves(last);
        this.cx.addGuards(
          node,
          scope,
          body,
          limits(condition, true),
          exits ? limits(condition, false) : null,
          protectedBlock(node),
        );
        break;
      }
    }
    this.visitChildren(node, scope);
  }

  importStatement(node: Node, scope: Scope): void {
    for (const name of node.childrenForFieldName("name")) {
      if (name === null) continue;
      if (name.type === "aliased_import") {
        const module = name.childForFieldName("name")?.text;
        const alias = name.childForFieldName("alias")?.text;
        if (module === undefined || alias === undefined) continue;
        this.addImport(node, scope, { module, imported: null, local: alias, kind: "module" });
        scope.bind(alias, {
          kind: "import",
          ref: this.cx.importRef(module, ""),
          offset: node.endIndex,
        });
      } else {
        // `import a.b.c` binds `a`.
        const module = name.text;
        const top = module.split(".")[0] ?? module;
        this.addImport(node, scope, { module, imported: null, local: top, kind: "module" });
        scope.bind(top, { kind: "import", ref: this.cx.importRef(top, ""), offset: node.endIndex });
      }
    }
  }

  importFrom(node: Node, scope: Scope): void {
    const module = node.childForFieldName("module_name")?.text.replace(/\s+/g, "");
    if (module === undefined) return;
    if (node.namedChildren.some((child) => child?.type === "wildcard_import")) {
      this.addImport(node, scope, { module, imported: "*", local: null, kind: "wildcard" });
      return;
    }
    for (const name of node.childrenForFieldName("name")) {
      if (name === null) continue;
      const imported = (name.type === "aliased_import" ? name.childForFieldName("name") : name)
        ?.text;
      const local =
        name.type === "aliased_import" ? name.childForFieldName("alias")?.text : imported;
      if (imported === undefined || local === undefined) continue;
      this.addImport(node, scope, { module, imported, local, kind: "member" });
      scope.bind(local, {
        kind: "import",
        ref: this.cx.importRef(module, imported),
        offset: node.endIndex,
      });
    }
  }

  addImport(
    node: Node,
    scope: Scope,
    fact: {
      module: string;
      imported: string | null;
      local: string | null;
      kind: "module" | "member" | "wildcard";
    },
  ): void {
    this.cx.imports.push({ ...fact, typeOnly: false, scope: scope.definition, span: spanOf(node) });
  }

  definition(node: Node, scope: Scope, decorators: Node[]): void {
    const isClass = node.type === "class_definition";
    const name = node.childForFieldName("name")?.text ?? null;
    const id = this.cx.allocateId(scope.definition, name, node);
    const body = node.childForFieldName("body");
    const parameters = node.childForFieldName("parameters");
    const decoratorExpressions = decorators
      .map((decorator) => decorator.namedChildren.find((child) => child?.type !== "comment"))
      .filter((expression): expression is Node => expression != null);
    const bases = isClass
      ? (node.childForFieldName("superclasses")?.namedChildren ?? []).filter(
          (base): base is Node => base !== null && base.type !== "keyword_argument",
        )
      : [];

    const fact: DefinitionFact = {
      id,
      name,
      kind: isClass ? "class" : scope.kind === "class" ? "method" : "function",
      parent: scope.definition,
      async: hasChild(node, "async"),
      exported: scope.kind === "module" && name !== null && !name.startsWith("_"),
      params: isClass ? [] : this.params(parameters),
      decorators: [],
      bases: [],
      doc: docstring(body),
      span: spanOf(node),
    };
    const { injected, scalars } = parameterKinds(isClass ? null : parameters);
    if (injected.length > 0) fact.injected = injected;
    if (scalars.length > 0) fact.scalars = scalars;
    this.cx.addDefinition(fact, scope, decoratorExpressions, bases);

    // Decorators, bases and parameter defaults run in the enclosing scope.
    for (const expression of decoratorExpressions) this.visitDecorator(expression, scope);
    for (const base of node.childForFieldName("superclasses")?.namedChildren ?? []) {
      if (base !== null) this.visit(base, scope);
    }
    if (name !== null) {
      const binding = { kind: "definition" as const, definition: id, offset: node.startIndex };
      scope.bind(name, binding);
      if (scope.kind === "class" && scope.owner !== null)
        addBinding(scope.owner.members, name, binding);
    }

    if (isClass) {
      const owner: ClassInfo = { definition: id, members: new Map() };
      this.cx.classes.set(id, owner);
      if (body !== null) this.visitChildren(body, new Scope("class", id, scope, owner));
      return;
    }

    const inner = new Scope("function", id, scope);
    this.bindParams(parameters, scope, inner, node.startIndex);
    const isStatic = decoratorExpressions.some((expression) =>
      /\bstaticmethod$/.test(expression.text),
    );
    const receiver = this.params(parameters)[0];
    if (scope.kind === "class" && scope.owner !== null && !isStatic && receiver !== undefined) {
      inner.bind(receiver, { kind: "receiver", owner: scope.owner, offset: node.startIndex });
    }
    if (body !== null) this.visitChildren(body, inner);
  }

  lambda(node: Node, scope: Scope, name: string | null): string {
    const id = this.cx.allocateId(scope.definition, name, node);
    const parameters = node.childForFieldName("parameters");
    this.cx.addDefinition(
      {
        id,
        name,
        kind: "function",
        parent: scope.definition,
        async: false,
        exported: false,
        params: this.params(parameters),
        decorators: [],
        bases: [],
        doc: null,
        span: spanOf(node),
      },
      scope,
      [],
      [],
    );
    this.cx.markInline(node, id);
    const inner = new Scope("function", id, scope);
    this.bindParams(parameters, scope, inner, node.startIndex);
    const body = node.childForFieldName("body");
    if (body !== null) this.visit(body, inner);
    return id;
  }

  visitDecorator(expression: Node, scope: Scope): void {
    // The decorator call itself is described on the definition, not as a call.
    if (expression.type === "call") this.visitChildren(expression, scope);
    else this.visit(expression, scope);
  }

  params(parameters: Node | null): string[] {
    const names: string[] = [];
    for (const parameter of parameters?.namedChildren ?? []) {
      const name = parameter === null ? undefined : paramName(parameter);
      if (name !== undefined) names.push(name);
    }
    return names;
  }

  bindParams(parameters: Node | null, outer: Scope, inner: Scope, offset: number): void {
    for (const parameter of parameters?.namedChildren ?? []) {
      if (parameter === null) continue;
      const name = paramName(parameter);
      if (name !== undefined) inner.bind(name, { kind: "param", offset });
      const fallback = parameter.childForFieldName("value");
      if (fallback !== null) this.visit(fallback, outer);
    }
  }

  assignment(node: Node, scope: Scope): void {
    const targets: Node[] = [];
    let current: Node | null = node;
    let value: Node | null = null;
    // `a = b = value` nests assignments on the right.
    while (current !== null && current.type === "assignment") {
      const left = current.childForFieldName("left");
      if (left !== null) targets.push(left);
      value = current.childForFieldName("right");
      current = value;
    }
    if (value === null) {
      // An annotation without a value (`x: int`) binds nothing.
      return;
    }
    const [only] = targets;
    if (targets.length === 1 && only?.type === "identifier" && value.type === "lambda") {
      const id = this.lambda(value, scope, only.text);
      scope.bind(only.text, { kind: "definition", definition: id, offset: node.startIndex });
      return;
    }
    for (const target of targets) this.bindTarget(target, value, scope, node.endIndex);
    this.visit(value, scope);
  }

  bindTarget(target: Node, value: Node, scope: Scope, offset: number): void {
    if (target.type === "identifier") {
      const binding = this.cx.assign(target, value, scope, offset);
      scope.bind(target.text, binding);
      if (scope.kind === "class" && scope.owner !== null) {
        addBinding(scope.owner.members, target.text, binding);
      }
    } else if (target.type === "attribute") {
      const binding = this.cx.assign(target, value, scope, offset);
      const object = target.childForFieldName("object");
      const attribute = target.childForFieldName("attribute");
      const owner = object === null ? null : this.receiverOf(object, scope);
      if (owner !== null && attribute !== null) addBinding(owner.members, attribute.text, binding);
    } else if (PATTERN_TARGETS.has(target.type)) {
      this.bindItems(target, value, scope, offset);
    } else if (target.type === "subscript") {
      this.cx.markMutated(target.childForFieldName("value"), scope);
    }
  }

  /** `for item in items` and `for key, value in pairs`: each name holds part of an item of `right`. */
  bindLoop(target: Node, right: Node, scope: Scope, offset: number): void {
    if (target.type === "identifier") {
      scope.bind(target.text, this.cx.assign(target, right, scope, offset, LOOP_ITEM));
      return;
    }
    if (!PATTERN_TARGETS.has(target.type)) return;
    for (const child of target.namedChildren)
      if (child !== null) this.bindLoop(child, right, scope, offset);
  }

  /**
   * Unpacking: `a, b = x, y` binds each name to its item; `path, body = data.split("|")`
   * binds each name to an item of the value, so what the value comes from carries over.
   */
  bindItems(target: Node, value: Node, scope: Scope, offset: number): void {
    const named = (node: Node) =>
      node.namedChildren.filter(
        (child): child is Node => child !== null && child.type !== "comment",
      );
    const targets = named(target);
    const values =
      PATTERN_TARGETS.has(value.type) || value.type === "expression_list" ? named(value) : null;
    const exact =
      values !== null &&
      values.length === targets.length &&
      !targets.some((child) => child.type === "list_splat_pattern") &&
      !values.some((child) => child.type === "list_splat");
    targets.forEach((child, index) => {
      const item = exact ? values?.[index] : undefined;
      if (item !== undefined) {
        this.bindTarget(child, item, scope, offset);
        return;
      }
      const name = child.type === "list_splat_pattern" ? child.namedChildren[0] : child;
      if (name?.type === "identifier")
        scope.bind(name.text, this.cx.assign(name, value, scope, offset, LOOP_ITEM));
      else if (name != null && PATTERN_TARGETS.has(name.type))
        this.bindItems(name, value, scope, offset);
    });
  }

  bindUnknown(target: Node, scope: Scope, offset: number): void {
    if (target.type === "identifier") {
      scope.bind(target.text, { kind: "unknown", offset });
      return;
    }
    if (!PATTERN_TARGETS.has(target.type) && target.type !== "list_splat_pattern") return;
    for (const child of target.namedChildren)
      if (child !== null) this.bindUnknown(child, scope, offset);
  }

  asPattern(node: Node, scope: Scope): void {
    const value = node.namedChildren[0];
    const alias = node.childForFieldName("alias")?.namedChildren[0];
    if (value != null) this.visit(value, scope);
    if (alias == null || alias.type !== "identifier") return;
    // `with OpenAI() as client` binds roughly the value; `except E as e` binds an instance we do not follow.
    if (node.parent?.type === "with_item" && value != null) {
      scope.bind(alias.text, this.cx.assign(alias, value, scope, node.endIndex));
    } else {
      scope.bind(alias.text, { kind: "unknown", offset: node.endIndex });
    }
  }

  /** The class whose instance `node` is, when it names the receiver (`self`, `cls`) of a method. */
  receiverOf(node: Node, scope: Scope): ClassInfo | null {
    if (node.type !== "identifier") return null;
    const binding = this.cx.lookup(node.text, scope, node.startIndex);
    return binding?.kind === "receiver" ? binding.owner : null;
  }

  // Phase two: resolution and value summaries.

  resolve(node: Node, scope: Scope, depth: number): Ref | null {
    if (depth > LIMITS.resolveDepth) return null;
    switch (node.type) {
      case "identifier":
        return this.cx.resolveName(node.text, scope, node.startIndex, depth);
      case "attribute": {
        const object = node.childForFieldName("object");
        const attribute = node.childForFieldName("attribute");
        if (object === null || attribute === null) return null;
        const owner = this.receiverOf(object, scope);
        if (owner !== null) return this.cx.resolveMember(owner, attribute.text, depth + 1);
        const base = this.resolve(object, scope, depth + 1);
        return base === null ? null : this.cx.extend(base, attribute.text);
      }
      case "call": {
        const callee = node.childForFieldName("function");
        const base = callee === null ? null : this.resolve(callee, scope, depth + 1);
        return base === null ? null : this.cx.extend(base, "()");
      }
      case "subscript": {
        // `os.environ["KEY"]` reads a member named by a string.
        const object = node.childForFieldName("value");
        const key = stringKey(node.childForFieldName("subscript"));
        if (object === null || key === null) return null;
        const base = this.resolve(object, scope, depth + 1);
        return base === null ? null : this.cx.extend(base, key);
      }
      case "await":
      case "parenthesized_expression": {
        const inner = node.namedChildren[0];
        return inner == null ? null : this.resolve(inner, scope, depth + 1);
      }
      case "binary_operator": {
        // `BASE / name` on a pathlib path is another path of the same class.
        const left = node.childForFieldName("left");
        if (node.childForFieldName("operator")?.text !== "/" || left === null) return null;
        const base = this.resolve(left, scope, depth + 1);
        return base?.name.startsWith("pathlib.") ? base : null;
      }
      default:
        return null;
    }
  }

  value(node: Node, scope: Scope, depth: number): Value {
    if (depth > LIMITS.valueDepth) return otherValue(node);
    if (LITERALS.has(node.type)) return { kind: "literal", text: node.text };
    switch (node.type) {
      case "string":
        return this.string(node, scope, depth);
      case "concatenated_string": {
        const parts = node.namedChildren
          .filter((part): part is Node => part?.type === "string")
          .map((part) => this.string(part, scope, depth));
        const template = parts.flatMap((part) =>
          part.kind === "string" ? (part.template ?? []) : [],
        );
        const text = parts.map((part) => (part.kind === "string" ? part.value : "")).join("");
        return stringValue(text, template.length > 0 ? template : null);
      }
      case "identifier":
      case "attribute":
        return this.name(node, scope);
      case "subscript": {
        if (stringKey(node.childForFieldName("subscript")) !== null) return this.name(node, scope);
        const lookup = this.composite(node, scope, depth);
        if (lookup.kind === "other" && lookup.parts !== undefined) lookup.subscript = true;
        return lookup;
      }
      case "call": {
        const index = this.cx.callIndex(node);
        return index === undefined ? otherValue(node) : { kind: "call", call: index };
      }
      case "lambda": {
        const id = this.cx.inlineDefinition(node);
        return id === undefined ? otherValue(node) : { kind: "function", definition: id };
      }
      case "list":
      case "tuple":
      case "set":
      case "expression_list":
        return listValue(this.elements(node), (item) => this.value(item, scope, depth + 1));
      case "dictionary":
        return this.dictionary(node, scope, depth);
      case "binary_operator": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (node.childForFieldName("operator")?.text === "+" && left !== null && right !== null) {
          // `+` joins text unless a side is a number, list or dict: names may hold strings (`BASE + name`).
          const parts = [this.value(left, scope, depth + 1), this.value(right, scope, depth + 1)];
          if (!parts.some(isNotText))
            return { kind: "concat", parts: parts.flatMap(flattenConcat) };
        }
        return this.composite(node, scope, depth);
      }
      case "await":
      case "parenthesized_expression": {
        const inner = node.namedChildren[0];
        return inner == null ? otherValue(node) : this.value(inner, scope, depth);
      }
      default:
        return this.composite(node, scope, depth);
    }
  }

  composite(node: Node, scope: Scope, depth: number): Value {
    return compositeValue(node, (operand) => this.value(operand, scope, depth + 1));
  }

  elements(node: Node): Node[] {
    return node.namedChildren.filter(
      (item): item is Node => item !== null && item.type !== "comment",
    );
  }

  name(node: Node, scope: Scope): Value {
    let root = node;
    while (root.type === "attribute" || root.type === "subscript") {
      const object = root.childForFieldName(root.type === "attribute" ? "object" : "value");
      if (object === null) break;
      root = object;
    }
    const value: Value = { kind: "name", text: textOf(node), ref: this.resolve(node, scope, 0) };
    if (root.type === "call") {
      const call = this.cx.callIndex(root);
      if (call !== undefined) value.of = call;
    }
    if (root.type !== "identifier") return value;
    const binding = this.cx.lookup(root.text, scope, root.startIndex);
    if (binding?.kind === "param") value.param = true;
    const assignment = this.cx.assignmentOf(root === node ? binding : this.memberOf(node, scope));
    if (assignment !== undefined) value.assignment = assignment;
    const base = root === node ? undefined : this.cx.assignmentOf(binding);
    if (assignment === undefined && base !== undefined) value.base = base;
    return value;
  }

  /** The member binding behind `self.name`. */
  memberOf(node: Node, scope: Scope): Binding | undefined {
    if (node.type !== "attribute") return undefined;
    const object = node.childForFieldName("object");
    const attribute = node.childForFieldName("attribute");
    const owner = object === null ? null : this.receiverOf(object, scope);
    return owner === null || attribute === null
      ? undefined
      : this.cx.memberBinding(owner, attribute.text);
  }

  string(node: Node, scope: Scope, depth: number): Value {
    const prefix = node.namedChildren[0]?.type === "string_start" ? node.namedChildren[0].text : "";
    const formatted = /f/i.test(prefix);
    const template: Value[] = [];
    let text = "";
    for (const part of node.namedChildren) {
      if (part === null) continue;
      if (part.type === "string_content") text += part.text;
      else if (part.type === "interpolation") {
        const expression = part.childForFieldName("expression");
        text += `{${expression?.text ?? ""}}`;
        if (expression !== null) template.push(this.value(expression, scope, depth + 1));
      }
    }
    return stringValue(text, formatted ? template : null);
  }

  dictionary(node: Node, scope: Scope, depth: number): Value {
    const pairs = node.namedChildren.filter(
      (pair): pair is Node =>
        pair !== null && (pair.type === "pair" || pair.type === "dictionary_splat"),
    );
    const entries = pairs.slice(0, LIMITS.items).map((pair) => {
      if (pair.type === "dictionary_splat") {
        const inner = pair.namedChildren[0];
        return {
          key: null,
          value: inner == null ? otherValue(pair) : this.value(inner, scope, depth + 1),
        };
      }
      const key = pair.childForFieldName("key");
      const value = pair.childForFieldName("value");
      const keyValue = key === null ? null : this.value(key, scope, depth + 1);
      return {
        key: keyValue?.kind === "string" ? keyValue.value : null,
        value: value === null ? otherValue(pair) : this.value(value, scope, depth + 1),
      };
    });
    const result: Value = { kind: "object", entries };
    if (pairs.length > LIMITS.items) result.truncated = true;
    return result;
  }

  arguments(node: Node | null, scope: Scope): Argument[] {
    const args: Argument[] = [];
    for (const arg of node?.namedChildren ?? []) {
      if (arg === null || arg.type === "comment") continue;
      if (args.length >= LIMITS.items) break;
      if (arg.type === "keyword_argument") {
        const name = arg.childForFieldName("name")?.text ?? null;
        const value = arg.childForFieldName("value");
        args.push({
          keyword: name,
          value: value === null ? otherValue(arg) : this.value(value, scope, 0),
        });
      } else if (arg.type === "list_splat" || arg.type === "dictionary_splat") {
        const inner = arg.namedChildren[0];
        args.push({
          keyword: null,
          spread: true,
          value: inner == null ? otherValue(arg) : this.value(inner, scope, 0),
        });
      } else {
        args.push({ keyword: null, value: this.value(arg, scope, 0) });
      }
    }
    return args;
  }

  call(node: Node, scope: Scope): CallFact {
    const callee = node.childForFieldName("function");
    const args = node.childForFieldName("arguments");
    const fact: CallFact = {
      callee: callee === null ? "" : textOf(callee),
      ref: callee === null ? null : this.resolve(callee, scope, 0),
      new: false,
      scope: scope.definition,
      arguments:
        args?.type === "argument_list"
          ? this.arguments(args, scope)
          : args?.type === "generator_expression"
            ? [{ keyword: null, value: this.value(args, scope, 0) }]
            : [],
      span: spanOf(node),
    };
    const receiver = callee === null ? undefined : this.receiver(callee, scope);
    if (receiver !== undefined) fact.receiver = receiver;
    // `(BASE / name).read_text()`: the expression the method is called on.
    const object = callee?.type === "attribute" ? callee.childForFieldName("object") : null;
    if (object?.type === "parenthesized_expression") fact.object = this.value(object, scope, 0);
    const lookup = callee === null || fact.ref !== null ? undefined : this.lookup(callee, scope);
    if (lookup !== undefined) fact.lookup = lookup;
    return fact;
  }

  /** The callee as a value when it is read from a dict: `HANDLERS[name]`, `fn = TOOLS.get(name)`. */
  lookup(callee: Node, scope: Scope): Value | undefined {
    // The collection is a variable holding a dict, list or tuple literal.
    const collection = (node: Node | null) => {
      if (node?.type !== "identifier") return false;
      const binding = this.cx.lookup(node.text, scope, node.startIndex);
      return (
        binding?.kind === "value" &&
        binding.path === "" &&
        (binding.node.type === "dictionary" ||
          binding.node.type === "list" ||
          binding.node.type === "tuple")
      );
    };
    const subscript = (node: Node) =>
      node.type === "subscript" && collection(node.childForFieldName("value"));
    if (subscript(callee)) return this.value(callee, scope, 0);
    if (callee.type !== "identifier") return undefined;
    const binding = this.cx.lookup(callee.text, scope, callee.startIndex);
    if (binding?.kind !== "value" || binding.path !== "") return undefined;
    const source = binding.node;
    const method = source.type === "call" ? source.childForFieldName("function") : null;
    const getter =
      method?.type === "attribute" &&
      method.childForFieldName("attribute")?.text === "get" &&
      collection(method.childForFieldName("object"));
    return subscript(source) || getter ? this.value(callee, scope, 0) : undefined;
  }

  decorator(node: Node, scope: Scope): Decorator {
    const called = node.type === "call";
    const fact: Decorator = {
      text: textOf(node),
      ref: this.resolve(node, scope, 0),
      arguments: called ? this.arguments(node.childForFieldName("arguments"), scope) : null,
      span: spanOf(node),
    };
    const callee = called ? node.childForFieldName("function") : node;
    const receiver = callee === null ? undefined : this.receiver(callee, scope);
    if (receiver !== undefined) fact.receiver = receiver;
    return fact;
  }

  /** The assignment of the innermost variable or `self` attribute a member chain starts from. */
  receiver(callee: Node, scope: Scope): number | undefined {
    const chain: Node[] = [];
    for (let node = callee.childForFieldName("object"); node !== null; ) {
      chain.push(node);
      node = node.type === "attribute" ? node.childForFieldName("object") : null;
    }
    for (const part of chain.reverse()) {
      const binding =
        part.type === "identifier"
          ? this.cx.lookup(part.text, scope, part.startIndex)
          : this.memberOf(part, scope);
      const assignment = this.cx.assignmentOf(binding);
      if (assignment !== undefined) return assignment;
    }
    return undefined;
  }
}

/** A FastAPI dependency marker: `Depends(get_session)`, `Security(scheme)`. */
const DEPENDENCY = /(?:^|\.)(?:Depends|Security)\s*\(/;

/** Types whose values hold no text: numbers, booleans, UUIDs, dates and times. */
const SCALAR =
  /^(?:int|float|bool|complex|(?:decimal\.)?Decimal|(?:uuid\.)?UUID|(?:datetime\.)?(?:datetime|date|time|timedelta))$/;

/**
 * Parameters a framework fills in from a dependency, not from the request (a default or
 * `Annotated` metadata that calls `Depends` or `Security`), and parameters annotated
 * with a scalar type, optional or not (`id: int`, `day: date | None`).
 */
function parameterKinds(parameters: Node | null): { injected: string[]; scalars: string[] } {
  const injected: string[] = [];
  const scalars: string[] = [];
  for (const parameter of parameters?.namedChildren ?? []) {
    if (parameter === null) continue;
    const name = paramName(parameter);
    if (name === undefined) continue;
    const value = parameter.childForFieldName("value")?.text ?? "";
    const type = parameter.childForFieldName("type")?.text.replace(/\s+/g, "") ?? "";
    if (DEPENDENCY.test(value) || /^Annotated\[.*\b(?:Depends|Security)\(/.test(type))
      injected.push(name);
    else if (SCALAR.test(baseType(type))) scalars.push(name);
  }
  return { injected, scalars };
}

/** `int` for `Annotated[int, Path()]`, `Optional[int]`, `int | None` and `None | int`. */
function baseType(type: string): string {
  const inner = /^(?:Annotated|Optional)\[([^,[\]]+)[,\]]/.exec(type)?.[1] ?? type;
  return inner.replace(/^None\||\|None$/, "");
}

function paramName(parameter: Node): string | undefined {
  switch (parameter.type) {
    case "identifier":
      return parameter.text;
    case "default_parameter":
    case "typed_default_parameter":
      return parameter.childForFieldName("name")?.text;
    case "typed_parameter":
    case "list_splat_pattern":
    case "dictionary_splat_pattern": {
      const inner = parameter.namedChildren[0];
      return inner == null ? undefined : paramName(inner);
    }
    default:
      return undefined;
  }
}

/** The content of a plain string subscript (`["KEY"]`), or null. */
function stringKey(node: Node | null): string | null {
  if (node?.type !== "string") return null;
  if (node.namedChildren.some((part) => part?.type === "interpolation")) return null;
  return node.namedChildren
    .filter((part) => part?.type === "string_content")
    .map((part) => part?.text ?? "")
    .join("");
}

function docstring(body: Node | null): string | null {
  const first = body?.namedChildren[0];
  if (first?.type !== "expression_statement") return null;
  const string = first.namedChildren[0];
  if (string?.type !== "string") return null;
  const text = string.namedChildren
    .filter((part) => part?.type === "string_content")
    .map((part) => part?.text ?? "")
    .join("")
    .trim();
  return clip(text, LIMITS.doc);
}

function isNotText(value: Value): boolean {
  return (
    value.kind === "list" ||
    value.kind === "object" ||
    (value.kind === "literal" && /^[\d.]/.test(value.text))
  );
}

function flattenConcat(value: Value): Value[] {
  return value.kind === "concat" ? value.parts : [value];
}
