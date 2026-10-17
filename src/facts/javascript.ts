import type { Node } from "web-tree-sitter";
import {
  addBinding,
  type Binding,
  type ClassInfo,
  Context,
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

/** Extracts facts from JavaScript, TypeScript or TSX; the grammars share these node types. */
export function extractJavaScript(root: Node): FileFacts {
  const extractor = new JavaScriptExtractor();
  extractor.visitChildren(root, extractor.cx.module);
  extractor.markExports();
  return extractor.cx.finish(extractor);
}

const FUNCTIONS = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
  "function_declaration",
  "generator_function_declaration",
]);
const CLASSES = new Set(["class_declaration", "abstract_class_declaration", "class"]);
const LITERALS = new Set(["number", "true", "false", "null", "undefined", "regex"]);
const WRAPPERS = new Set([
  "await_expression",
  "parenthesized_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
]);
/** Statements that leave the enclosing block. */
const EXITS = new Set([
  "return_statement",
  "throw_statement",
  "continue_statement",
  "break_statement",
]);
/**
 * The block whose rest an exiting `if` protects: the one it is in, or, when that is the
 * body of a `try` whose `catch` exits too (or that has none), the block around the `try`.
 */
function protectedBlock(node: Node): Node | null {
  let block = node.parent;
  for (let owner = block?.parent; owner?.type === "try_statement"; owner = block?.parent) {
    if (owner.childForFieldName("body")?.id !== block?.id) break;
    const handler = owner.childForFieldName("handler")?.childForFieldName("body");
    const last = handler?.namedChildren.filter((child) => child?.type !== "comment").at(-1);
    if (handler != null && (last == null || !EXITS.has(last.type))) break;
    block = owner.parent;
  }
  return block;
}

/** Methods that test membership: `HOSTS.has(host)`, `LIST.includes(name)`, `OBJ.hasOwnProperty(key)`. */
const MEMBERSHIP = /^(?:has|includes|hasOwnProperty)$/;

/**
 * The values an `if` test limits while it is `truth`: `S.has(x)`, `S.includes(x)`,
 * `x in S`, `x === "a"`, `/^[a-z]+$/.test(x)` and `x.startsWith(BASE)` when they hold,
 * `x !== "a"`, `x.includes("..")` and `x.startsWith("/")` when they fail, through `!`,
 * parentheses, `&&`
 * (holding) and `||` (failing).
 */
function limits(node: Node, truth: boolean): Limit[] {
  if (WRAPPERS.has(node.type)) {
    const inner = node.namedChildren[0];
    return inner == null ? [] : limits(inner, truth);
  }
  switch (node.type) {
    case "unary_expression": {
      const argument = node.childForFieldName("argument");
      return node.childForFieldName("operator")?.type !== "!" || argument === null
        ? []
        : limits(argument, !truth);
    }
    case "binary_expression": {
      const operator = node.childForFieldName("operator")?.type;
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left === null || right === null) return [];
      if (operator === "&&" || operator === "||")
        return (operator === "&&" && truth) || (operator === "||" && !truth)
          ? [...limits(left, truth), ...limits(right, truth)]
          : [];
      if (operator === "in") return truth ? [{ subject: left, allowed: right }] : [];
      const equal = operator === "===" || operator === "==";
      if (!((equal && truth) || ((operator === "!==" || operator === "!=") && !truth))) return [];
      return LITERALS.has(left.type) || left.type === "string"
        ? [{ subject: right, allowed: left }]
        : [{ subject: left, allowed: right }];
    }
    case "call_expression": {
      const callee = node.childForFieldName("function");
      const args = node.childForFieldName("arguments")?.namedChildren ?? [];
      const [argument] = args;
      const object = callee?.childForFieldName("object");
      const method = nameText(callee?.childForFieldName("property") ?? null) ?? "";
      if (
        callee?.type !== "member_expression" ||
        args.length !== 1 ||
        argument == null ||
        object == null
      )
        return [];
      // `name.includes("..")` failing: the name does not contain that text.
      if (method === "includes" && argument.type === "string" && !truth)
        return [{ subject: object, allowed: argument, test: "excludes" }];
      // `name.startsWith("/")` or `path.isAbsolute(name)` failing: a relative path.
      if (!truth && method === "startsWith" && /^["'`][/\\]+["'`]$/.test(argument.text))
        return [{ subject: object, allowed: argument, test: "relative" }];
      if (!truth && method === "isAbsolute" && object.text === "path")
        return [{ subject: argument, allowed: argument, test: "relative" }];
      if (!truth) return [];
      if (method === "test") return [{ subject: argument, allowed: object, test: "matches" }];
      if (method === "startsWith") return [{ subject: object, allowed: argument, test: "within" }];
      return MEMBERSHIP.test(method) ? [{ subject: argument, allowed: object }] : [];
    }
    default:
      return [];
  }
}

/** Type-level syntax with no runtime behaviour. */
const TYPE_ONLY = new Set([
  "type_annotation",
  "type_alias_declaration",
  "interface_declaration",
  "type_arguments",
  "type_parameters",
  "ambient_declaration",
  "abstract_method_signature",
  "method_signature",
  "index_signature",
]);

class JavaScriptExtractor implements LanguageHooks {
  readonly cx = new Context("javascript");
  readonly #exportedNames = new Set<string>();
  readonly #definitions: DefinitionFact[] = [];

  // Phase one: scopes, bindings and the nodes to describe.

  visitChildren(node: Node, scope: Scope): void {
    for (const child of node.namedChildren) if (child !== null) this.visit(child, scope);
  }

  visit(node: Node, scope: Scope, exported = false): void {
    if (TYPE_ONLY.has(node.type)) return;
    if (FUNCTIONS.has(node.type)) {
      const name = node.type.endsWith("_declaration")
        ? (node.childForFieldName("name")?.text ?? null)
        : null;
      const id = this.function(node, scope, name, exported);
      if (name !== null) scope.bind(name, { kind: "definition", definition: id, offset: 0 });
      return;
    }
    if (CLASSES.has(node.type)) {
      const name = node.childForFieldName("name")?.text ?? null;
      const id = this.class(node, scope, name, exported, []);
      if (name !== null && node.type !== "class") {
        scope.bind(name, { kind: "definition", definition: id, offset: node.startIndex });
      }
      return;
    }
    switch (node.type) {
      case "pair": {
        const value = node.childForFieldName("value");
        if (value !== null && FUNCTIONS.has(value.type)) {
          this.function(value, scope, nameText(node.childForFieldName("key")), false);
          return;
        }
        break;
      }
      case "method_definition":
        // Methods in object literals; class members go through member().
        this.function(node, scope, nameText(node.childForFieldName("name")), false);
        return;
      case "import_statement":
        this.importStatement(node, scope);
        return;
      case "export_statement":
        this.exportStatement(node, scope);
        return;
      case "variable_declarator":
        this.declarator(node, scope, exported);
        return;
      case "lexical_declaration":
      case "variable_declaration":
        for (const child of node.namedChildren)
          if (child !== null) this.visit(child, scope, exported);
        return;
      case "assignment_expression":
        this.assignment(node, scope);
        return;
      case "augmented_assignment_expression": {
        const left = node.childForFieldName("left");
        if (left?.type === "subscript_expression" || left?.type === "member_expression")
          this.cx.markMutated(left.childForFieldName("object"), scope);
        break;
      }
      case "unary_expression":
        // `delete HOSTS[key]`
        if (node.childForFieldName("operator")?.type === "delete") {
          const target = node.childForFieldName("argument");
          if (target?.type === "subscript_expression" || target?.type === "member_expression")
            this.cx.markMutated(target.childForFieldName("object"), scope);
        }
        break;
      case "for_in_statement": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.type === "identifier" && right !== null) {
          // `for (const item of items)`: the name holds an item (or key) of `right`.
          scope.bind(left.text, this.cx.assign(left, right, scope, node.startIndex, LOOP_ITEM));
        } else if (left !== null) {
          this.bindPattern(left, scope, node.startIndex);
        }
        break;
      }
      case "catch_clause": {
        const parameter = node.childForFieldName("parameter");
        if (parameter !== null) this.bindPattern(parameter, scope, node.startIndex);
        break;
      }
      case "call_expression":
        this.recordRequire(node, scope);
        this.cx.addCall(node, scope);
        break;
      case "new_expression":
        this.cx.addCall(node, scope);
        break;
      case "return_statement": {
        const value = node.namedChildren[0];
        if (value != null) this.cx.addReturn(value, scope);
        break;
      }
      case "if_statement": {
        const condition = node.childForFieldName("condition");
        const body = node.childForFieldName("consequence");
        if (condition === null) break;
        const last =
          body?.type === "statement_block"
            ? body.namedChildren.filter((child) => child?.type !== "comment").at(-1)
            : body;
        const exits = last != null && EXITS.has(last.type);
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
    const module = stringContent(node.childForFieldName("source"));
    if (module === null) return;
    const typeOnly = hasChild(node, "type");
    const clause = node.namedChildren.find((child) => child?.type === "import_clause");
    if (clause == null) {
      this.addImport(node, scope, {
        module,
        imported: null,
        local: null,
        kind: "side_effect",
        typeOnly,
      });
      return;
    }
    for (const part of clause.namedChildren) {
      if (part === null) continue;
      if (part.type === "identifier") {
        this.addImport(node, scope, {
          module,
          imported: "default",
          local: part.text,
          kind: "default",
          typeOnly,
        });
        this.bindImport(scope, part.text, module, "default", node);
      } else if (part.type === "namespace_import") {
        const local = part.namedChildren[0]?.text;
        if (local === undefined) continue;
        this.addImport(node, scope, { module, imported: null, local, kind: "namespace", typeOnly });
        this.bindImport(scope, local, module, "", node);
      } else if (part.type === "named_imports") {
        for (const specifier of part.namedChildren) {
          if (specifier?.type !== "import_specifier") continue;
          const imported = nameText(specifier.childForFieldName("name"));
          const local = nameText(specifier.childForFieldName("alias")) ?? imported;
          if (imported === null || local === null) continue;
          this.addImport(node, scope, {
            module,
            imported,
            local,
            kind: "member",
            typeOnly: typeOnly || hasChild(specifier, "type"),
          });
          this.bindImport(scope, local, module, imported, node);
        }
      }
    }
  }

  exportStatement(node: Node, scope: Scope): void {
    const source = stringContent(node.childForFieldName("source"));
    const typeOnly = hasChild(node, "type");
    if (source !== null) {
      const clause = node.namedChildren.find((child) => child?.type === "export_clause");
      const specifiers =
        clause?.namedChildren.filter((child) => child?.type === "export_specifier") ?? [];
      if (specifiers.length === 0) {
        this.addImport(node, scope, {
          module: source,
          imported: "*",
          local: null,
          kind: "reexport",
          typeOnly,
        });
      }
      for (const specifier of specifiers) {
        const imported = nameText(specifier?.childForFieldName("name") ?? null);
        this.addImport(node, scope, {
          module: source,
          imported,
          local: null,
          kind: "reexport",
          typeOnly,
        });
      }
      return;
    }
    // `@Dec export class X {}` attaches the decorator to the export statement.
    const decorators = this.decoratorsOf(node, scope);
    const declaration = node.childForFieldName("declaration");
    if (declaration !== null && hasChild(node, "default")) {
      this.cx.defaultExport = declaration.childForFieldName("name")?.text ?? "default";
    }
    if (declaration !== null) {
      if (CLASSES.has(declaration.type) && decorators.length > 0) {
        const name = declaration.childForFieldName("name")?.text ?? null;
        const id = this.class(declaration, scope, name, true, decorators);
        if (name !== null) {
          scope.bind(name, { kind: "definition", definition: id, offset: declaration.startIndex });
        }
        return;
      }
      this.visit(declaration, scope, true);
      return;
    }
    const value = node.childForFieldName("value");
    if (value !== null) {
      // export default <expression>
      if (FUNCTIONS.has(value.type) || CLASSES.has(value.type)) {
        const name = value.childForFieldName("name")?.text ?? "default";
        this.cx.defaultExport = name;
        if (CLASSES.has(value.type)) this.class(value, scope, name, true, decorators);
        else this.function(value, scope, name, true);
      } else {
        if (value.type === "identifier") {
          this.#exportedNames.add(value.text);
          this.cx.defaultExport = value.text;
        }
        this.visit(value, scope);
      }
      return;
    }
    for (const clause of node.namedChildren) {
      if (clause?.type !== "export_clause") continue;
      for (const specifier of clause.namedChildren) {
        const name = nameText(specifier?.childForFieldName("name") ?? null);
        if (name !== null) this.#exportedNames.add(name);
      }
    }
  }

  addImport(
    node: Node,
    scope: Scope,
    fact: {
      module: string;
      imported: string | null;
      local: string | null;
      kind: "default" | "namespace" | "member" | "side_effect" | "require" | "dynamic" | "reexport";
      typeOnly: boolean;
    },
  ): void {
    this.cx.imports.push({ ...fact, scope: scope.definition, span: spanOf(node) });
  }

  bindImport(scope: Scope, local: string, module: string, path: string, node: Node): void {
    scope.bind(local, {
      kind: "import",
      ref: this.cx.importRef(module, path),
      offset: node.endIndex,
    });
  }

  /** Records `require("m")` and `import("m")` calls as imports. */
  recordRequire(node: Node, scope: Scope): void {
    const callee = node.childForFieldName("function");
    const module = stringContent(node.childForFieldName("arguments")?.namedChildren[0] ?? null);
    if (callee === null || module === null) return;
    if (callee.type === "import") {
      this.addImport(node, scope, {
        module,
        imported: null,
        local: null,
        kind: "dynamic",
        typeOnly: false,
      });
    } else if (this.isGlobalRequire(callee, scope)) {
      const declarator = node.parent?.type === "variable_declarator" ? node.parent : null;
      const name = declarator?.childForFieldName("name");
      const local = name?.type === "identifier" ? name.text : null;
      this.addImport(node, scope, {
        module,
        imported: null,
        local,
        kind: "require",
        typeOnly: false,
      });
    }
  }

  isGlobalRequire(callee: Node, scope: Scope): boolean {
    return (
      callee.type === "identifier" &&
      callee.text === "require" &&
      this.cx.lookup("require", scope, callee.startIndex) === undefined
    );
  }

  function(
    node: Node,
    scope: Scope,
    name: string | null,
    exported: boolean,
    method = false,
    decorators: Node[] = [],
  ): string {
    const id = this.cx.allocateId(scope.definition, name, node);
    const parameters = node.childForFieldName("parameters") ?? node.childForFieldName("parameter");
    const params = parameters === null ? [] : patternNames(parameters);
    const fact: DefinitionFact = {
      id,
      name,
      kind: method ? "method" : "function",
      parent: scope.definition,
      async: hasChild(node, "async"),
      exported,
      params,
      decorators: [],
      bases: [],
      doc: null,
      span: spanOf(node),
    };
    this.#definitions.push(fact);
    this.cx.addDefinition(
      fact,
      scope,
      [...this.expressions(decorators, scope), ...this.decoratorsOf(node, scope)],
      [],
    );
    this.cx.markInline(node, id);

    // Arrow functions keep the enclosing `this`; other functions only have one as methods.
    const owner = node.type === "arrow_function" || method ? thisOwner(scope) : null;
    const inner = new Scope("function", id, scope, owner);
    const list =
      parameters?.type === "identifier" ? [parameters] : (parameters?.namedChildren ?? []);
    for (const parameter of list) {
      if (parameter === null) continue;
      for (const paramName of patternNames(parameter))
        inner.bind(paramName, { kind: "param", offset: 0 });
      for (const fallback of defaultValues(parameter)) this.visit(fallback, scope);
    }
    const body = node.childForFieldName("body");
    if (body !== null) {
      if (body.type === "statement_block") this.visitChildren(body, inner);
      else {
        // `() => value` returns its body.
        this.cx.addReturn(body, inner);
        this.visit(body, inner);
      }
    }
    return id;
  }

  class(
    node: Node,
    scope: Scope,
    name: string | null,
    exported: boolean,
    extraDecorators: Node[],
  ): string {
    const id = this.cx.allocateId(scope.definition, name, node);
    const bases = heritage(node);
    const fact: DefinitionFact = {
      id,
      name,
      kind: "class",
      parent: scope.definition,
      async: false,
      exported,
      params: [],
      decorators: [],
      bases: [],
      doc: null,
      span: spanOf(node),
    };
    this.#definitions.push(fact);
    this.cx.addDefinition(
      fact,
      scope,
      [...extraDecorators, ...this.decoratorsOf(node, scope)],
      bases,
    );
    this.cx.markInline(node, id);
    for (const base of bases) this.visit(base, scope);

    const owner: ClassInfo = { definition: id, members: new Map() };
    this.cx.classes.set(id, owner);
    const classScope = new Scope("class", id, scope, owner);
    let pendingDecorators: Node[] = [];
    for (const member of node.childForFieldName("body")?.namedChildren ?? []) {
      if (member === null) continue;
      if (member.type === "decorator") {
        pendingDecorators.push(member);
        continue;
      }
      this.member(member, classScope, owner, pendingDecorators);
      pendingDecorators = [];
    }
    return id;
  }

  member(member: Node, classScope: Scope, owner: ClassInfo, decorators: Node[]): void {
    if (member.type === "method_definition") {
      const name = nameText(member.childForFieldName("name"));
      const id = this.function(member, classScope, name, false, true, decorators);
      if (name !== null)
        addBinding(owner.members, name, { kind: "definition", definition: id, offset: 0 });
      return;
    }
    if (member.type === "public_field_definition" || member.type === "field_definition") {
      const nameNode = member.childForFieldName("name") ?? member.childForFieldName("property");
      const name = nameText(nameNode);
      const value = member.childForFieldName("value");
      if (name === null || value === null) return;
      if (FUNCTIONS.has(value.type)) {
        const id = this.function(value, classScope, name, false, true, decorators);
        addBinding(owner.members, name, { kind: "definition", definition: id, offset: 0 });
        return;
      }
      if (nameNode !== null)
        addBinding(owner.members, name, this.cx.assign(nameNode, value, classScope, 0));
      this.visit(value, classScope);
      return;
    }
    if (TYPE_ONLY.has(member.type)) return;
    this.visit(member, classScope);
  }

  /** Decorator expressions on `node`; calls inside their arguments run in `scope`. */
  decoratorsOf(node: Node, scope: Scope): Node[] {
    return this.expressions(
      node.childrenForFieldName("decorator").filter((child): child is Node => child !== null),
      scope,
    );
  }

  expressions(decorators: Node[], scope: Scope): Node[] {
    const expressions: Node[] = [];
    for (const decorator of decorators) {
      const expression = decorator.namedChildren[0];
      if (expression == null) continue;
      // The decorator call itself is described on the definition, not as a call.
      if (expression.type === "call_expression") this.visitChildren(expression, scope);
      expressions.push(expression);
    }
    return expressions;
  }

  declarator(node: Node, scope: Scope, exported: boolean): void {
    const name = node.childForFieldName("name");
    const value = node.childForFieldName("value");
    if (name === null) return;
    if (value === null) {
      this.bindPattern(name, scope, node.endIndex);
      return;
    }
    if (name.type === "identifier") {
      if (FUNCTIONS.has(value.type) || CLASSES.has(value.type)) {
        const id = CLASSES.has(value.type)
          ? this.class(value, scope, name.text, exported, [])
          : this.function(value, scope, name.text, exported);
        scope.bind(name.text, { kind: "definition", definition: id, offset: node.startIndex });
        return;
      }
      scope.bind(name.text, this.cx.assign(name, value, scope, node.endIndex));
      if (exported) this.#exportedNames.add(name.text);
    } else if (name.type === "object_pattern") {
      this.bindDestructured(name, value, scope, "", node.endIndex);
    } else {
      this.bindPattern(name, scope, node.endIndex);
    }
    this.visit(value, scope);
  }

  /** `const { a, b: c } = value` binds `a` to `value.a` and `c` to `value.b`. */
  bindDestructured(pattern: Node, value: Node, scope: Scope, path: string, offset: number): void {
    for (const property of pattern.namedChildren) {
      if (property === null) continue;
      if (property.type === "shorthand_property_identifier_pattern") {
        scope.bind(
          property.text,
          this.cx.assign(property, value, scope, offset, joinKey(path, property.text)),
        );
      } else if (property.type === "pair_pattern") {
        const key = nameText(property.childForFieldName("key"));
        const target = property.childForFieldName("value");
        if (key === null || target === null) continue;
        const inner =
          target.type === "assignment_pattern" ? target.childForFieldName("left") : target;
        if (inner?.type === "identifier") {
          scope.bind(inner.text, this.cx.assign(inner, value, scope, offset, joinKey(path, key)));
        } else if (inner?.type === "object_pattern") {
          this.bindDestructured(inner, value, scope, joinKey(path, key), offset);
        } else if (inner !== null && inner !== undefined) {
          this.bindPattern(inner, scope, offset);
        }
      } else if (property.type === "object_assignment_pattern") {
        const left = property.childForFieldName("left");
        if (left?.type === "shorthand_property_identifier_pattern") {
          scope.bind(
            left.text,
            this.cx.assign(left, value, scope, offset, joinKey(path, left.text)),
          );
        }
      } else {
        this.bindPattern(property, scope, offset);
      }
    }
  }

  bindPattern(pattern: Node, scope: Scope, offset: number): void {
    for (const name of patternNames(pattern)) scope.bind(name, { kind: "unknown", offset });
  }

  assignment(node: Node, scope: Scope): void {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (left === null || right === null) return;
    if (left.type === "subscript_expression" || left.type === "member_expression")
      this.cx.markMutated(left.childForFieldName("object"), scope);
    if (left.type !== "identifier" && left.type !== "member_expression") {
      this.bindPattern(left, scope, node.endIndex);
      this.visit(right, scope);
      return;
    }
    const name =
      left.type === "identifier" ? left.text : nameText(left.childForFieldName("property"));
    const isDefinition = FUNCTIONS.has(right.type) || CLASSES.has(right.type);
    let binding: Binding;
    if (isDefinition) {
      const id = CLASSES.has(right.type)
        ? this.class(right, scope, name, false, [])
        : this.function(right, scope, name, false);
      binding = { kind: "definition", definition: id, offset: node.startIndex };
    } else {
      binding = this.cx.assign(left, right, scope, node.endIndex);
    }
    if (left.type === "identifier") {
      scope.bind(left.text, binding);
    } else {
      const owner = left.childForFieldName("object")?.type === "this" ? thisOwner(scope) : null;
      if (owner !== null && name !== null) addBinding(owner.members, name, binding);
      this.trackExports(left, right);
    }
    if (!isDefinition) this.visit(right, scope);
  }

  /** CommonJS `module.exports = { a, b }` and `module.exports = a`. */
  trackExports(left: Node, right: Node): void {
    const property = /^(?:module\.)?exports\.(\w+)$/.exec(left.text)?.[1];
    if (property !== undefined) this.#exportedNames.add(property);
    if (left.text !== "module.exports") return;
    if (right.type === "identifier") this.#exportedNames.add(right.text);
    if (right.type !== "object") return;
    for (const entry of right.namedChildren) {
      if (entry?.type === "shorthand_property_identifier") this.#exportedNames.add(entry.text);
      if (entry?.type === "pair" && entry.childForFieldName("value")?.type === "identifier") {
        this.#exportedNames.add(entry.childForFieldName("value")?.text ?? "");
      }
    }
  }

  markExports(): void {
    for (const fact of this.#definitions) {
      if (fact.parent === null && fact.name !== null && this.#exportedNames.has(fact.name))
        fact.exported = true;
    }
  }

  // Phase two: resolution and value summaries.

  resolve(node: Node, scope: Scope, depth: number): Ref | null {
    if (depth > LIMITS.resolveDepth) return null;
    if (WRAPPERS.has(node.type)) {
      const inner = node.namedChildren[0];
      return inner == null ? null : this.resolve(inner, scope, depth + 1);
    }
    switch (node.type) {
      case "identifier":
      case "shorthand_property_identifier":
        return this.cx.resolveName(node.text, scope, node.startIndex, depth);
      case "this": {
        const owner = thisOwner(scope);
        return owner === null ? null : this.cx.localRef(owner.definition, "()");
      }
      case "member_expression":
      case "subscript_expression": {
        const object = node.childForFieldName("object");
        const key =
          node.type === "member_expression"
            ? nameText(node.childForFieldName("property"))
            : stringContent(node.childForFieldName("index"));
        if (object === null || key === null) return null;
        const owner = object.type === "this" ? thisOwner(scope) : null;
        if (owner !== null) return this.cx.resolveMember(owner, key, depth + 1);
        const base = this.resolve(object, scope, depth + 1);
        return base === null ? null : this.cx.extend(base, key);
      }
      case "call_expression": {
        const callee = node.childForFieldName("function");
        if (callee === null) return null;
        const module = stringContent(node.childForFieldName("arguments")?.namedChildren[0] ?? null);
        if (module !== null && (callee.type === "import" || this.isGlobalRequire(callee, scope))) {
          return this.cx.importRef(module, "");
        }
        const base = this.resolve(callee, scope, depth + 1);
        return base === null ? null : this.cx.extend(base, "()");
      }
      case "new_expression": {
        const target = node.childForFieldName("constructor");
        const base = target === null ? null : this.resolve(target, scope, depth + 1);
        return base === null ? null : this.cx.extend(base, "()");
      }
      default:
        return null;
    }
  }

  value(node: Node, scope: Scope, depth: number): Value {
    if (depth > LIMITS.valueDepth) return otherValue(node);
    if (LITERALS.has(node.type)) return { kind: "literal", text: node.text };
    if (WRAPPERS.has(node.type)) {
      const inner = node.namedChildren[0];
      return inner == null ? otherValue(node) : this.value(inner, scope, depth);
    }
    const inline = this.cx.inlineDefinition(node);
    if (inline !== undefined) return { kind: "function", definition: inline };
    switch (node.type) {
      case "string":
        return stringValue(node.text.slice(1, -1), null);
      case "template_string":
        return this.template(node, scope, depth);
      case "identifier":
      case "member_expression":
      case "subscript_expression":
      case "this":
        return this.name(node, scope);
      case "call_expression":
      case "new_expression": {
        const index = this.cx.callIndex(node);
        return index === undefined ? otherValue(node) : { kind: "call", call: index };
      }
      case "array":
        return listValue(
          node.namedChildren.filter(
            (item): item is Node => item !== null && item.type !== "comment",
          ),
          (item) => this.value(item, scope, depth + 1),
        );
      case "object":
        return this.object(node, scope, depth);
      case "spread_element": {
        const inner = node.namedChildren[0];
        return inner == null ? otherValue(node) : this.value(inner, scope, depth + 1);
      }
      case "binary_expression": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (node.childForFieldName("operator")?.text === "+" && left !== null && right !== null) {
          // `+` joins text unless a side is a number, array or object: names may hold strings.
          const parts = [this.value(left, scope, depth + 1), this.value(right, scope, depth + 1)];
          const notText = (part: Value) =>
            part.kind === "list" ||
            part.kind === "object" ||
            (part.kind === "literal" && /^[\d.]/.test(part.text));
          if (!parts.some(notText)) {
            return {
              kind: "concat",
              parts: parts.flatMap((part) => (part.kind === "concat" ? part.parts : [part])),
            };
          }
        }
        return this.composite(node, scope, depth);
      }
      default:
        return this.composite(node, scope, depth);
    }
  }

  composite(node: Node, scope: Scope, depth: number): Value {
    return compositeValue(node, (operand) => this.value(operand, scope, depth + 1));
  }

  name(node: Node, scope: Scope): Value {
    let root = node;
    while (root.type === "member_expression" || root.type === "subscript_expression") {
      const object = root.childForFieldName("object");
      if (object === null) break;
      root = object;
    }
    const value: Value = { kind: "name", text: textOf(node), ref: this.resolve(node, scope, 0) };
    let assignment: number | undefined;
    if (root.type === "call_expression" || root.type === "new_expression") {
      const call = this.cx.callIndex(root);
      if (call !== undefined) value.of = call;
    }
    if (root.type === "this") {
      assignment = this.cx.assignmentOf(this.memberOf(node, scope));
    } else if (root.type === "identifier" || root.type === "shorthand_property_identifier") {
      const binding = this.cx.lookup(root.text, scope, root.startIndex);
      if (binding?.kind === "param") value.param = true;
      if (root === node) assignment = this.cx.assignmentOf(binding);
      else {
        const base = this.cx.assignmentOf(binding);
        if (base !== undefined) value.base = base;
      }
    }
    if (assignment !== undefined) value.assignment = assignment;
    return value;
  }

  /** The member binding behind `this.name`. */
  memberOf(node: Node, scope: Scope): Binding | undefined {
    if (node.type !== "member_expression") return undefined;
    const owner = node.childForFieldName("object")?.type === "this" ? thisOwner(scope) : null;
    const name = nameText(node.childForFieldName("property"));
    return owner === null || name === null ? undefined : this.cx.memberBinding(owner, name);
  }

  template(node: Node, scope: Scope, depth: number): Value {
    const template: Value[] = [];
    let text = "";
    for (const part of node.children) {
      if (part === null || part.type === "`") continue;
      if (part.type === "template_substitution") {
        const expression = part.namedChildren[0];
        text += part.text;
        if (expression != null) template.push(this.value(expression, scope, depth + 1));
      } else {
        text += part.text;
      }
    }
    return stringValue(text, template);
  }

  object(node: Node, scope: Scope, depth: number): Value {
    const members = node.namedChildren.filter(
      (entry): entry is Node => entry !== null && entry.type !== "comment",
    );
    const entries = members.slice(0, LIMITS.items).map((entry) => {
      switch (entry.type) {
        case "pair": {
          const value = entry.childForFieldName("value");
          return {
            key: nameText(entry.childForFieldName("key")),
            value: value === null ? otherValue(entry) : this.value(value, scope, depth + 1),
          };
        }
        case "shorthand_property_identifier":
          return { key: entry.text, value: this.name(entry, scope) };
        case "method_definition":
          return {
            key: nameText(entry.childForFieldName("name")),
            value: this.value(entry, scope, depth + 1),
          };
        default:
          return { key: null, value: this.value(entry, scope, depth + 1) };
      }
    });
    const result: Value = { kind: "object", entries };
    if (members.length > LIMITS.items) result.truncated = true;
    return result;
  }

  arguments(node: Node | null, scope: Scope): Argument[] {
    // A tagged template (`` $`git show ${sha}` ``) passes the template itself.
    if (node?.type === "template_string")
      return [{ keyword: null, value: this.template(node, scope, 0) }];
    const args: Argument[] = [];
    for (const arg of node?.namedChildren ?? []) {
      if (arg === null || arg.type === "comment") continue;
      if (args.length >= LIMITS.items) break;
      const argument: Argument = { keyword: null, value: this.value(arg, scope, 0) };
      if (arg.type === "spread_element") argument.spread = true;
      args.push(argument);
    }
    return args;
  }

  call(node: Node, scope: Scope): CallFact {
    const isNew = node.type === "new_expression";
    const callee = node.childForFieldName(isNew ? "constructor" : "function");
    const fact: CallFact = {
      callee: callee === null ? "" : textOf(callee),
      ref: callee === null ? null : this.calleeRef(node, callee, scope),
      new: isNew,
      scope: scope.definition,
      arguments: this.arguments(node.childForFieldName("arguments"), scope),
      span: spanOf(node),
    };
    const receiver = callee === null ? undefined : this.receiver(callee, scope);
    if (receiver !== undefined) fact.receiver = receiver;
    // `(base + name).trim()`: the expression the method is called on.
    const object = callee?.type === "member_expression" ? callee.childForFieldName("object") : null;
    if (object?.type === "parenthesized_expression") fact.object = this.value(object, scope, 0);
    const lookup =
      callee === null || isNew || (fact.ref !== null && fact.ref.kind !== "global")
        ? undefined
        : this.lookup(callee, scope);
    if (lookup !== undefined) fact.lookup = lookup;
    return fact;
  }

  /**
   * The callee as a value when it is read from an object or array variable:
   * `HANDLERS[name]`, `TOOLS.run`, `const fn = TOOLS[name]`, `const fn = TOOLS.get(name)`.
   */
  lookup(callee: Node, scope: Scope): Value | undefined {
    // The object is a variable holding an object, array or `new Map(...)` literal.
    const collection = (node: Node | null) => {
      if (node?.type !== "identifier") return false;
      const binding = this.cx.lookup(node.text, scope, node.startIndex);
      return (
        binding?.kind === "value" &&
        binding.path === "" &&
        (binding.node.type === "object" ||
          binding.node.type === "array" ||
          binding.node.type === "new_expression")
      );
    };
    const member = (node: Node) =>
      (node.type === "subscript_expression" || node.type === "member_expression") &&
      collection(node.childForFieldName("object"));
    if (member(callee)) return this.value(callee, scope, 0);
    if (callee.type !== "identifier") return undefined;
    const binding = this.cx.lookup(callee.text, scope, callee.startIndex);
    if (binding?.kind !== "value" || binding.path !== "") return undefined;
    const source = binding.node;
    const getter =
      source.type === "call_expression" &&
      source.childForFieldName("function")?.type === "member_expression" &&
      nameText(source.childForFieldName("function")?.childForFieldName("property") ?? null) ===
        "get" &&
      collection(source.childForFieldName("function")?.childForFieldName("object") ?? null);
    return member(source) || getter ? this.value(callee, scope, 0) : undefined;
  }

  /** The assignment of the innermost variable or `this` member a member chain starts from. */
  receiver(callee: Node, scope: Scope): number | undefined {
    const chain: Node[] = [];
    let node: Node | null | undefined = WRAPPERS.has(callee.type)
      ? callee.namedChildren[0]
      : callee;
    node = node?.type === "member_expression" ? node.childForFieldName("object") : null;
    while (node != null) {
      if (WRAPPERS.has(node.type)) {
        node = node.namedChildren[0];
        continue;
      }
      chain.push(node);
      node = node.type === "member_expression" ? node.childForFieldName("object") : null;
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

  calleeRef(node: Node, callee: Node, scope: Scope): Ref | null {
    if (callee.type === "import") return this.cx.globalRef("import");
    return node.type === "call_expression" && this.isGlobalRequire(callee, scope)
      ? this.cx.globalRef("require")
      : this.resolve(callee, scope, 0);
  }

  decorator(node: Node, scope: Scope): Decorator {
    const called = node.type === "call_expression";
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
}

/** The class `this` refers to in `scope`, if plenger can tell. */
function thisOwner(scope: Scope): ClassInfo | null {
  return scope.kind === "module" ? null : scope.owner;
}

function heritage(node: Node): Node[] {
  const clause = node.namedChildren.find((child) => child?.type === "class_heritage");
  if (clause == null) return [];
  const bases: Node[] = [];
  for (const child of clause.namedChildren) {
    if (child === null || child.type === "implements_clause") continue;
    if (child.type === "extends_clause") {
      bases.push(
        ...child.childrenForFieldName("value").filter((value): value is Node => value !== null),
      );
    } else {
      bases.push(child);
    }
  }
  return bases;
}

/** Every identifier a parameter or binding pattern introduces. */
function patternNames(node: Node): string[] {
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      return [node.text];
    case "required_parameter":
    case "optional_parameter": {
      const pattern = node.childForFieldName("pattern");
      return pattern === null ? [] : patternNames(pattern);
    }
    case "assignment_pattern":
    case "object_assignment_pattern": {
      const left = node.childForFieldName("left");
      return left === null ? [] : patternNames(left);
    }
    case "pair_pattern": {
      const value = node.childForFieldName("value");
      return value === null ? [] : patternNames(value);
    }
    case "formal_parameters":
    case "object_pattern":
    case "array_pattern":
    case "rest_pattern":
      return node.namedChildren.flatMap((child) => (child === null ? [] : patternNames(child)));
    default:
      return [];
  }
}

function defaultValues(parameter: Node): Node[] {
  const value = parameter.childForFieldName("value") ?? parameter.childForFieldName("right");
  return value === null ? [] : [value];
}

/** The text of an identifier-like node, or the content of a string key. */
function nameText(node: Node | null): string | null {
  if (node === null) return null;
  if (node.type === "string") return node.text.slice(1, -1);
  if (node.type === "computed_property_name") return null;
  return node.text;
}

function stringContent(node: Node | null): string | null {
  return node?.type === "string" ? node.text.slice(1, -1) : null;
}

function joinKey(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}
