/** The tools of one file, and resolving the entries of a tools argument to them. */

import type { DefinitionFact, Span, Value } from "../../facts/model.ts";
import { callsStartingAt, definitionOf, deref, select } from "../../facts/query.ts";
import type { Inventory, Tool } from "../model.ts";
import { type FileScope, NESTING_DEPTH } from "./file-scope.ts";
import type { ProjectDetector } from "./index.ts";
import type { InstanceRegistry } from "./instances.ts";

/** The name of an agent exposed as a tool when neither the call nor the agent names it. */
const AGENT_TOOL_NAME = "<agent>";

export class ToolRegistry {
  readonly #scope: FileScope;
  readonly #inventory: Inventory;
  readonly #project: ProjectDetector;
  readonly #instances: InstanceRegistry;
  readonly #byHandler = new Map<string, Tool>();
  readonly #byCall = new Map<number, Tool>();
  readonly #byClass = new Map<string, Tool>();
  /** Tools whose name came from the variable or function, which a tools-object key may refine. */
  readonly #defaultNamed = new Set<Tool>();

  constructor(
    scope: FileScope,
    inventory: Inventory,
    project: ProjectDetector,
    instances: InstanceRegistry,
  ) {
    this.#scope = scope;
    this.#inventory = inventory;
    this.#project = project;
    this.#instances = instances;
  }

  add(fields: Omit<Tool, "capabilities">): Tool {
    const tool: Tool = { ...fields, capabilities: [] };
    this.#inventory.tools.push(tool);
    if (tool.handler !== null && !this.#byHandler.has(tool.handler))
      this.#byHandler.set(tool.handler, tool);
    return tool;
  }

  byHandler(definition: string): Tool | undefined {
    return this.#byHandler.get(definition);
  }

  registerCall(callIndex: number, tool: Tool): void {
    this.#byCall.set(callIndex, tool);
  }

  registerClass(definition: string, tool: Tool): void {
    this.#byClass.set(definition, tool);
  }

  /** Marks a tool whose name is a fallback, so a `{ name: tool }` key can rename it. */
  defaultNamed(tool: Tool): void {
    this.#defaultNamed.add(tool);
  }

  /** Tools named in a tools argument: a list, a `{ name: tool }` object, or tool schemas. */
  toolsFrom(
    values: Value[],
    span: Span,
    framework: string,
  ): { ids: string[]; tools: Tool[]; unresolved: number } {
    const tools: Tool[] = [];
    let unresolved = 0;
    const visit = (value: Value, key: string | null, depth: number) => {
      const target = deref(value, this.#scope.facts);
      if (target.kind === "list" && depth < NESTING_DEPTH) {
        for (const item of target.items) visit(item, null, depth + 1);
        return;
      }
      if (target.kind === "object" && !isSchema(target) && depth < NESTING_DEPTH) {
        for (const entry of target.entries) visit(entry.value, entry.key, depth + 1);
        return;
      }
      const tool = this.toolOf(target, key, span, framework);
      if (tool === undefined) unresolved++;
      else if (!tools.includes(tool)) tools.push(tool);
    };
    for (const value of values) visit(value, null, 0);
    return { ids: tools.map((tool) => tool.id), tools, unresolved };
  }

  toolOf(value: Value, key: string | null, span: Span, framework: string): Tool | undefined {
    let tool: Tool | undefined;
    if (value.kind === "name" && value.ref?.kind === "local" && value.ref.path === "") {
      const path = value.ref.file ?? this.#scope.path;
      tool =
        path === this.#scope.path
          ? this.toolForDefinition(value.ref.definition, framework)
          : this.#project.toolForDefinition({ definition: value.ref.definition, path }, framework);
    } else if (value.kind === "name" && value.ref?.origin !== undefined) {
      tool = this.#project.toolAt(value.ref.origin, framework);
    } else if (value.kind === "function") {
      tool = this.#byHandler.get(value.definition);
    } else if (value.kind === "call") {
      tool = this.#byCall.get(value.call) ?? this.agentTool(value.call, framework);
      const ref = this.#scope.facts.calls[value.call]?.ref;
      if (tool === undefined && ref?.kind === "local" && ref.path === "") {
        // An instance of a tool class: `FetchTool()`
        const path = ref.file ?? this.#scope.path;
        tool =
          path === this.#scope.path
            ? this.#byClass.get(ref.definition)
            : this.#project.detector(path)?.tools.toolForClass(ref.definition);
      }
    } else if (value.kind === "object" && isSchema(value)) {
      tool = this.schemaTool(value, span);
    }
    if (tool !== undefined && key !== null && this.#defaultNamed.has(tool)) {
      tool.name = key;
      this.#defaultNamed.delete(tool);
    }
    return tool;
  }

  /** `agent.as_tool(...)` / `agent.asTool(...)`: another agent exposed as a tool. */
  agentTool(callIndex: number, framework: string): Tool | undefined {
    const facts = this.#scope.facts;
    const call = facts.calls[callIndex];
    if (call === undefined || !/\.(?:as_tool|asTool)$/.test(call.ref?.name ?? "")) return undefined;
    const instance = this.#instances.instanceOfCall(call);
    if (instance?.kind !== "agent") return undefined;
    const tool = this.add({
      id: this.#scope.id("tool", call.span),
      framework,
      location: this.#scope.location(call.span),
      name:
        this.#scope.literal(select(call.arguments, facts, "tool_name|toolName")) ??
        instance.component.name ??
        AGENT_TOOL_NAME,
      description: this.#scope.literal(
        select(call.arguments, facts, "tool_description|toolDescription"),
      ),
      handler: null,
      params: [],
      via: "agent",
      server: null,
      agent: instance.component.id,
    });
    this.#byCall.set(callIndex, tool);
    return tool;
  }

  /** The tool a function or class of this file is, making a plain function one if needed. */
  toolForDefinition(definition: string, framework: string): Tool | undefined {
    return (
      this.#byHandler.get(definition) ??
      this.#byClass.get(definition) ??
      this.functionTool(definition, framework)
    );
  }

  toolForClass(definition: string): Tool | undefined {
    return this.#byClass.get(definition);
  }

  /** The tool a module-level variable of this file holds. */
  toolAt(assignment: number, framework: string): Tool | undefined {
    const value = this.#scope.facts.assignments[assignment]?.value;
    if (value?.kind !== "call") return undefined;
    return this.#byCall.get(value.call) ?? this.agentTool(value.call, framework);
  }

  /** A plain function passed in a tool list: the framework builds the tool from its signature and docstring. */
  functionTool(definitionId: string, framework: string): Tool | undefined {
    const definition = definitionOf(this.#scope.facts, definitionId);
    if (definition === undefined || definition.kind === "class" || definition.name === null)
      return undefined;
    return this.add({
      id: this.#scope.id("tool", definition.span),
      framework,
      location: this.#scope.location(definition.span),
      name: definition.name,
      description: definition.doc,
      handler: definition.id,
      params: withoutReceiver(definition),
      via: "function",
      server: null,
    });
  }

  /** A JSON tool schema (`{"name": ..., "input_schema": ...}` or `{"type": "function", ...}`). */
  schemaTool(value: Extract<Value, { kind: "object" }>, span: Span): Tool | undefined {
    const facts = this.#scope.facts;
    const entry = (path: string) =>
      this.#scope.literal(select([{ keyword: null, value }], facts, path));
    const name = entry("#0.name|#0.function.name");
    if (name === null) return undefined;
    const existing = this.#inventory.tools.find(
      (tool) => tool.via === "schema" && tool.name === name && tool.location.line === span.line,
    );
    if (existing !== undefined) return existing;
    const handler = facts.definitions.find(
      (definition) => definition.name === name && definition.kind !== "class",
    );
    return this.add({
      id: this.#scope.id("tool", span),
      framework: this.frameworkAt(span),
      location: this.#scope.location(span),
      name,
      description: entry("#0.description|#0.function.description"),
      handler: handler?.id ?? null,
      params: handler === undefined ? [] : withoutReceiver(handler),
      via: "schema",
      server: null,
    });
  }

  /** The SDK a tool schema is passed to, from the call at its position. */
  frameworkAt(span: Span): string {
    const facts = this.#scope.facts;
    const first = callsStartingAt(facts, span)[0];
    const name = (first === undefined ? undefined : facts.calls[first])?.ref?.name ?? "";
    return name.startsWith("anthropic") || name.startsWith("@anthropic-ai")
      ? "anthropic"
      : "openai";
  }
}

/** A function's parameters without a method's `self` or `cls`. */
export function withoutReceiver(definition: DefinitionFact): string[] {
  const [first, ...rest] = definition.params;
  return definition.kind === "method" && (first === "self" || first === "cls")
    ? rest
    : definition.params;
}

/** Whether an object literal is a JSON tool schema rather than a `{ name: tool }` map. */
export function isSchema(value: Extract<Value, { kind: "object" }>): boolean {
  const keys = new Set(value.entries.map((entry) => entry.key));
  return (
    (keys.has("name") &&
      (keys.has("input_schema") || keys.has("parameters") || keys.has("description"))) ||
    (keys.has("type") && keys.has("function"))
  );
}
