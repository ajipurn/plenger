import type { Node } from "web-tree-sitter";
import {
  addBinding,
  type Binding,
  type ClassInfo,
  Context,
  clip,
  compositeValue,
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

/**
 * Facts of a PHP file. Variables keep their `$` (`$name`); functions, classes and
 * constants are named in their own bindings, as PHP keeps them apart from variables.
 * A function body sees only its parameters, its `use` variables and the variables it
 * assigns; an arrow function also sees the enclosing ones. Class and function names
 * resolve through `use` declarations and the file's namespace to fully qualified names
 * (`GuzzleHttp\Client`); a function name nothing defines or imports is the global one.
 * Interpolations show as `{$expr}` in a string's text.
 */
export function extractPhp(root: Node): FileFacts {
  const extractor = new PhpExtractor();
  extractor.visitChildren(root, extractor.cx.module);
  return extractor.cx.finish(extractor);
}

const LITERALS = new Set(["integer", "float", "boolean", "null"]);
/** Returned values that are always false. */
const FALSY = /^(?:false|null|0|''|""|\[\])$/i;
/** Variables PHP fills from the request and the environment. */
const SUPERGLOBALS = new Set([
  "$_GET",
  "$_POST",
  "$_REQUEST",
  "$_COOKIE",
  "$_FILES",
  "$_SERVER",
  "$_ENV",
  "$_SESSION",
  "$GLOBALS",
]);
/** `include` and `require`: recorded as calls of the keyword, and as imports of a literal path. */
const INCLUDES: Record<string, string> = {
  include_expression: "include",
  include_once_expression: "include_once",
  require_expression: "require",
  require_once_expression: "require_once",
};
const CALLS = new Set([
  "function_call_expression",
  "member_call_expression",
  "nullsafe_member_call_expression",
  "scoped_call_expression",
  "object_creation_expression",
  "shell_command_expression",
  ...Object.keys(INCLUDES),
]);
const MEMBER_ACCESS = new Set(["member_access_expression", "nullsafe_member_access_expression"]);
/** Where a bare name is a class: `extends` and `implements`. */
const CLASS_POSITIONS = new Set(["base_clause", "class_interface_clause"]);
const CLASS_DECLARATIONS = new Set([
  "class_declaration",
  "anonymous_class",
  "interface_declaration",
  "trait_declaration",
  "enum_declaration",
]);
/** Statements that leave the enclosing block. */
const EXITS = new Set([
  "return_statement",
  "exit_statement",
  "continue_statement",
  "break_statement",
]);
/** Laravel's `abort()` throws an HTTP exception. */
const NEVER_RETURNS = /^abort$/;
/** Parameter types whose values hold no text. */
const SCALAR = /^\??(?:int|float|bool|true|false)$/i;
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", v: "\v", f: "\f", e: "\x1b" };

/**
 * The values an `if` test limits while it is `truth`: `$x === "a"` and
 * `in_array($x, LIST)` when they hold, `$x !== "a"` when it fails,
 * `str_contains($x, "..")` and `str_starts_with($x, "/")` when they fail,
 * `str_starts_with($x, $base)` and `str_ends_with($x, ".json")` when they hold, through
 * `!`, parentheses, `&&` (holding) and `||` (failing).
 */
function limits(node: Node, truth: boolean): Limit[] {
  switch (node.type) {
    case "parenthesized_expression": {
      const inner = node.namedChildren[0];
      return inner == null ? [] : limits(inner, truth);
    }
    case "unary_op_expression": {
      const argument = node.childForFieldName("argument");
      return argument !== null && operatorOf(node) === "!" ? limits(argument, !truth) : [];
    }
    case "binary_expression": {
      const operator = operatorOf(node)?.toLowerCase();
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left === null || right === null || operator === undefined) return [];
      if (
        ((operator === "&&" || operator === "and") && truth) ||
        ((operator === "||" || operator === "or") && !truth)
      )
        return [...limits(left, truth), ...limits(right, truth)];
      const equal = operator === "===" || operator === "==";
      const unequal = operator === "!==" || operator === "!=" || operator === "<>";
      if (!equal && !unequal) return [];
      const [tested, flag] = right.type === "boolean" ? [left, right] : [right, left];
      if (flag.type === "boolean") {
        // `strpos($x, "..") === false` holding, or `!== false` failing: no such text.
        const [subject, needle] = callArguments(tested);
        const absent = flag.text.toLowerCase() === "false" && equal === truth;
        if (
          tested.type === "function_call_expression" &&
          /^(?:strpos|stripos|mb_strpos)$/i.test(functionName(tested)) &&
          subject !== undefined &&
          needle !== undefined &&
          isString(needle)
        )
          return absent ? [{ subject, allowed: needle, test: "excludes" }] : [];
        // `in_array(...) === false` is `!in_array(...)`.
        const holds = (flag.text.toLowerCase() === "true") === equal;
        return limits(tested, holds ? truth : !truth);
      }
      // `$rel !== ".."` holding: the value is not that text.
      if (isString(right) && ((unequal && truth) || (equal && !truth)))
        return [{ subject: left, allowed: right, test: "differs" }];
      if (!((equal && truth) || (unequal && !truth))) return [];
      return isLiteral(left)
        ? [{ subject: right, allowed: left }]
        : [{ subject: left, allowed: right }];
    }
    case "function_call_expression": {
      const name = functionName(node).toLowerCase();
      const [first, second] = callArguments(node);
      if (name === "") return [];
      if (!truth) {
        // `str_contains($x, "..")` failing: the value does not contain that text.
        if (name === "str_contains" && first && second && isString(second))
          return [{ subject: first, allowed: second, test: "excludes" }];
        if (name === "str_starts_with" && first && second && isString(second)) {
          if (/^[/\\]+$/.test(stringText(second)))
            return [{ subject: first, allowed: second, test: "relative" }];
          if (/^\.\.[/\\]?$/.test(stringText(second)))
            return [{ subject: first, allowed: second, test: "descends" }];
        }
        return [];
      }
      if (name === "in_array" && first && second) return [{ subject: first, allowed: second }];
      if (name === "array_key_exists" && first && second)
        return [{ subject: first, allowed: second }];
      if (name === "str_starts_with" && first && second)
        return [{ subject: first, allowed: second, test: "within" }];
      if (name === "str_ends_with" && first && second && isString(second))
        return [{ subject: first, allowed: second, test: "ends" }];
      // `is_within($base, $path)` holding: what the function checks, read later.
      return node.childForFieldName("function")?.type === "name"
        ? [{ subject: node, allowed: node, test: "call" }]
        : [];
    }
    default:
      return [];
  }
}

/** The operator of a unary or binary expression: its unnamed token. */
function operatorOf(node: Node): string | undefined {
  return (
    node.childForFieldName("operator")?.type ??
    node.children.find((child) => child !== null && !child.isNamed)?.type
  );
}

/** The name a plain function call is made by (`in_array`), or "". */
function functionName(call: Node): string {
  const callee = call.childForFieldName("function");
  return callee?.type === "name" ? callee.text : "";
}

/** The expressions passed to a call, without names or spreads. */
function callArguments(call: Node): Node[] {
  return (call.childForFieldName("arguments")?.namedChildren ?? []).flatMap((argument) => {
    const value = argument?.type === "argument" ? argumentValue(argument) : null;
    return value === null || argument?.childForFieldName("name") ? [] : [value];
  });
}

function argumentValue(argument: Node): Node | null {
  const name = argument.childForFieldName("name");
  return argument.namedChildren.find((child) => child !== null && child.id !== name?.id) ?? null;
}

function isString(node: Node): boolean {
  return (
    node.type === "string" ||
    (node.type === "encapsed_string" &&
      node.namedChildren.every(
        (part) => part?.type === "string_content" || part?.type === "escape_sequence",
      ))
  );
}

function isLiteral(node: Node): boolean {
  return LITERALS.has(node.type) || isString(node);
}

/** The text of a string without interpolations, its escapes decoded. */
function stringText(node: Node): string {
  return node.namedChildren
    .map((part) =>
      part?.type === "string_content"
        ? part.text
        : part?.type === "escape_sequence"
          ? decodeEscape(part.text, node.type === "string")
          : "",
    )
    .join("");
}

/** `\n` and the other escapes of double quotes; only `\'` and `\\` in single quotes. */
function decodeEscape(text: string, single: boolean): string {
  const char = text.slice(1);
  if (single) return char === "'" || char === "\\" ? char : text;
  return ESCAPES[char] ?? (/^[\\$"]$/.test(char) ? char : text);
}

/**
 * How a block's last statement leaves it: no calls for `return`, `throw`, `exit`,
 * `continue` and `break`, the call for one that may never return (`abort(403)`), and
 * null when it does not leave.
 */
function exits(block: Node | null): Node[] | null {
  if (block === null) return null;
  const last =
    block.type === "compound_statement" || block.type === "colon_block"
      ? block.namedChildren.filter((child) => child?.type !== "comment").at(-1)
      : block;
  if (last == null) return null;
  if (EXITS.has(last.type)) return [];
  const expression = last.type === "expression_statement" ? last.namedChildren[0] : null;
  if (expression?.type === "throw_expression") return [];
  if (expression?.type === "function_call_expression")
    return /^(?:exit|die)$/i.test(functionName(expression)) ? [] : [expression];
  return null;
}

/** The PHPDoc comment right before a declaration, without its markers. */
function phpDoc(node: Node): string | null {
  const previous = node.previousNamedSibling;
  if (previous?.type !== "comment" || !previous.text.startsWith("/**")) return null;
  const text = previous.text
    .replace(/^\/\*\*|\*\/$/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n")
    .trim();
  return text === "" ? null : clip(text, LIMITS.doc);
}

class PhpExtractor implements LanguageHooks {
  readonly cx = new Context("php");
  /** The namespace the code is in, without a leading `\`. */
  #namespace = "";
  /** `use` aliases by kind, lowercased for classes and functions, to fully qualified names. */
  readonly #uses = {
    class: new Map<string, string>(),
    function: new Map<string, string>(),
    const: new Map<string, string>(),
  };

  // Phase one: scopes, bindings and the nodes to describe.

  visitChildren(node: Node, scope: Scope): void {
    for (const child of node.namedChildren) if (child !== null) this.visit(child, scope);
  }

  visit(node: Node, scope: Scope): void {
    switch (node.type) {
      case "comment":
      case "text":
      case "php_tag":
      case "text_interpolation":
        return;
      case "namespace_definition": {
        const name = node.childForFieldName("name")?.text ?? "";
        const body = node.childForFieldName("body");
        if (body === null) {
          this.#namespace = name;
          return;
        }
        const outer = this.#namespace;
        this.#namespace = name;
        this.visitChildren(body, scope);
        this.#namespace = outer;
        return;
      }
      case "namespace_use_declaration":
        this.use(node, scope);
        return;
      case "function_definition":
        this.definition(node, scope, "function");
        return;
      case "method_declaration":
        this.definition(node, scope, "method");
        return;
      case "anonymous_function":
      case "arrow_function":
        this.closure(node, scope, null);
        return;
      case "property_declaration":
        for (const element of node.namedChildren) {
          if (element?.type !== "property_element") continue;
          const name = element.childForFieldName("name");
          const value = element.childForFieldName("default_value");
          if (name !== null && value !== null) this.member(name, value, scope);
          if (value !== null) this.visit(value, scope);
        }
        return;
      case "const_declaration":
        for (const element of node.namedChildren) {
          if (element?.type !== "const_element") continue;
          const [name, value] = element.namedChildren;
          if (name == null || value == null) continue;
          if (scope.kind === "class") this.member(name, value, scope);
          else scope.bind(`const:${name.text}`, this.cx.assign(name, value, scope, node.endIndex));
          this.visit(value, scope);
        }
        return;
      case "assignment_expression":
      case "reference_assignment_expression": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left === null || right === null) break;
        if (
          left.type === "variable_name" &&
          (right.type === "anonymous_function" || right.type === "arrow_function")
        ) {
          const id = this.closure(right, scope, left.text.slice(1));
          scope.bind(left.text, { kind: "definition", definition: id, offset: node.startIndex });
          return;
        }
        this.bindTarget(left, right, scope, node.endIndex);
        this.visit(right, scope);
        return;
      }
      case "augmented_assignment_expression": {
        const left = node.childForFieldName("left");
        if (left?.type === "subscript_expression") this.mutated(left, scope);
        break;
      }
      case "unset_statement":
        for (const target of node.namedChildren)
          if (target?.type === "subscript_expression") this.mutated(target, scope);
        break;
      case "global_declaration":
        for (const name of node.namedChildren)
          if (name?.type === "variable_name")
            scope.bind(name.text, { kind: "unknown", offset: node.endIndex });
        return;
      case "static_variable_declaration": {
        const name = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        if (name !== null && value !== null) {
          scope.bind(name.text, this.cx.assign(name, value, scope, node.endIndex));
          this.visit(value, scope);
        } else if (name !== null) scope.bind(name.text, { kind: "unknown", offset: node.endIndex });
        return;
      }
      case "foreach_statement": {
        const [iterable, target] = node.namedChildren;
        if (iterable != null && target != null) {
          this.visit(iterable, scope);
          this.bindLoop(target, iterable, scope, node.startIndex);
        }
        const body = node.childForFieldName("body");
        if (body !== null) this.visit(body, scope);
        return;
      }
      case "return_statement": {
        const value = node.namedChildren[0];
        if (value != null)
          this.cx.addReturn(value, scope, limits(value, true), FALSY.test(value.text));
        break;
      }
      case "if_statement": {
        const condition = node.childForFieldName("condition");
        const body = node.childForFieldName("body");
        if (condition === null) break;
        const leaving = exits(body);
        this.cx.addGuards(
          node,
          scope,
          body,
          limits(condition, true),
          leaving === null ? null : limits(condition, false),
          node.parent,
          leaving ?? [],
        );
        break;
      }
      default:
        if (CALLS.has(node.type)) {
          this.cx.addCall(node, scope);
          if (node.type in INCLUDES) this.include(node, scope);
        } else if (CLASS_DECLARATIONS.has(node.type)) {
          this.classDefinition(node, scope);
          return;
        }
    }
    this.visitChildren(node, scope);
  }

  use(node: Node, scope: Scope): void {
    // `use function` and `use const` mark each clause, or the whole group.
    const kindOf = (clause: Node) => {
      const type = (clause.childForFieldName("type") ?? node.childForFieldName("type"))?.text;
      const lower = type?.toLowerCase();
      return lower === "function" || lower === "const" ? lower : "class";
    };
    // `use App\Models\{User, Post as P}`: the group's clauses extend its prefix.
    const group = node.childForFieldName("body");
    const prefix =
      group === null
        ? ""
        : `${node.namedChildren.find((child) => child?.type === "namespace_name")?.text ?? ""}\\`;
    const clauses = (group ?? node).namedChildren.filter(
      (child) => child?.type === "namespace_use_clause",
    );
    for (const clause of clauses) {
      if (clause === null) continue;
      const alias = clause.childForFieldName("alias")?.text;
      const named = clause.namedChildren.find(
        (child) => child?.type === "qualified_name" || child?.type === "name",
      );
      if (named == null) continue;
      const module = trimSlash(prefix + named.text);
      const local = alias ?? module.slice(module.lastIndexOf("\\") + 1);
      const kind = kindOf(clause);
      this.#uses[kind].set(kind === "const" ? local : local.toLowerCase(), module);
      this.cx.imports.push({
        module,
        imported: null,
        local,
        kind: "module",
        typeOnly: false,
        scope: scope.definition,
        span: spanOf(node),
      });
    }
  }

  include(node: Node, scope: Scope): void {
    const path = node.namedChildren[0];
    if (path == null || !isString(path)) return;
    this.cx.imports.push({
      module: stringText(path),
      imported: null,
      local: null,
      kind: "require",
      typeOnly: false,
      scope: scope.definition,
      span: spanOf(node),
    });
  }

  definition(node: Node, scope: Scope, kind: "function" | "method"): void {
    const name = node.childForFieldName("name")?.text ?? null;
    const id = this.cx.allocateId(scope.definition, name, node);
    const parameters = node.childForFieldName("parameters");
    const fact: DefinitionFact = {
      id,
      name,
      kind,
      parent: scope.definition,
      async: false,
      exported: scope.kind === "module" && name !== null,
      params: this.params(parameters),
      decorators: [],
      bases: [],
      doc: phpDoc(node),
      span: spanOf(node),
    };
    const scalars = this.scalars(parameters);
    if (scalars.length > 0) fact.scalars = scalars;
    this.cx.addDefinition(fact, scope, this.attributes(node), []);
    if (name !== null) {
      const binding = { kind: "definition" as const, definition: id, offset: node.startIndex };
      if (kind === "method" && scope.owner !== null)
        addBinding(scope.owner.members, name.toLowerCase(), binding);
      // Functions are global wherever they are declared.
      else this.cx.module.bind(`function:${name.toLowerCase()}`, binding);
    }
    // A function sees none of the variables around it.
    const inner = new Scope("function", id, null, kind === "method" ? scope.owner : null);
    this.bindParams(parameters, scope, inner, node.startIndex);
    const isStatic = node.namedChildren.some((child) => child?.type === "static_modifier");
    if (kind === "method" && scope.owner !== null && !isStatic)
      inner.bind("$this", { kind: "receiver", owner: scope.owner, offset: node.startIndex });
    const body = node.childForFieldName("body");
    if (body !== null) this.visitChildren(body, inner);
  }

  classDefinition(node: Node, scope: Scope): void {
    const name = node.childForFieldName("name")?.text ?? null;
    const id = this.cx.allocateId(scope.definition, name, node);
    const bases = node.namedChildren.flatMap((child) =>
      child?.type === "base_clause" || child?.type === "class_interface_clause"
        ? child.namedChildren.filter((base): base is Node => base !== null)
        : [],
    );
    this.cx.addDefinition(
      {
        id,
        name,
        kind: "class",
        parent: scope.definition,
        async: false,
        exported: scope.kind === "module" && name !== null,
        params: [],
        decorators: [],
        bases: [],
        doc: phpDoc(node),
        span: spanOf(node),
      },
      scope,
      this.attributes(node),
      bases,
    );
    if (name !== null)
      this.cx.module.bind(`class:${name.toLowerCase()}`, {
        kind: "definition",
        definition: id,
        offset: node.startIndex,
      });
    const owner: ClassInfo = { definition: id, members: new Map() };
    this.cx.classes.set(id, owner);
    const body = node.childForFieldName("body");
    if (body !== null) this.visitChildren(body, new Scope("class", id, scope, owner));
  }

  /** An anonymous function or arrow function; `name` is the variable it is assigned to. */
  closure(node: Node, scope: Scope, name: string | null): string {
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
      this.attributes(node),
      [],
    );
    this.cx.markInline(node, id);
    // An arrow function sees the variables around it; an anonymous function only those it `use`s.
    const arrow = node.type === "arrow_function";
    const inner = new Scope("function", id, arrow ? scope : null, scope.owner);
    const self = this.receiverBindings(scope);
    if (!arrow && self !== undefined) for (const binding of self) inner.bind("$this", binding);
    for (const clause of node.namedChildren) {
      if (clause?.type !== "anonymous_function_use_clause") continue;
      for (const variable of clause.namedChildren) {
        const used = variable?.type === "by_ref" ? variable.namedChildren[0] : variable;
        if (used?.type !== "variable_name") continue;
        const outer = this.cx.lookup(used.text, scope, node.startIndex);
        inner.bind(used.text, outer ?? { kind: "unknown", offset: node.startIndex });
      }
    }
    this.bindParams(parameters, scope, inner, node.startIndex);
    const body = node.childForFieldName("body");
    if (body !== null) {
      if (arrow && body.type !== "compound_statement")
        this.cx.addReturn(body, inner, limits(body, true), FALSY.test(body.text));
      if (body.type === "compound_statement") this.visitChildren(body, inner);
      else this.visit(body, inner);
    }
    return id;
  }

  /** `$this` as the method around `scope` binds it, for a closure inside that method. */
  receiverBindings(scope: Scope): Binding[] | undefined {
    for (let current: Scope | null = scope; current !== null; current = current.parent) {
      const bindings = current.bindings.get("$this");
      if (bindings !== undefined) return bindings;
    }
    return undefined;
  }

  /** PHP 8 attributes (`#[Route('/x')]`), described as decorators. */
  attributes(node: Node): Node[] {
    const list = node.childForFieldName("attributes");
    return (list?.namedChildren ?? []).flatMap((group) =>
      (group?.namedChildren ?? []).filter((item): item is Node => item?.type === "attribute"),
    );
  }

  params(parameters: Node | null): string[] {
    const names: string[] = [];
    for (const parameter of parameters?.namedChildren ?? []) {
      const name = parameter?.childForFieldName("name");
      if (name?.type === "variable_name") names.push(name.text);
    }
    return names;
  }

  /** Parameters typed as a number or boolean (`int $id`). */
  scalars(parameters: Node | null): string[] {
    const names: string[] = [];
    for (const parameter of parameters?.namedChildren ?? []) {
      const name = parameter?.childForFieldName("name");
      const type = parameter?.childForFieldName("type")?.text.replace(/\s+/g, "");
      if (name?.type === "variable_name" && type !== undefined && SCALAR.test(type))
        names.push(name.text);
    }
    return names;
  }

  bindParams(parameters: Node | null, outer: Scope, inner: Scope, offset: number): void {
    for (const parameter of parameters?.namedChildren ?? []) {
      if (parameter === null) continue;
      const name = parameter.childForFieldName("name");
      if (name?.type === "variable_name") inner.bind(name.text, { kind: "param", offset });
      const fallback = parameter.childForFieldName("default_value");
      if (fallback !== null) this.visit(fallback, outer);
    }
  }

  bindTarget(target: Node, value: Node, scope: Scope, offset: number): void {
    switch (target.type) {
      case "variable_name":
        scope.bind(target.text, this.cx.assign(target, value, scope, offset));
        return;
      case "member_access_expression": {
        const object = target.childForFieldName("object");
        const name = target.childForFieldName("name");
        const owner = object === null ? null : this.receiverOf(object, scope);
        const binding = this.cx.assign(target, value, scope, offset);
        if (owner !== null && name?.type === "name")
          addBinding(owner.members, name.text.toLowerCase(), binding);
        return;
      }
      case "subscript_expression":
        this.mutated(target, scope);
        return;
      case "list_literal":
        // `[$a, $b] = explode(",", $s)`: each name holds an item of the value.
        for (const item of target.namedChildren) {
          const name = item?.type === "by_ref" ? item.namedChildren[0] : item;
          if (name?.type === "variable_name")
            scope.bind(name.text, this.cx.assign(name, value, scope, offset, LOOP_ITEM));
          else if (name?.type === "list_literal") this.bindTarget(name, value, scope, offset);
        }
        return;
    }
  }

  /** A class member from its declaration: a property's default or a constant's value. */
  member(name: Node, value: Node, scope: Scope): void {
    if (scope.owner === null) return;
    const key = name.type === "variable_name" ? name.text.slice(1) : name.text;
    addBinding(
      scope.owner.members,
      key.toLowerCase(),
      this.cx.assign(name, value, scope, value.endIndex),
    );
  }

  /** `foreach ($items as $item)` and `foreach ($pairs as $key => $value)`. */
  bindLoop(target: Node, iterable: Node, scope: Scope, offset: number): void {
    const item = (node: Node | null | undefined) =>
      node?.type === "by_ref" ? node.namedChildren[0] : node;
    if (target.type === "pair") {
      const [key, value] = target.namedChildren.map(item);
      if (key?.type === "variable_name") scope.bind(key.text, { kind: "unknown", offset });
      if (value?.type === "variable_name")
        scope.bind(value.text, this.cx.assign(value, iterable, scope, offset, LOOP_ITEM));
      else if (value?.type === "list_literal") this.bindTarget(value, iterable, scope, offset);
      return;
    }
    const value = item(target);
    if (value?.type === "variable_name")
      scope.bind(value.text, this.cx.assign(value, iterable, scope, offset, LOOP_ITEM));
    else if (value?.type === "list_literal") this.bindTarget(value, iterable, scope, offset);
  }

  /** `$items["k"] = $v` and `unset($items["k"])` change the array `$items` holds. */
  mutated(target: Node, scope: Scope): void {
    let base: Node | null = target;
    while (base?.type === "subscript_expression") base = base.namedChildren[0] ?? null;
    if (base?.type === "variable_name") this.cx.markMutatedName(base.text, scope, base.startIndex);
  }

  /** The class whose instance `node` is, when it is `$this` in a method. */
  receiverOf(node: Node, scope: Scope): ClassInfo | null {
    if (node.type !== "variable_name" || node.text !== "$this") return null;
    const binding = this.cx.lookup("$this", scope, node.startIndex);
    return binding?.kind === "receiver" ? binding.owner : null;
  }

  // Phase two: resolution and value summaries.

  /** A class name: `self` and `static`, a `use` alias, a class in this file or the namespace's. */
  classRef(node: Node, scope: Scope): Ref | null {
    if (node.type === "relative_scope") {
      const owner = scope.owner;
      return owner === null || node.text.toLowerCase() === "parent"
        ? null
        : this.cx.localRef(owner.definition, "");
    }
    if (node.type !== "name" && node.type !== "qualified_name") return null;
    return this.qualified(node.text, "class");
  }

  /** A function name: a `use function` alias, a function in this file, or the global one. */
  functionRef(node: Node): Ref | null {
    if (node.type !== "name" && node.type !== "qualified_name") return null;
    return this.qualified(node.text, "function");
  }

  qualified(text: string, kind: "class" | "function" | "const"): Ref {
    if (text.startsWith("\\")) return this.cx.globalRef(text.slice(1));
    const [head = text, ...rest] = text.split("\\");
    const key = kind === "const" ? head : head.toLowerCase();
    if (rest.length === 0) {
      const used = this.#uses[kind].get(key);
      if (used !== undefined) return this.cx.importRef(used, "");
      const local = this.cx.module.bindings.get(`${kind}:${key}`)?.at(-1);
      if (local !== undefined) {
        const ref = this.cx.resolveBinding(local, 0);
        if (ref !== null) return ref;
      }
      // An unknown function or constant falls back to the global one; a class does not.
      if (kind !== "class" || this.#namespace === "") return this.cx.globalRef(text);
      return this.cx.globalRef(`${this.#namespace}\\${text}`);
    }
    // `Models\User` through `use App\Models`.
    const namespace = this.#uses.class.get(head.toLowerCase());
    if (namespace !== undefined) return this.cx.importRef([namespace, ...rest].join("\\"), "");
    return this.cx.globalRef(this.#namespace === "" ? text : `${this.#namespace}\\${text}`);
  }

  resolve(node: Node, scope: Scope, depth: number): Ref | null {
    if (depth > LIMITS.resolveDepth) return null;
    switch (node.type) {
      case "variable_name": {
        const binding = this.cx.lookup(node.text, scope, node.startIndex);
        if (binding !== undefined) return this.cx.resolveBinding(binding, depth);
        return SUPERGLOBALS.has(node.text) ? this.cx.globalRef(node.text) : null;
      }
      case "name":
      case "qualified_name":
        return this.qualified(
          node.text,
          CLASS_POSITIONS.has(node.parent?.type ?? "") ? "class" : "const",
        );
      case "member_access_expression":
      case "nullsafe_member_access_expression":
      case "member_call_expression":
      case "nullsafe_member_call_expression": {
        const object = node.childForFieldName("object");
        const name = node.childForFieldName("name");
        if (object === null || name?.type !== "name") return null;
        const member = this.memberRef(object, name.text, scope, depth);
        return member === null || !node.type.endsWith("call_expression")
          ? member
          : this.cx.extend(member, "()");
      }
      case "scoped_call_expression":
      case "scoped_property_access_expression":
      case "class_constant_access_expression": {
        const member = this.staticRef(node, scope, depth);
        return member === null || node.type !== "scoped_call_expression"
          ? member
          : this.cx.extend(member, "()");
      }
      case "function_call_expression": {
        const callee = node.childForFieldName("function");
        const base =
          callee === null
            ? null
            : callee.type === "name" || callee.type === "qualified_name"
              ? this.functionRef(callee)
              : this.resolve(callee, scope, depth + 1);
        return base === null ? null : this.cx.extend(base, "()");
      }
      case "object_creation_expression": {
        const base = this.newRef(node, scope);
        return base === null ? null : this.cx.extend(base, "()");
      }
      case "subscript_expression": {
        // `$_GET["page"]` reads a member named by a string.
        const [object, key] = node.namedChildren;
        if (object == null || key == null || !isString(key)) return null;
        const base = this.resolve(object, scope, depth + 1);
        return base === null ? null : this.cx.extend(base, stringText(key));
      }
      case "parenthesized_expression": {
        const inner = node.namedChildren[0];
        return inner == null ? null : this.resolve(inner, scope, depth + 1);
      }
      default:
        return null;
    }
  }

  /** `$object->name`: a member `$this` assigns or defines, or the member of what the object is. */
  memberRef(object: Node, name: string, scope: Scope, depth: number): Ref | null {
    const owner = this.receiverOf(object, scope);
    if (owner !== null) return this.cx.resolveMember(owner, name.toLowerCase(), depth + 1);
    const base = this.resolve(object, scope, depth + 1);
    return base === null ? null : this.cx.extend(base, name);
  }

  /** `Class::name`, `Class::$name` and `Class::CONSTANT`, through the class's members for `self`. */
  staticRef(node: Node, scope: Scope, depth: number): Ref | null {
    const [first, second] = node.namedChildren;
    const target = node.childForFieldName("scope") ?? first;
    const nameNode = node.childForFieldName("name") ?? second;
    if (target == null || nameNode == null) return null;
    const name = nameNode.type === "variable_name" ? nameNode.text.slice(1) : nameNode.text;
    if (nameNode.type !== "name" && nameNode.type !== "variable_name") return null;
    const self = target.type === "relative_scope" && target.text.toLowerCase() !== "parent";
    if (self && scope.owner !== null)
      return this.cx.resolveMember(scope.owner, name.toLowerCase(), depth + 1);
    const base =
      target.type === "variable_name"
        ? this.resolve(target, scope, depth + 1)
        : this.classRef(target, scope);
    return base === null ? null : this.cx.extend(base, name);
  }

  /** The class `new` makes: a name, or what a variable holds (`new $class`). */
  newRef(node: Node, scope: Scope): Ref | null {
    const target = node.namedChildren.find((child) => child?.type !== "arguments");
    if (target == null || target.type === "anonymous_class") return null;
    return target.type === "variable_name"
      ? this.resolve(target, scope, 1)
      : this.classRef(target, scope);
  }

  value(node: Node, scope: Scope, depth: number): Value {
    if (depth > LIMITS.valueDepth) return otherValue(node);
    if (LITERALS.has(node.type)) return { kind: "literal", text: node.text };
    switch (node.type) {
      case "string":
      case "nowdoc":
        return stringValue(node.type === "nowdoc" ? nowdocText(node) : stringText(node), null);
      case "encapsed_string":
      case "heredoc":
        return this.template(
          node.type === "heredoc" ? node.childForFieldName("value") : node,
          scope,
          depth,
        );
      case "variable_name":
      case "name":
      case "qualified_name":
      case "member_access_expression":
      case "nullsafe_member_access_expression":
      case "scoped_property_access_expression":
      case "class_constant_access_expression":
        return this.name(node, scope);
      case "subscript_expression": {
        const key = node.namedChildren[1];
        if (key != null && isString(key)) return this.name(node, scope);
        const lookup = this.composite(node, scope, depth);
        if (lookup.kind === "other" && lookup.parts !== undefined) lookup.subscript = true;
        return lookup;
      }
      case "anonymous_function":
      case "arrow_function": {
        const id = this.cx.inlineDefinition(node);
        return id === undefined ? otherValue(node) : { kind: "function", definition: id };
      }
      case "array_creation_expression":
        return this.array(node, scope, depth);
      case "binary_expression": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (operatorOf(node) === "." && left !== null && right !== null) {
          const parts = [this.value(left, scope, depth + 1), this.value(right, scope, depth + 1)];
          return { kind: "concat", parts: parts.flatMap(flattenConcat) };
        }
        return this.composite(node, scope, depth);
      }
      case "assignment_expression":
      case "parenthesized_expression": {
        const inner =
          node.type === "assignment_expression"
            ? node.childForFieldName("right")
            : node.namedChildren[0];
        return inner == null ? otherValue(node) : this.value(inner, scope, depth);
      }
      case "cast_expression": {
        const inner = node.childForFieldName("value");
        const other = otherValue(node);
        if (inner !== null && other.kind === "other")
          other.parts = [this.value(inner, scope, depth + 1)];
        return other;
      }
    }
    if (CALLS.has(node.type)) {
      const index = this.cx.callIndex(node);
      return index === undefined ? otherValue(node) : { kind: "call", call: index };
    }
    return this.composite(node, scope, depth);
  }

  composite(node: Node, scope: Scope, depth: number): Value {
    return compositeValue(node, (operand) => this.value(operand, scope, depth + 1));
  }

  /** A double-quoted string, heredoc or backtick command, its interpolations as `{$expr}`. */
  template(node: Node | null, scope: Scope, depth: number): Value {
    if (node === null) return stringValue("", null);
    const template: Value[] = [];
    let text = "";
    for (const part of node.namedChildren) {
      if (part === null) continue;
      if (part.type === "string_content") text += part.text;
      else if (part.type === "escape_sequence") text += decodeEscape(part.text, false);
      else if (part.type === "dynamic_variable_name") {
        // `${name}`, the old spelling of `{$name}`.
        text += `{$${part.namedChildren[0]?.text ?? ""}}`;
        template.push(otherValue(part));
      } else {
        text += `{${part.text}}`;
        template.push(this.value(part, scope, depth + 1));
      }
    }
    return stringValue(text, template.length > 0 ? template : null);
  }

  /** An array literal: a list, or an object when any element has a key. */
  array(node: Node, scope: Scope, depth: number): Value {
    const elements = node.namedChildren.filter(
      (element): element is Node => element?.type === "array_element_initializer",
    );
    const keyed = elements.some((element) => element.namedChildren.length === 2);
    if (!keyed)
      return listValue(
        elements.map((element) => element.namedChildren[0] ?? element),
        (item) =>
          item.type === "variadic_unpacking"
            ? otherValue(item)
            : this.value(item, scope, depth + 1),
      );
    const entries = elements.slice(0, LIMITS.items).map((element) => {
      const [first, second] = element.namedChildren;
      if (second == null)
        return {
          key: null,
          value:
            first == null || first.type === "variadic_unpacking"
              ? otherValue(element)
              : this.value(first, scope, depth + 1),
        };
      return {
        key: first != null && isString(first) ? stringText(first) : null,
        value: this.value(second, scope, depth + 1),
      };
    });
    const result: Value = { kind: "object", entries };
    if (elements.length > LIMITS.items) result.truncated = true;
    return result;
  }

  name(node: Node, scope: Scope): Value {
    let root = node;
    while (MEMBER_ACCESS.has(root.type) || root.type === "subscript_expression") {
      const object =
        root.type === "subscript_expression"
          ? root.namedChildren[0]
          : root.childForFieldName("object");
      if (object == null) break;
      root = object;
    }
    const value: Value = { kind: "name", text: textOf(node), ref: this.resolve(node, scope, 0) };
    if (CALLS.has(root.type)) {
      const call = this.cx.callIndex(root);
      if (call !== undefined) value.of = call;
    }
    if (root.type === "name" && root === node) {
      // A constant this file defines (`const ALLOWED = [...]`).
      const assignment = this.cx.assignmentOf(
        this.cx.module.bindings.get(`const:${root.text}`)?.at(-1),
      );
      if (assignment !== undefined) value.assignment = assignment;
      return value;
    }
    if (root.type !== "variable_name") {
      const assignment = this.cx.assignmentOf(this.memberOf(node, scope));
      if (assignment !== undefined) value.assignment = assignment;
      return value;
    }
    const binding = this.cx.lookup(root.text, scope, root.startIndex);
    if (binding?.kind === "param") value.param = true;
    const assignment = this.cx.assignmentOf(root === node ? binding : this.memberOf(node, scope));
    if (assignment !== undefined) value.assignment = assignment;
    const base = root === node ? undefined : this.cx.assignmentOf(binding);
    if (assignment === undefined && base !== undefined) value.base = base;
    return value;
  }

  /** The member binding behind `$this->name`, `self::NAME` and `static::$name`. */
  memberOf(node: Node, scope: Scope): Binding | undefined {
    if (
      node.type === "class_constant_access_expression" ||
      node.type === "scoped_property_access_expression"
    ) {
      const [first, second] = node.namedChildren;
      const target = node.childForFieldName("scope") ?? first;
      const name = node.childForFieldName("name") ?? second;
      const self = target?.type === "relative_scope" && target.text.toLowerCase() !== "parent";
      if (!self || scope.owner === null || name == null) return undefined;
      const key = name.type === "variable_name" ? name.text.slice(1) : name.text;
      return this.cx.memberBinding(scope.owner, key.toLowerCase());
    }
    if (!MEMBER_ACCESS.has(node.type)) return undefined;
    const object = node.childForFieldName("object");
    const name = node.childForFieldName("name");
    const owner = object === null ? null : this.receiverOf(object, scope);
    return owner === null || name?.type !== "name"
      ? undefined
      : this.cx.memberBinding(owner, name.text.toLowerCase());
  }

  arguments(node: Node | null, scope: Scope): Argument[] {
    const args: Argument[] = [];
    for (const arg of node?.namedChildren ?? []) {
      if (arg?.type !== "argument") continue;
      if (args.length >= LIMITS.items) break;
      const value = argumentValue(arg);
      if (value === null) continue;
      // A named argument is matched to its parameter, so it keeps the `$`.
      const name = arg.childForFieldName("name")?.text;
      if (value.type === "variadic_unpacking") {
        const inner = value.namedChildren[0];
        args.push({
          keyword: null,
          spread: true,
          value: inner == null ? otherValue(value) : this.value(inner, scope, 0),
        });
      } else
        args.push({
          keyword: name === undefined ? null : `$${name}`,
          value: this.value(value, scope, 0),
        });
    }
    return args;
  }

  call(node: Node, scope: Scope): CallFact {
    const fact: CallFact = {
      callee: "",
      ref: null,
      new: node.type === "object_creation_expression",
      scope: scope.definition,
      arguments: this.arguments(node.childForFieldName("arguments") ?? argumentsOf(node), scope),
      span: spanOf(node),
    };
    switch (node.type) {
      case "function_call_expression": {
        const callee = node.childForFieldName("function");
        fact.callee = callee === null ? "" : textOf(callee);
        fact.ref =
          callee === null
            ? null
            : callee.type === "name" || callee.type === "qualified_name"
              ? this.functionRef(callee)
              : this.resolve(callee, scope, 0);
        break;
      }
      case "member_call_expression":
      case "nullsafe_member_call_expression": {
        const object = node.childForFieldName("object");
        const name = node.childForFieldName("name");
        const arrow = node.type === "member_call_expression" ? "->" : "?->";
        fact.callee = clip(
          `${object?.text ?? ""}${arrow}${name?.text ?? ""}`.replace(/\s+/g, " "),
          LIMITS.text,
        );
        fact.ref =
          object === null || name?.type !== "name"
            ? null
            : this.memberRef(object, name.text, scope, 0);
        const receiver = object === null ? undefined : this.receiver(object, scope);
        if (receiver !== undefined) fact.receiver = receiver;
        if (object?.type === "parenthesized_expression") fact.object = this.value(object, scope, 0);
        break;
      }
      case "scoped_call_expression": {
        const target = node.childForFieldName("scope");
        const name = node.childForFieldName("name");
        fact.callee = clip(
          `${target?.text ?? ""}::${name?.text ?? ""}`.replace(/\s+/g, " "),
          LIMITS.text,
        );
        fact.ref = this.staticRef(node, scope, 0);
        break;
      }
      case "object_creation_expression": {
        const target = node.namedChildren.find((child) => child?.type !== "arguments");
        fact.callee = target == null ? "" : textOf(target);
        fact.ref = this.newRef(node, scope);
        break;
      }
      case "shell_command_expression":
        // Backticks run their text in a shell, like `shell_exec()`.
        fact.callee = textOf(node);
        fact.ref = this.cx.globalRef("shell_exec");
        fact.arguments = [{ keyword: null, value: this.template(node, scope, 0) }];
        break;
      default: {
        const keyword = INCLUDES[node.type] ?? node.type;
        const path = node.namedChildren[0];
        fact.callee = keyword;
        fact.ref = this.cx.globalRef(keyword);
        fact.arguments = path == null ? [] : [{ keyword: null, value: this.value(path, scope, 0) }];
      }
    }
    return fact;
  }

  neverReturns(node: Node, scope: Scope): boolean {
    if (node.type !== "function_call_expression") return false;
    const ref = this.resolve(node.childForFieldName("function") ?? node, scope, 0);
    return ref?.kind === "global" && NEVER_RETURNS.test(ref.name);
  }

  decorator(node: Node, scope: Scope): Decorator {
    const name = node.namedChildren.find(
      (child) => child?.type === "name" || child?.type === "qualified_name",
    );
    const parameters = node.childForFieldName("parameters");
    return {
      text: textOf(node),
      ref: name == null ? null : this.classRef(name, scope),
      arguments: parameters === null ? null : this.arguments(parameters, scope),
      span: spanOf(node),
    };
  }

  /** The assignment of the innermost variable or `$this` member a member chain starts from. */
  receiver(object: Node, scope: Scope): number | undefined {
    const chain: Node[] = [];
    for (let node: Node | null = object; node !== null; ) {
      chain.push(node);
      node = MEMBER_ACCESS.has(node.type) ? node.childForFieldName("object") : null;
    }
    for (const part of chain.reverse()) {
      const binding =
        part.type === "variable_name"
          ? this.cx.lookup(part.text, scope, part.startIndex)
          : this.memberOf(part, scope);
      const assignment = this.cx.assignmentOf(binding);
      if (assignment !== undefined) return assignment;
    }
    return undefined;
  }
}

/** The `arguments` child of a call whose grammar gives it no field (`new Client(...)`). */
function argumentsOf(node: Node): Node | null {
  return node.namedChildren.find((child) => child?.type === "arguments") ?? null;
}

function nowdocText(node: Node): string {
  const body = node.childForFieldName("value");
  return (body?.namedChildren ?? []).map((part) => part?.text ?? "").join("");
}

function trimSlash(name: string): string {
  return name.replace(/^\\+/, "");
}

function flattenConcat(value: Value): Value[] {
  return value.kind === "concat" ? value.parts : [value];
}
