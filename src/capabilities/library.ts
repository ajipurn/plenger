/**
 * A package's public API, for library scans: the functions and methods its callers can
 * call, whose parameters such a scan counts as untrusted input.
 */

import type { DefinitionFact } from "../facts/model.ts";
import { definitionOf } from "../facts/query.ts";
import type { Capability, Location, TraceGaps } from "../inventory/model.ts";
import type { Project, ProjectFile } from "../project/project.ts";
import { byFamily, type Language } from "../source/languages.ts";

export interface PublicFunction {
  /** Definition id, e.g. `FileStore.get`. */
  definition: string;
  path: string;
  /** The parameters callers fill in: all but `self`, `cls` and `this`. */
  params: string[];
  /** The whole definition. */
  location: Location;
  /** What the function reaches, through project functions. */
  reaches: Capability[];
  /** Calls its trace could not follow, so `reaches` may be incomplete. */
  trace?: TraceGaps;
}

/** Code that is not part of a package's API: tests, examples, documentation, benchmarks and scripts. */
const NOT_API =
  /(?:^|\/)(?:tests?|__tests__|spec|fixtures?|examples?|docs?|benchmarks?|scripts?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/;
/** A Python module the package keeps to itself: a file or directory named with a leading `_`, `__init__.py` aside. */
const PRIVATE_MODULE = /(?:^|\/)_(?!_init__\.py$)[^/]*(?:\/|\.py$)/;
const RECEIVER = /^(?:self|cls|this)$/;

/**
 * The functions and methods a caller of the package can reach by name: module-level
 * functions and methods of module-level classes, in public modules, outside tests and
 * examples. Python names with a leading `_` are private, dunder methods are not; a JS
 * or TS function or class must be exported, and `_` or `#` marks a private member.
 */
export function publicFunctions(
  project: Project,
): { file: ProjectFile; definition: DefinitionFact }[] {
  const found: { file: ProjectFile; definition: DefinitionFact }[] = [];
  for (const file of project.files.values()) {
    if (NOT_API.test(file.path)) continue;
    // Python marks private modules by name; JavaScript and TypeScript callers reach only
    // exports, and PHP callers only top-level functions and classes.
    const privateModules = byFamily(file.language, { python: true, javascript: false, php: false });
    const exportsOnly = byFamily(file.language, { python: false, javascript: true, php: true });
    if (privateModules && PRIVATE_MODULE.test(file.path)) continue;
    for (const definition of file.facts.definitions) {
      if (definition.kind === "class" || !publicName(definition.name, file.language)) continue;
      let outermost = definition;
      let reachable = true;
      for (
        let parent = definitionOf(file.facts, definition.parent);
        parent !== undefined;
        parent = definitionOf(file.facts, parent.parent)
      ) {
        // A function defined inside a function is not reachable by name.
        if (parent.kind !== "class" || !publicName(parent.name, file.language)) reachable = false;
        outermost = parent;
      }
      if (!reachable || (exportsOnly && !outermost.exported)) continue;
      if (callerParams(definition).length === 0) continue;
      found.push({ file, definition });
    }
  }
  return found;
}

/** How findings name a public function: its file and definition id, `store.py#FileStore.get`. */
export function functionId(fn: Pick<PublicFunction, "path" | "definition">): string {
  return `${fn.path}#${fn.definition}`;
}

/** The parameters a caller fills in. */
export function callerParams(definition: DefinitionFact): string[] {
  return definition.params.filter((param) => !RECEIVER.test(param));
}

function publicName(name: string | null, language: Language): boolean {
  if (name === null) return false;
  return byFamily(language, {
    python: !name.startsWith("_") || /^__\w+__$/.test(name),
    javascript: !/^[_#]/.test(name),
    // PHP marks visibility with keywords, not names.
    php: true,
  });
}
