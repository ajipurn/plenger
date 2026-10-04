import type { DefinitionFact } from "../../facts/model.ts";
import { definitionOf } from "../../facts/query.ts";
import type { FunctionRef } from "../../project/index.ts";
import type { Project } from "../../project/project.ts";
import type { Inventory, Tool } from "../model.ts";
import { FileDetector } from "./file-detector.ts";
import type { Instance } from "./instances.ts";

/**
 * Detects agent components across a linked project. Each phase runs over every file
 * before the next starts, because components refer to each other across files: tools
 * before the agents that list them, agents before the calls that run them.
 */
export class ProjectDetector {
  readonly project: Project;
  readonly #detectors = new Map<string, FileDetector>();
  readonly #returning = new Set<string>();

  constructor(project: Project) {
    this.project = project;
    for (const file of project.files.values()) {
      this.#detectors.set(file.path, new FileDetector(file.path, file.language, file.facts, this));
    }
  }

  run(): Inventory[] {
    const detectors = [...this.#detectors.values()];
    for (const detector of detectors) detector.frameworks();
    for (const detector of detectors) detector.constructTools();
    for (const detector of detectors) detector.constructAgents();
    for (const detector of detectors) detector.linkAgents();
    for (const detector of detectors) detector.relate();
    for (const detector of detectors) detector.finish();
    return detectors.map((detector) => detector.inventory);
  }

  detector(path: string): FileDetector | undefined {
    return this.#detectors.get(path);
  }

  /** The component a module-level variable of a project file holds. */
  instanceAt(origin: { path: string; assignment: number } | undefined): Instance | undefined {
    return origin === undefined
      ? undefined
      : this.#detectors.get(origin.path)?.instances.instanceAt(origin.assignment);
  }

  /** The component a project function returns (`def build_agent(): return create_react_agent(...)`). */
  returnedInstance(path: string, definition: string): Instance | undefined {
    const key = `${path}|${definition}`;
    const detector = this.#detectors.get(path);
    if (detector === undefined || this.#returning.has(key)) return undefined;
    this.#returning.add(key);
    try {
      return detector.instances.returnedInstance(definition);
    } finally {
      this.#returning.delete(key);
    }
  }

  /** The tool a project function or class is, in its own file. */
  toolForDefinition(target: FunctionRef, framework: string): Tool | undefined {
    return this.#detectors.get(target.path)?.tools.toolForDefinition(target.definition, framework);
  }

  /** The tool a module-level variable of a project file holds (`lookup = tool(...)`). */
  toolAt(origin: { path: string; assignment: number }, framework: string): Tool | undefined {
    return this.#detectors.get(origin.path)?.tools.toolAt(origin.assignment, framework);
  }

  definition(target: FunctionRef): DefinitionFact | undefined {
    const facts = this.project.files.get(target.path)?.facts;
    return facts === undefined ? undefined : definitionOf(facts, target.definition);
  }
}
