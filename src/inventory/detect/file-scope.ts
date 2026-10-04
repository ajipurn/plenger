/** Helpers over one file's facts and path that every detector module shares. */

import type { DefinitionFact, FileFacts, Span, Value } from "../../facts/model.ts";
import { deref, environmentValue, literalString } from "../../facts/query.ts";
import type { FunctionRef } from "../../project/index.ts";
import type { Language } from "../../source/languages.ts";
import type { Location } from "../model.ts";

/** How deep lists and objects are searched for the tools and instances they hold. */
export const NESTING_DEPTH = 3;

export class FileScope {
  readonly path: string;
  readonly language: Language;
  readonly facts: FileFacts;
  readonly #ids = new Set<string>();
  readonly #assignmentOfCall = new Map<number, number>();

  constructor(path: string, language: Language, facts: FileFacts) {
    this.path = path;
    this.language = language;
    this.facts = facts;
    facts.assignments.forEach((assignment, index) => {
      if (assignment.value.kind === "call" && assignment.member === undefined) {
        this.#assignmentOfCall.set(assignment.value.call, index);
      }
    });
  }

  location(span: Span): Location {
    return { path: this.path, ...span };
  }

  /** A unique id for a component: its kind and position, numbered when several share one. */
  id(kind: string, span: Span): string {
    const base = `${kind}:${this.path}:${span.line}:${span.column}`;
    let id = base;
    for (let n = 2; this.#ids.has(id); n++) id = `${base}#${n}`;
    this.#ids.add(id);
    return id;
  }

  /** The assignment whose value is the given call (`x = f()`), if any. */
  assignmentOf(callIndex: number): number | undefined {
    return this.#assignmentOfCall.get(callIndex);
  }

  literal(values: Value[]): string | null {
    for (const value of values) {
      const text = literalString(value, this.facts);
      if (text !== null) return text;
    }
    return null;
  }

  firstOf(values: Value[], read: (value: Value) => string | null): string | null {
    for (const value of values) {
      const text = read(value);
      if (text !== null) return text;
    }
    return null;
  }

  /**
   * A model name given directly, from the environment, through a variable, or
   * through a model object or provider call plenger detected (`modelOfCall`).
   */
  modelName(values: Value[], modelOfCall: (callIndex: number) => string | null): string | null {
    for (const value of values) {
      const text = literalString(value, this.facts) ?? environmentValue(value, this.facts);
      if (text !== null) return text;
      const target = deref(value, this.facts);
      if (target.kind === "call") {
        const model = modelOfCall(target.call);
        if (model !== null) return model;
      }
    }
    return null;
  }

  strings(values: Value[]): string[] {
    const result: string[] = [];
    for (const value of values) {
      const target = deref(value, this.facts);
      const items = target.kind === "list" ? target.items : [target];
      for (const item of items) {
        const text = literalString(item, this.facts);
        if (text !== null) result.push(text);
      }
    }
    return result;
  }

  /** The function a value names: an inline function, or a project function in this or another file. */
  functionRef(value: Value | undefined): FunctionRef | null {
    if (value === undefined) return null;
    const target = deref(value, this.facts);
    if (target.kind === "function") return { definition: target.definition, path: this.path };
    if (target.kind === "name" && target.ref?.kind === "local" && target.ref.path === "") {
      return { definition: target.ref.definition, path: target.ref.file ?? this.path };
    }
    return null;
  }

  /** `handler`, plus `handlerPath` when the function is in another file. */
  handlerFields(ref: FunctionRef | null): { handler: string | null; handlerPath?: string } {
    if (ref === null) return { handler: null };
    return ref.path === this.path
      ? { handler: ref.definition }
      : { handler: ref.definition, handlerPath: ref.path };
  }

  /** The variable a call's result is assigned to, by its last name segment. */
  assignedName(callIndex: number): string | null {
    const assignment = this.#assignmentOfCall.get(callIndex);
    if (assignment === undefined) return null;
    const target = this.facts.assignments[assignment]?.target ?? "";
    return /([\w$#]+)$/.exec(target)?.[1] ?? null;
  }

  /** The literal value of a class attribute (`name = "search"` in a tool class). */
  classAttribute(definition: DefinitionFact, name: string): string | null {
    const assignment = this.facts.assignments.find(
      (candidate) => candidate.scope === definition.id && candidate.target === name,
    );
    return assignment === undefined ? null : this.literal([assignment.value]);
  }
}
