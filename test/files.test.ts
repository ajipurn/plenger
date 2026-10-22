import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectSourceFiles } from "../src/source/files.ts";
import { classifyPath, textKindOf } from "../src/source/languages.ts";

describe("classifyPath", () => {
  it.each([
    ["agent.py", "python"],
    ["server.mjs", "javascript"],
    ["config.cjs", "javascript"],
    ["Button.jsx", "javascript"],
    ["agent.ts", "typescript"],
    ["route.mts", "typescript"],
    ["Chat.tsx", "tsx"],
    ["UPPER.PY", "python"],
    ["app/Http/Controllers/UserController.php", "php"],
  ])("maps %s to the %s grammar", (path, grammar) => {
    expect(classifyPath(path)).toEqual({ kind: "source", grammar });
  });

  it.each([
    ["index.d.ts", "declaration"],
    ["types.d.mts", "declaration"],
    ["vendor.min.js", "minified"],
    ["bundle-min.js", "minified"],
  ])("recognises %s but ignores it as %s", (path, reason) => {
    expect(classifyPath(path)).toEqual({ kind: "ignored", reason });
  });

  it.each(["README.md", "Makefile", ".py", "agent.pyc", "stubs.pyi"])("leaves %s alone", (path) => {
    expect(classifyPath(path)).toEqual({ kind: "other" });
  });
});

describe("textKindOf", () => {
  it.each([
    ["cmd/server/main.go", "code"],
    ["app/views/home.phtml", "code"],
    ["templates/invoice.html", "code"],
    ["db/migrate/001_users.sql", "code"],
    ["Makefile", "code"],
    ["config/app.yaml", "config"],
    ["deploy/main.tf", "config"],
    ["Dockerfile", "config"],
    ["Dockerfile.prod", "config"],
    ["deploy/api.dockerfile", "config"],
    ["firestore.rules", "config"],
  ])("reads %s as %s", (path, kind) => {
    expect(textKindOf(path)).toBe(kind);
  });

  it.each([
    "agent.py",
    "server.ts",
    "README.md",
    "logo.png",
    "package-lock.json",
    "pnpm-lock.yaml",
    "api/users.pb.go",
    "static/site.min.css",
    "client_generated.go",
  ])("leaves %s to the parser or out of review", (path) => {
    expect(textKindOf(path)).toBeNull();
  });
});

describe("collectSourceFiles", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "plenger-files-"));
    const files: Record<string, string> = {
      "agent.py": "print('hi')\n",
      "src/b.ts": "export const b = 1;\n",
      "src/a.ts": "export const a = 1;\n",
      "src/types.d.ts": "export declare const a: number;\n",
      "src/big.js": "x".repeat(2048),
      "notes.txt": "not code\n",
      ".plenger/runs/generated.ts": "export const evidence = {};\n",
      "node_modules/pkg/index.js": "module.exports = 1;\n",
      "packages/web/node_modules/pkg/index.js": "module.exports = 1;\n",
      "env/pyvenv.cfg": "home = /usr/bin\n",
      "env/lib/site.py": "print('venv')\n",
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await symlink(join(root, "agent.py"), join(root, "link.py"));
    await symlink(join(root, "src"), join(root, "linked-src"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists source files sorted by path and explains what it skipped", async () => {
    const result = await collectSourceFiles(root, { maxFileBytes: 1024 });

    expect(result.files.map((file) => [file.path, file.grammar])).toEqual([
      ["agent.py", "python"],
      ["src/a.ts", "typescript"],
      ["src/b.ts", "typescript"],
    ]);
    expect(result.skipped).toEqual([
      { path: "link.py", reason: "symlink" },
      { path: "linked-src", reason: "symlink" },
      { path: "src/big.js", reason: "too_large" },
      { path: "src/types.d.ts", reason: "declaration" },
    ]);
    expect(result.excludedDirs).toEqual([
      { path: ".plenger", reason: "default" },
      { path: "env", reason: "virtualenv" },
      { path: "node_modules", reason: "default" },
      { path: "packages/web/node_modules", reason: "default" },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("stops at the file limit and says so", async () => {
    const result = await collectSourceFiles(root, { maxFiles: 2 });
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("accepts a single source file as the root", async () => {
    const result = await collectSourceFiles(join(root, "src/a.ts"));
    expect(result.root).toBe(join(await realpath(root), "src"));
    expect(result.files.map((file) => file.path)).toEqual(["a.ts"]);
  });

  it("rejects a single file it cannot analyse", async () => {
    await expect(collectSourceFiles(join(root, "notes.txt"))).rejects.toThrow("not a Python");
  });
});

describe("collectSourceFiles with texts", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "plenger-texts-"));
    const files: Record<string, string> = {
      ".gitignore": "secret.yaml\n",
      "agent.py": "print('hi')\n",
      "main.go": "package main\n",
      "web/index.html": "<p>hi</p>\n",
      ".github/workflows/ci.yml": "on: push\n",
      "secret.yaml": "token: x\n",
      "package-lock.json": "{}\n",
      "logo.png": "png",
      "big.yaml": "a: 1\n".repeat(400),
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists text files without a parser beside the source files, under the same rules", async () => {
    const result = await collectSourceFiles(root, { maxFileBytes: 1024, texts: true });
    expect(result.files.map((file) => file.path)).toEqual(["agent.py"]);
    expect(result.texts.map((file) => [file.path, file.kind])).toEqual([
      [".github/workflows/ci.yml", "config"],
      ["main.go", "code"],
      ["web/index.html", "code"],
    ]);
    expect(result.skipped).toEqual([{ path: "big.yaml", reason: "too_large" }]);
  });

  it("lists no text files unless asked", async () => {
    const result = await collectSourceFiles(root, { maxFileBytes: 1024 });
    expect(result.texts).toEqual([]);
    // YAML can be a Kubernetes manifest that names a runtime image, so it is still listed.
    expect(result.platform.map((file) => file.path)).toEqual([".github/workflows/ci.yml"]);
    expect(result.skipped).toEqual([{ path: "big.yaml", reason: "too_large" }]);
  });

  it("counts text files toward the file limit", async () => {
    const result = await collectSourceFiles(root, { maxFiles: 2, texts: true });
    expect(result.files.length + result.texts.length).toBe(2);
    expect(result.truncated).toBe(true);
  });
});

describe("collectSourceFiles with .gitignore", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "plenger-gitignore-"));
    const files: Record<string, string> = {
      ".gitignore": "generated/\n*.gen.ts\n!keep.gen.ts\n",
      "generated/client.py": "x = 1\n",
      "src/api.gen.ts": "export {};\n",
      "src/keep.gen.ts": "export {};\n",
      "src/main.ts": "export {};\n",
      "packages/app/.gitignore": "local_settings.py\n",
      "packages/app/local_settings.py": "KEY = 1\n",
      "packages/app/main.py": "print(1)\n",
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("leaves out what root and nested .gitignore files ignore", async () => {
    const result = await collectSourceFiles(root);

    expect(result.files.map((file) => file.path)).toEqual([
      "packages/app/main.py",
      "src/keep.gen.ts",
      "src/main.ts",
    ]);
    expect(result.skipped).toEqual([
      { path: "packages/app/local_settings.py", reason: "gitignored" },
      { path: "src/api.gen.ts", reason: "gitignored" },
    ]);
    expect(result.excludedDirs).toEqual([{ path: "generated", reason: "gitignore" }]);
  });

  it("scans everything when asked to ignore .gitignore", async () => {
    const result = await collectSourceFiles(root, { gitignore: false });
    expect(result.files).toHaveLength(6);
    expect(result.excludedDirs).toEqual([]);
  });
});
