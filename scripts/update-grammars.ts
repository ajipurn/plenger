// Downloads the pinned tree-sitter grammar packages, copies only their WASM
// builds into grammars/ and records each file's SHA-256 in grammars/manifest.json.
// The grammar packages are never installed, so their native install scripts never run.
// Usage: node scripts/update-grammars.ts

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GRAMMARS = {
  python: { package: "tree-sitter-python", version: "0.25.0", file: "tree-sitter-python.wasm" },
  javascript: {
    package: "tree-sitter-javascript",
    version: "0.25.0",
    file: "tree-sitter-javascript.wasm",
  },
  typescript: {
    package: "tree-sitter-typescript",
    version: "0.23.2",
    file: "tree-sitter-typescript.wasm",
  },
  tsx: { package: "tree-sitter-typescript", version: "0.23.2", file: "tree-sitter-tsx.wasm" },
  // PHP with the HTML around `<?php` blocks; `tree-sitter-php_only.wasm` is the other grammar.
  php: { package: "tree-sitter-php", version: "0.24.2", file: "tree-sitter-php.wasm" },
};

const grammarDir = fileURLToPath(new URL("../grammars/", import.meta.url));
const workDir = await mkdtemp(join(tmpdir(), "plenger-grammars-"));

try {
  const manifest: Record<string, unknown> = {};
  const unpacked = new Map<string, string>();

  for (const [grammar, spec] of Object.entries(GRAMMARS)) {
    const id = `${spec.package}@${spec.version}`;
    let packageDir = unpacked.get(id);
    if (packageDir === undefined) {
      const tarball = execFileSync("npm", ["pack", id, "--silent", "--pack-destination", workDir], {
        encoding: "utf8",
      }).trim();
      packageDir = join(workDir, spec.package);
      await mkdir(packageDir, { recursive: true });
      execFileSync("tar", [
        "-xzf",
        join(workDir, tarball),
        "-C",
        packageDir,
        "--strip-components=1",
      ]);
      unpacked.set(id, packageDir);
    }

    const target = join(grammarDir, spec.file);
    await copyFile(join(packageDir, spec.file), target);
    const sha256 = createHash("sha256")
      .update(await readFile(target))
      .digest("hex");
    manifest[grammar] = { ...spec, sha256 };
    console.log(`${grammar}: ${id} ${spec.file} ${sha256}`);
  }

  await writeFile(join(grammarDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
