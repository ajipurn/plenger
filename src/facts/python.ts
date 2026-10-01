import type { Node } from "web-tree-sitter";
import {
  addBinding,
  type Binding,
  type ClassInfo,
  Context,
  clip,
  hasChild,
  type LanguageHooks,
  LIMITS,
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
const PATTERN_TARGETS = new Set(["pattern_list", "tuple_pattern", "list_pattern", "tuple", "list"]);

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
        if (left !== null) this.bindUnknown(left, scope, node.startIndex);
        break;
      }
      case "call":
        this.cx.addCall(node, scope);
        break;
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
      this.bindUnknown(target, scope, offset);
    }
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
      case "subscript":
        return stringKey(node.childForFieldName("subscript")) === null
          ? otherValue(node)
          : this.name(node, scope);
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
        return otherValue(node);
      }
      case "await":
      case "parenthesized_expression": {
        const inner = node.namedChildren[0];
        return inner == null ? otherValue(node) : this.value(inner, scope, depth);
      }
      default:
        return otherValue(node);
    }
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
    if (root.type !== "identifier") return value;
    const binding = this.cx.lookup(root.text, scope, root.startIndex);
    if (binding?.kind === "param") value.param = true;
    const assignment = this.cx.assignmentOf(root === node ? binding : this.memberOf(node, scope));
    if (assignment !== undefined) value.assignment = assignment;
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
      arguments: args?.type === "argument_list" ? this.arguments(args, scope) : [],
      span: spanOf(node),
    };
    const receiver = callee === null ? undefined : this.receiver(callee, scope);
    if (receiver !== undefined) fact.receiver = receiver;
    return fact;
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
