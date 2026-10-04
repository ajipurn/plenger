import type { CallFact, Span } from "../facts/model.ts";
import { callsStartingAt, definitionOf, deref } from "../facts/query.ts";
import type { Project, ProjectFile } from "./project.ts";

/** Stands for a file's module-level code where a definition id is expected. */
export const MODULE_SCOPE = "<module>";

/** A span with the file it is in; what inventory items cite. */
type Location = Span & { path: string };

/** Where a project function is. */
export interface FunctionRef {
  path: string;
  definition: string;
}

/**
 * Lookups over a linked project's facts that the inventory, capability and rule
 * passes share: the calls at a location, the scopes a definition spans, and the
 * project function a call runs. Per-file indexes are cached on the facts themselves.
 */
export class ProjectIndex {
  readonly #project: Project;
  readonly #scopes = new Map<string, Map<string, Set<string>>>();

  constructor(project: Project) {
    this.#project = project;
  }

  /** Calls that start at a location (the calls of a chain share their start). */
  callsAt(location: Location): { file: ProjectFile; calls: CallFact[] } | undefined {
    const file = this.#project.files.get(location.path);
    if (file === undefined) return undefined;
    const calls: CallFact[] = [];
    for (const index of callsStartingAt(file.facts, location)) {
      const call = file.facts.calls[index];
      if (call !== undefined) calls.push(call);
    }
    return { file, calls };
  }

  /** The call an inventory item was found at, preferring the one with the item's target. */
  callAt(location: Location, target?: string): { file: ProjectFile; call: CallFact } | undefined {
    const found = this.callsAt(location);
    if (found === undefined) return undefined;
    const calls = found.calls.filter(
      (call) =>
        call.span.endLine === location.endLine && call.span.endColumn === location.endColumn,
    );
    const call = calls.find((candidate) => candidate.ref?.name === target) ?? calls[0];
    return call === undefined ? undefined : { file: found.file, call };
  }

  /** A definition and every function nested in it (callbacks, inline arrow functions). */
  scopesOf(file: ProjectFile, definition: string): Set<string> {
    if (definition === MODULE_SCOPE) return new Set([MODULE_SCOPE]);
    let byFile = this.#scopes.get(file.path);
    if (byFile === undefined) {
      byFile = new Map();
      const children = new Map<string, string[]>();
      for (const fact of file.facts.definitions) {
        if (fact.parent === null) continue;
        const list = children.get(fact.parent) ?? [];
        list.push(fact.id);
        children.set(fact.parent, list);
      }
      for (const fact of file.facts.definitions) {
        const scopes = new Set<string>();
        const pending = [fact.id];
        while (pending.length > 0) {
          const id = pending.pop() as string;
          if (scopes.has(id)) continue;
          scopes.add(id);
          // Methods of a nested class run on their own; plain nested functions are part of the body.
          for (const child of children.get(id) ?? []) pending.push(child);
        }
        byFile.set(fact.id, scopes);
      }
      this.#scopes.set(file.path, byFile);
    }
    return byFile.get(definition) ?? new Set([definition]);
  }

  /** The project function a call runs: a function, a method, or a class constructor. */
  calledFunction(file: ProjectFile, call: CallFact): FunctionRef | null {
    const ref = call.ref;
    if (ref?.kind !== "local") return null;
    const path = ref.file ?? file.path;
    const facts = this.#project.files.get(path)?.facts;
    if (facts === undefined) return null;
    const has = (id: string) => definitionOf(facts, id) !== undefined;
    const base = definitionOf(facts, ref.definition);
    if (base === undefined) return null;
    const member = /^(?:\(\))?\.([\w$#]+)$/.exec(ref.path)?.[1];
    if (member !== undefined) {
      if (base.kind !== "class" && ref.path.startsWith("()")) {
        const returned = (base.returns ?? []).flatMap((value) => {
          const object = deref(value, facts);
          if (object.kind !== "object") return [];
          return object.entries
            .filter((entry) => entry.key === member)
            .map((entry) => deref(entry.value, facts));
        });
        const targets = new Set(
          returned.filter((value) => value.kind === "function").map((value) => value.definition),
        );
        const id =
          targets.size === 1 && returned.every((value) => value.kind === "function")
            ? [...targets][0]
            : undefined;
        return id !== undefined && has(id) ? { path, definition: id } : null;
      }
      const id = `${ref.definition}.${member}`;
      return has(id) ? { path, definition: id } : null;
    }
    if (ref.path !== "" && ref.path !== "()") return null;
    if (base.kind !== "class") return ref.path === "" ? { path, definition: base.id } : null;
    for (const initializer of ["__init__", "constructor"]) {
      if (has(`${base.id}.${initializer}`))
        return { path, definition: `${base.id}.${initializer}` };
    }
    return null;
  }
}
