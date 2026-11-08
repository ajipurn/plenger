/**
 * The project's own top-level Python modules, from its file layout: packages whose
 * parent is not a package, and the modules and directories directly under the
 * project root or `src/`. `import agents` names a local module when the project has
 * an `agents/` package, not the OpenAI Agents SDK.
 */
export function localPythonModules(paths: readonly string[]): Set<string> {
  const { packages, modules, directories } = pythonLayout(paths);
  const local = new Set([...packages, ...modules, ...directories]);
  local.delete("__init__");
  return local;
}

/**
 * The top-level directories among the local modules that are not packages: no
 * `__init__.py` and no module of the same name. Python imports such a directory as a
 * namespace package only when no installed package has its name, so `openai/chat.py`
 * leaves `from openai import OpenAI` the SDK's.
 */
export function namespacePythonModules(paths: readonly string[]): Set<string> {
  const { packages, modules, directories } = pythonLayout(paths);
  return new Set([...directories].filter((name) => !packages.has(name) && !modules.has(name)));
}

function pythonLayout(paths: readonly string[]) {
  const python = paths.filter((path) => path.endsWith(".py"));
  const packageDirs = new Set(
    python
      .filter((path) => path.endsWith("/__init__.py"))
      .map((path) => path.slice(0, -"/__init__.py".length)),
  );
  /** Packages whose parent is not a package, wherever their source root is. */
  const packages = new Set<string>();
  for (const dir of packageDirs) {
    const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    if (!packageDirs.has(parent)) packages.add(dir.slice(dir.lastIndexOf("/") + 1));
  }
  /** Modules and directories directly under the project root or `src/`. */
  const modules = new Set<string>();
  const directories = new Set<string>();
  for (const path of python) {
    const segments = path.split("/");
    const start = segments[0] === "src" && segments.length > 1 ? 1 : 0;
    const first = segments[start];
    if (first === undefined) continue;
    if (segments.length === start + 1) modules.add(first.replace(/\.py$/, ""));
    else directories.add(first);
  }
  return { packages, modules, directories };
}
