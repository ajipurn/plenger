/** Which model, agent, MCP server or MCP client a variable or call result holds. */

import type { CallFact, Span, Value } from "../../facts/model.ts";
import { definitionOf, deref } from "../../facts/query.ts";
import { sameStart } from "../../shared/location.ts";
import type { AgentRule, ModelRule } from "../detectors.ts";
import type { Agent, McpClient, McpServer, Model } from "../model.ts";
import { type FileScope, NESTING_DEPTH } from "./file-scope.ts";
import type { ProjectDetector } from "./index.ts";

export type Instance =
  | { kind: "model"; component: Model; rule: ModelRule }
  | { kind: "agent"; component: Agent; rule: AgentRule }
  | { kind: "mcp_server"; component: McpServer }
  | { kind: "mcp_client"; component: McpClient };

/** Methods whose result is the same model, agent or graph, so assigning it keeps the instance. */
const SAME_INSTANCE =
  /\.(?:compile|build|bind_tools|bindTools|with_structured_output|withStructuredOutput|with_config|withConfig|bind)\(\)$/;

export class InstanceRegistry {
  readonly #scope: FileScope;
  readonly #project: ProjectDetector;
  readonly #byCall = new Map<number, Instance>();
  readonly #byAssignment = new Map<number, Instance>();
  readonly #resolvingAssignments = new Set<number>();

  constructor(scope: FileScope, project: ProjectDetector) {
    this.#scope = scope;
    this.#project = project;
  }

  /** Records the component a constructor call creates. */
  register(callIndex: number, instance: Instance): void {
    this.#byCall.set(callIndex, instance);
  }

  constructedBy(callIndex: number): Instance | undefined {
    return this.#byCall.get(callIndex);
  }

  /** Every constructed instance, in the order found. */
  all(): Instance[] {
    return [...this.#byCall.values()];
  }

  /**
   * The component a variable holds: a constructor call, a call that keeps the instance
   * (`builder.compile()`), a project function that returns one, or a variable of
   * another file. Resolved lazily, because the answer can depend on other files.
   */
  instanceAt(assignment: number): Instance | undefined {
    const cached = this.#byAssignment.get(assignment);
    if (cached !== undefined || this.#resolvingAssignments.has(assignment)) return cached;
    this.#resolvingAssignments.add(assignment);
    try {
      const fact = this.#scope.facts.assignments[assignment];
      let instance: Instance | undefined;
      if (fact !== undefined && fact.member === undefined) {
        if (fact.value.kind === "call") instance = this.instanceOfResult(fact.value.call);
        else if (fact.value.kind === "name") {
          instance =
            this.#project.instanceAt(fact.value.ref?.origin) ??
            (fact.value.assignment === undefined
              ? undefined
              : this.instanceAt(fact.value.assignment));
        }
      }
      if (instance !== undefined) this.#byAssignment.set(assignment, instance);
      return instance;
    } finally {
      this.#resolvingAssignments.delete(assignment);
    }
  }

  /** The component a call's result is. */
  instanceOfResult(callIndex: number): Instance | undefined {
    const constructed = this.#byCall.get(callIndex);
    if (constructed !== undefined) return constructed;
    const call = this.#scope.facts.calls[callIndex];
    if (call === undefined) return undefined;
    if (SAME_INSTANCE.test(`${call.ref?.name ?? ""}()`)) {
      const instance = this.instanceOfCall(call);
      if (instance !== undefined) return instance;
    }
    if (call.ref?.kind === "local" && call.ref.path === "") {
      return this.#project.returnedInstance(call.ref.file ?? this.#scope.path, call.ref.definition);
    }
    return undefined;
  }

  /** The component a function of this file returns. */
  returnedInstance(definition: string): Instance | undefined {
    const fact = definitionOf(this.#scope.facts, definition);
    for (const value of fact?.returns ?? []) {
      const instance = this.instanceIn([value]);
      if (instance !== undefined) return instance;
    }
    return undefined;
  }

  /** Instances of a kind held by values, looking inside lists and object values. */
  instancesIn<K extends Instance["kind"]>(
    values: Value[],
    kind: K,
  ): Extract<Instance, { kind: K }>[] {
    const found: Extract<Instance, { kind: K }>[] = [];
    const visit = (value: Value, depth: number) => {
      const target = deref(value, this.#scope.facts);
      if (target.kind === "list" && depth < NESTING_DEPTH)
        for (const item of target.items) visit(item, depth + 1);
      else if (target.kind === "object" && depth < NESTING_DEPTH) {
        for (const entry of target.entries) visit(entry.value, depth + 1);
      } else if (target.kind === "call") {
        const instance = this.#byCall.get(target.call);
        if (instance?.kind === kind) found.push(instance as Extract<Instance, { kind: K }>);
        else if (instance === undefined && depth < NESTING_DEPTH) {
          // Wrappers such as `handoff(agent)` hold the instance in an argument.
          for (const arg of this.#scope.facts.calls[target.call]?.arguments ?? [])
            visit(arg.value, depth + 1);
        }
      }
    };
    for (const value of values) visit(value, 0);
    return [...new Set(found)];
  }

  instanceOf(receiver: number | undefined): Instance | undefined {
    return receiver === undefined ? undefined : this.instanceAt(receiver);
  }

  /** The component an argument holds, directly, through a variable or from another file. */
  instanceIn(values: Value[]): Instance | undefined {
    for (const value of values) {
      if (value.kind === "name") {
        const instance =
          (value.assignment === undefined ? undefined : this.instanceAt(value.assignment)) ??
          this.#project.instanceAt(value.ref?.origin);
        if (instance !== undefined) return instance;
      }
      const target = deref(value, this.#scope.facts);
      if (target.kind === "call") {
        const instance = this.instanceOfResult(target.call);
        if (instance !== undefined) return instance;
      }
    }
    return undefined;
  }

  /**
   * The instance a call is made on: through its receiver variable, or through a
   * constructor earlier in the same chain (`OpenAI().chat.completions.create()`), which
   * starts at the same position.
   */
  instanceOfCall(call: CallFact): Instance | undefined {
    return this.instanceVia(call.receiver, call.ref, call.span);
  }

  /** The instance reached through a receiver variable, a variable of another file, or a chain. */
  instanceVia(
    receiver: number | undefined,
    ref: CallFact["ref"],
    span: Span,
  ): Instance | undefined {
    const byReceiver = this.instanceOf(receiver) ?? this.#project.instanceAt(ref?.origin);
    if (byReceiver !== undefined) return byReceiver;
    for (const [index, instance] of this.#byCall) {
      const candidate = this.#scope.facts.calls[index];
      if (candidate !== undefined && candidate.span !== span && sameStart(candidate.span, span)) {
        return instance;
      }
    }
    return undefined;
  }

  /** The only instance of a kind in the file, for calls whose receiver plenger could not follow. */
  soleInstance<K extends Instance["kind"]>(kind: K): Extract<Instance, { kind: K }> | undefined {
    const instances = [...new Set(this.#byCall.values())].filter(
      (instance) => instance.kind === kind,
    );
    return instances.length === 1 ? (instances[0] as Extract<Instance, { kind: K }>) : undefined;
  }

  /** The model name of a model object a call constructs, for `modelName`. */
  modelOfCall(callIndex: number): string | null {
    const instance = this.#byCall.get(callIndex);
    return instance?.kind === "model" ? instance.component.model : null;
  }
}
