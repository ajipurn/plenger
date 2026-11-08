import { describe, expect, it } from "vitest";
import { localPythonModules, namespacePythonModules } from "../src/project/modules.ts";

describe("localPythonModules", () => {
  it("finds top-level packages wherever their source root is", () => {
    const local = localPythonModules([
      "services/api/app/__init__.py",
      "services/api/app/routes.py",
      "services/api/app/providers/__init__.py",
      "services/api/app/providers/openai/__init__.py",
    ]);
    expect(local.has("app")).toBe(true);
    // A subpackage is not importable as `openai`.
    expect(local.has("openai")).toBe(false);
  });

  it("counts modules and namespace packages under the root and src/", () => {
    const local = localPythonModules([
      "agents/core.py",
      "src/tools/search.py",
      "main.py",
      "src/cli.py",
    ]);
    expect([...local].sort()).toEqual(["agents", "cli", "main", "tools"]);
  });
});

describe("namespacePythonModules", () => {
  it("names the top-level directories that are neither packages nor modules", () => {
    const namespaces = namespacePythonModules([
      "openai/chat.py",
      "src/mcp/server.py",
      "app/__init__.py",
      "app/routes.py",
      "tools.py",
      "tools/search.py",
      "main.py",
    ]);
    expect([...namespaces].sort()).toEqual(["mcp", "openai"]);
  });
});
