/**
 * The project's own top-level Python modules, from its file layout: packages whose
 * parent is not a package, and the modules and directories directly under the
 * project root or `src/`. `import agents` names a local module when the project has
 * an `agents/` package, not the OpenAI Agents SDK.
 */
export function localPythonModules(paths: readonly string[]): Set<string> {
  const python = paths.filter((path) => path.endsWith(".py"));
  const packages = new Set(
    python
      .filter((path) => path.endsWith("/__init__.py"))
      .map((path) => path.slice(0, -"/__init__.py".length)),
  );
  const local = new Set<string>();
  for (const dir of packages) {
    const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    if (!packages.has(parent)) local.add(dir.slice(dir.lastIndexOf("/") + 1));
  }
  for (const path of python) {
    const segments = path.split("/");
    const start = segments[0] === "src" && segments.length > 1 ? 1 : 0;
    const first = segments[start];
    if (first === undefined) continue;
    local.add(segments.length === start + 1 ? first.replace(/\.py$/, "") : first);
  }
  local.delete("__init__");
  return local;
}
