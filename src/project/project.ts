import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { FileFacts, Ref, Value } from "../facts/model.ts";
import { localPythonModules } from "../inventory/modules.ts";
import type { Language } from "../languages.ts";

export interface ProjectFile {
  /** Relative to the project root, with forward slashes. */
  path: string;
  language: Language;
  facts: FileFacts;
}

/** What a module-level name in a project file is. */
type Export =
  | { kind: "definition"; definition: string }
  | { kind: "variable"; assignment: number }
  | { kind: "import"; ref: Ref }
  | { kind: "module"; path: string };

const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const LINK_DEPTH = 8;

/**
 * The scanned files of one project, with module resolution between them. `link()`
 * rewrites refs that import from another project file so that they point at what
 * that file defines: a function or class (a local ref with `file`), or the value of a
 * module-level variable (its resolved ref, with `origin` and, for constants, `constant`).
 */
export class Project {
  readonly root: string;
  readonly files = new Map<string, ProjectFile>();
  readonly localModules: Set<string>;
  readonly #pythonModules = new Map<string, string[]>();
  readonly #aliases: { prefix: string; targets: string[] }[];
  readonly #exports = new Map<string, Map<string, Export>>();
  readonly #resolving = new Set<string>();

  constructor(root: string, files: ProjectFile[]) {
    this.root = root;
    for (const file of files) this.files.set(file.path, file);
    this.localModules = localPythonModules(files.map((file) => file.path));
    // A scanned directory that is itself a package (`examples/__init__.py`) is imported by its name.
    const rootPackage = posix.basename(root.replace(/\\/g, "/"));
    const packaged = this.files.has("__init__.py") && /^[A-Za-z_]\w*$/.test(rootPackage);
    if (packaged) this.localModules.add(rootPackage);
    for (const file of files) {
      if (file.language !== "python") continue;
      const segments = file.path
        .replace(/\.py$/, "")
        .replace(/\/__init__$/, "")
        .split("/");
      if (packaged) segments.unshift(rootPackage);
      if (segments.at(-1) === "__init__") segments.pop();
      for (let start = 0; start < segments.length; start++) {
        const name = segments.slice(start).join(".");
        const paths = this.#pythonModules.get(name) ?? [];
        paths.push(file.path);
        this.#pythonModules.set(name, paths);
      }
    }
    this.#aliases = readAliases(root);
  }

  /** The project file an import refers to, if it is one. */
  resolveModule(from: string, module: string): string | undefined {
    const file = this.files.get(from);
    if (file === undefined) return undefined;
    return file.language === "python"
      ? this.#resolvePython(from, module)
      : this.#resolveJavaScript(from, module);
  }

  #resolvePython(from: string, module: string): string | undefined {
    const dots = /^\.*/.exec(module)?.[0].length ?? 0;
    if (dots > 0) {
      const base = posix
        .dirname(from)
        .split("/")
        .filter((segment) => segment !== "." && segment !== "");
      const up = base.slice(0, Math.max(0, base.length - (dots - 1)));
      const rest = module
        .slice(dots)
        .split(".")
        .filter((segment) => segment !== "");
      const dir = [...up, ...rest].join("/");
      return this.#pythonFile(dir);
    }
    if (!this.localModules.has(module.split(".")[0] ?? "")) return undefined;
    const candidates = this.#pythonModules.get(module) ?? [];
    return closest(from, candidates);
  }

  #pythonFile(dir: string): string | undefined {
    for (const candidate of [`${dir}.py`, `${dir}/__init__.py`]) {
      const path = candidate.replace(/^\//, "");
      if (this.files.has(path)) return path;
    }
    return undefined;
  }

  #resolveJavaScript(from: string, module: string): string | undefined {
    const bases: string[] = [];
    if (module.startsWith("./") || module.startsWith("../")) {
      bases.push(posix.normalize(posix.join(posix.dirname(from), module)));
    } else {
      for (const alias of this.#aliases) {
        if (!module.startsWith(alias.prefix)) continue;
        for (const target of alias.targets)
          bases.push(posix.normalize(target + module.slice(alias.prefix.length)));
      }
    }
    for (const base of bases) {
      const found = this.#javaScriptFile(base.replace(/^\.\//, ""));
      if (found !== undefined) return found;
    }
    return undefined;
  }

  #javaScriptFile(base: string): string | undefined {
    const stem = base.replace(/\.(?:[cm]?[jt]sx?)$/, "");
    const candidates = [base, ...JS_EXTENSIONS.map((extension) => stem + extension)];
    candidates.push(...JS_EXTENSIONS.map((extension) => `${base}/index${extension}`));
    return candidates.find((candidate) => this.files.has(candidate));
  }

  /** Module-level names of a project file. */
  exportsOf(path: string): Map<string, Export> {
    let exports = this.#exports.get(path);
    if (exports !== undefined) return exports;
    exports = new Map();
    const file = this.files.get(path);
    if (file !== undefined) collectExports(file, exports);
    this.#exports.set(path, exports);
    return exports;
  }

  /** Rewrites every import ref in every file that points into another project file. */
  link(): void {
    for (const file of this.files.values()) {
      const relink = (ref: Ref | null) => (ref === null ? null : this.relink(ref, file.path, 0));
      for (const call of file.facts.calls) {
        call.ref = relink(call.ref);
        for (const arg of call.arguments) linkValue(arg.value, relink);
      }
      for (const definition of file.facts.definitions) {
        for (const decorator of definition.decorators) {
          decorator.ref = relink(decorator.ref);
          for (const arg of decorator.arguments ?? []) linkValue(arg.value, relink);
        }
        for (const value of [...definition.bases, ...(definition.returns ?? [])])
          linkValue(value, relink);
      }
      for (const assignment of file.facts.assignments) linkValue(assignment.value, relink);
    }
  }

  /** The ref an import ref stands for once its module is a project file; the same ref otherwise. */
  relink(ref: Ref, from: string, depth: number): Ref {
    if (ref.kind !== "import" || depth > LINK_DEPTH) return ref;
    let target = this.resolveModule(from, ref.module);
    let path = ref.path;
    if (target === undefined && this.files.get(from)?.language === "python") {
      // `from . import tools` in a package without `__init__.py`: `tools` is a submodule.
      const head = /^[^.(]+/.exec(path)?.[0];
      if (head !== undefined) {
        const submodule = ref.module.endsWith(".") ? ref.module + head : `${ref.module}.${head}`;
        target = this.resolveModule(from, submodule);
        path = path.slice(head.length).replace(/^\./, "");
        if (target !== undefined && path === "") return ref;
      }
    }
    if (target === undefined) return ref;
    const key = `${from}|${ref.module}|${ref.path}`;
    if (this.#resolving.has(key)) return ref;
    this.#resolving.add(key);
    try {
      return this.#resolveIn(target, path, depth) ?? ref;
    } finally {
      this.#resolving.delete(key);
    }
  }

  #resolveIn(path: string, memberPath: string, depth: number): Ref | null {
    const file = this.files.get(path);
    if (file === undefined) return null;
    const head = /^[^.(]*/.exec(memberPath)?.[0] ?? "";
    const rest = memberPath.slice(head.length);
    const name = head === "" ? "default" : head;
    let entry = this.exportsOf(path).get(name);
    if (entry === undefined && file.language === "python" && head !== "") {
      // `import pkg` then `pkg.sub.f()`: `sub` is a submodule of the package.
      const submodule = this.#pythonFile(`${path.replace(/(?:\/__init__)?\.py$/, "")}/${head}`);
      if (submodule !== undefined) entry = { kind: "module", path: submodule };
    }
    if (entry === undefined) return null;
    switch (entry.kind) {
      case "definition":
        return extend(
          {
            kind: "local",
            definition: entry.definition,
            path: "",
            name: entry.definition,
            file: path,
          },
          rest,
        );
      case "module":
        return rest === "" ? null : this.#resolveIn(entry.path, rest.replace(/^\./, ""), depth + 1);
      case "import":
        return extend(this.relink(entry.ref, path, depth + 1), rest);
      case "variable": {
        const assignment = file.facts.assignments[entry.assignment];
        if (assignment === undefined) return null;
        const base = this.#valueRef(path, assignment.value, depth);
        const origin = { path, assignment: entry.assignment };
        const constant = rest === "" && isConstant(assignment.value) ? assignment.value : undefined;
        const ref: Ref =
          base === null ? { kind: "global", path: name, name, origin } : { ...base, origin };
        if (constant !== undefined) ref.constant = constant;
        return extend(ref, rest);
      }
    }
  }

  /** The ref a module-level variable's value stands for: a name's ref, or a call result. */
  #valueRef(path: string, value: Value, depth: number): Ref | null {
    const file = this.files.get(path);
    if (file === undefined) return null;
    if (value.kind === "name" && value.ref !== null) {
      const ref = this.relink(value.ref, path, depth + 1);
      return ref.kind === "local" ? { ...ref, file: ref.file ?? path } : ref;
    }
    if (value.kind === "call") {
      const callee = file.facts.calls[value.call]?.ref ?? null;
      if (callee === null) return null;
      const ref = this.relink(callee, path, depth + 1);
      return extend(ref.kind === "local" ? { ...ref, file: ref.file ?? path } : ref, "()");
    }
    return null;
  }

  /** Reads a file's text, for checks that need more than facts. */
  read(path: string): string {
    return readFileSync(join(this.root, path), "utf8");
  }
}

function collectExports(file: ProjectFile, exports: Map<string, Export>): void {
  const { facts } = file;
  for (const fact of facts.imports) {
    if (fact.scope !== null || fact.local === null || fact.typeOnly) continue;
    const path = fact.kind === "member" || fact.kind === "default" ? (fact.imported ?? "") : "";
    exports.set(fact.local, { kind: "import", ref: importRef(file.language, fact.module, path) });
  }
  facts.assignments.forEach((assignment, index) => {
    if (assignment.scope !== null || assignment.member !== undefined) return;
    if (/^[\w$]+$/.test(assignment.target))
      exports.set(assignment.target, { kind: "variable", assignment: index });
    // CommonJS: `exports.x = ...` and `module.exports.x = ...`
    const commonjs = /^(?:module\.)?exports\.([\w$]+)$/.exec(assignment.target)?.[1];
    if (commonjs !== undefined) exports.set(commonjs, { kind: "variable", assignment: index });
  });
  for (const definition of facts.definitions) {
    if (definition.parent === null && definition.name !== null) {
      exports.set(definition.name, { kind: "definition", definition: definition.id });
    }
  }
  // CommonJS `module.exports = { a, b }` and `module.exports = fn`
  const moduleExports = facts.assignments.find(
    (assignment) => assignment.target === "module.exports",
  );
  if (moduleExports?.value.kind === "object") {
    for (const entry of moduleExports.value.entries) {
      const local = entry.value.kind === "name" ? exports.get(entry.value.text) : undefined;
      if (entry.key !== null && local !== undefined) exports.set(entry.key, local);
    }
  } else if (moduleExports?.value.kind === "name") {
    const local = exports.get(moduleExports.value.text);
    if (local !== undefined) exports.set("default", local);
  }
  if (facts.defaultExport !== undefined) {
    const local = exports.get(facts.defaultExport);
    if (local !== undefined) exports.set("default", local);
  }
}

function importRef(language: Language, module: string, path: string): Ref {
  if (path === "") return { kind: "import", module, path, name: module };
  const separator = language === "python" ? (module.endsWith(".") ? "" : ".") : "#";
  return { kind: "import", module, path, name: `${module}${separator}${path}` };
}

/** Appends a member path (`.tool()`, `().run`) to a ref. */
function extend(ref: Ref, rest: string): Ref {
  if (rest === "") return ref;
  const path = ref.path === "" ? rest.replace(/^\./, "") : ref.path + rest;
  const { constant: _constant, ...withoutConstant } = ref;
  return { ...withoutConstant, path, name: ref.name + rest };
}

function isConstant(value: Value): boolean {
  switch (value.kind) {
    case "string":
      return value.template === undefined;
    case "literal":
      return true;
    case "concat":
      return value.parts.every(isConstant);
    case "list":
      return value.items.every(isConstant);
    case "object":
      return value.entries.every((entry) => isConstant(entry.value));
    default:
      return false;
  }
}

function linkValue(value: Value, relink: (ref: Ref | null) => Ref | null): void {
  switch (value.kind) {
    case "name":
      value.ref = relink(value.ref);
      break;
    case "string":
      for (const part of value.template ?? []) linkValue(part, relink);
      break;
    case "concat":
      for (const part of value.parts) linkValue(part, relink);
      break;
    case "list":
      for (const item of value.items) linkValue(item, relink);
      break;
    case "object":
      for (const entry of value.entries) linkValue(entry.value, relink);
      break;
    default:
      break;
  }
}

/** Of several files a module name matches, the one nearest to the importing file. */
function closest(from: string, candidates: string[]): string | undefined {
  if (candidates.length <= 1) return candidates[0];
  const shared = (path: string) => {
    const a = from.split("/");
    const b = path.split("/");
    let count = 0;
    while (count < a.length && count < b.length && a[count] === b[count]) count++;
    return count;
  };
  return [...candidates].sort((x, y) => shared(y) - shared(x) || x.length - y.length)[0];
}

/** Path aliases from the root tsconfig.json (`compilerOptions.paths`), else `@/` and `~/`. */
function readAliases(root: string): { prefix: string; targets: string[] }[] {
  const defaults = [
    { prefix: "@/", targets: ["src/", ""] },
    { prefix: "~/", targets: ["src/", ""] },
  ];
  let config: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    const text = readFileSync(join(root, "tsconfig.json"), "utf8");
    config = JSON.parse(
      text.replace(/\/\*[\s\S]*?\*\/|(?<![:"])\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"),
    );
  } catch {
    return defaults;
  }
  const baseUrl = (config.compilerOptions?.baseUrl ?? ".").replace(/^\.\/?/, "");
  const aliases: { prefix: string; targets: string[] }[] = [];
  for (const [pattern, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
    if (!pattern.endsWith("*")) continue;
    aliases.push({
      prefix: pattern.slice(0, -1),
      targets: targets
        .filter((target) => target.endsWith("*"))
        .map((target) => {
          const dir = posix.join(baseUrl, target.slice(0, -1));
          return dir === "." ? "" : `${dir.replace(/\/$/, "")}/`;
        }),
    });
  }
  return aliases.length > 0 ? aliases : defaults;
}
