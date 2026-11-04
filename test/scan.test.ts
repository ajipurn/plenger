import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { type ParseResult, parseOnWorkers } from "../src/parse-files.ts";
import { scan } from "../src/scan.ts";
import { looksMinified } from "../src/source/read.ts";
import { fixturePath } from "./support/fixtures.ts";
import { temporaryDir } from "./support/tmp.ts";

describe("looksMinified", () => {
  it("flags large single-line bundles", () => {
    expect(looksMinified(`var a=1;`.repeat(400))).toBe(true);
  });

  it("keeps ordinary source, however long", () => {
    const source = "export const answer = 42;\n".repeat(400);
    expect(looksMinified(source)).toBe(false);
  });

  it("keeps small files with one long line", () => {
    expect(looksMinified(`const prompt = "${"x".repeat(1500)}";\n`)).toBe(false);
  });

  it("keeps written code with one very long comment or string line", () => {
    const route = 'app.get("/f", (req, res) => res.send(read(req.query.name)));\n'.repeat(6);
    expect(looksMinified(`${route}// ${"x".repeat(4000)}\n`)).toBe(false);
    expect(looksMinified(`const pad = "${"x".repeat(4000)}";\n${route}`)).toBe(false);
  });

  it("flags bundles with a licence header and a source map comment", () => {
    const header = "/*!\n * Example v1.0.0\n * Licensed MIT\n */\n";
    const bundle = `${header}${"var a=1;".repeat(600)}\nexport{a as b};\n//# sourceMappingURL=x.js.map\n`;
    expect(looksMinified(bundle)).toBe(true);
  });
});

describe("files the scan could skip", () => {
  const route = [
    'const express = require("express");',
    'const fs = require("fs");',
    "const app = express();",
    'app.get("/f", (req, res) => { res.send(fs.readFileSync("/srv/data/" + req.query.name)); });',
    "",
  ].join("\n");

  async function findingsOf(content: string | Buffer) {
    const root = await temporaryDir();
    await writeFile(join(root, "app.js"), content);
    const result = await scan(root);
    return { rules: result.findings.map((finding) => finding.rule), skipped: result.skipped };
  }

  it("still analyses source with a NUL byte, a byte that is not UTF-8 or one long line", async () => {
    const clean = await findingsOf(route);
    expect(clean.rules.length).toBeGreaterThan(0);
    for (const content of [
      `// \0\n${route}`,
      Buffer.concat([Buffer.from("// caf"), Buffer.from([0xe9]), Buffer.from(`\n${route}`)]),
      `${route}// ${"x".repeat(4000)}\n`,
    ])
      expect(await findingsOf(content)).toEqual(clean);
  });

  it("skips UTF-16 text and binary data", async () => {
    const utf16 = Buffer.from(`\ufeff${route}`, "utf16le");
    expect((await findingsOf(utf16)).skipped).toEqual([{ path: "app.js", reason: "binary" }]);
    const binary = Buffer.from([0x47, 0x40, 0x00, 0x10, 0xff, 0xfe, 0x00, 0x00, 0x9c]);
    expect((await findingsOf(binary)).skipped).toEqual([{ path: "app.js", reason: "binary" }]);
  });

  it("skips a file nested too deeply to parse into facts, and scans the rest", async () => {
    const root = await temporaryDir();
    const depth = 900;
    await writeFile(
      join(root, "deep.js"),
      `const x =\n${"{a:\n".repeat(depth)}1\n${"}\n".repeat(depth)};\n`,
    );
    await writeFile(join(root, "app.js"), route);
    for (const workers of [0, 2]) {
      const result = await scan(root, { workers });
      expect(result.skipped).toEqual([{ path: "deep.js", reason: "too_deep" }]);
      expect(result.findings.length).toBeGreaterThan(0);
    }
  });
});

describe("binaries in a scanned project", () => {
  it("lists compiled and packaged files with their kind, size and hash, and never reads them as source", async () => {
    const root = await temporaryDir();
    await mkdir(join(root, "lib"), { recursive: true });
    await mkdir(join(root, "node_modules/addon"), { recursive: true });
    await writeFile(join(root, "app.py"), "print('ok')\n");
    await writeFile(join(root, "lib/libfast.so.1"), "ELF");
    await writeFile(join(root, "lib/engine.wasm"), "wasm");
    await writeFile(join(root, "lib/ignored.dll"), "MZ");
    await writeFile(join(root, ".gitignore"), "lib/ignored.dll\n");
    await writeFile(join(root, "node_modules/addon/addon.node"), "ELF");
    const result = await scan(root);
    expect(result.files.map((file) => file.path)).toEqual(["app.py"]);
    expect(result.binaries).toEqual([
      {
        path: "lib/engine.wasm",
        kind: "WebAssembly",
        bytes: 4,
        sha256: createHash("sha256").update("wasm").digest("hex"),
      },
      {
        path: "lib/libfast.so.1",
        kind: "native library",
        bytes: 3,
        sha256: createHash("sha256").update("ELF").digest("hex"),
      },
    ]);
  });

  it("leaves the field out when there are none", async () => {
    const root = await temporaryDir();
    await writeFile(join(root, "app.py"), "print('ok')\n");
    expect((await scan(root)).binaries).toBeUndefined();
  });
});

describe("parsing on worker threads", () => {
  it("gives the same scan as parsing on the main thread", async () => {
    const root = fixturePath("risks");
    const inline = await scan(root, { workers: 0, facts: true });
    const threaded = await scan(root, { workers: 2, facts: true });
    const strip = (result: Awaited<ReturnType<typeof scan>>) => ({ ...result, durationMs: 0 });
    expect(strip(threaded)).toEqual(strip(inline));
    // Two scans of the risk fixtures, one of them starting workers.
  }, 30000);

  it("stops every worker and rejects when one exits with a task still out", async () => {
    const dir = await temporaryDir();
    const script = join(dir, "exits.mjs");
    await writeFile(
      script,
      'import { parentPort } from "node:worker_threads";\nparentPort.on("message", () => process.exit(0));\n',
    );
    const tasks = ["a.py", "b.py", "c.py"].map((path) => ({
      path,
      absolutePath: join(dir, path),
      grammar: "python" as const,
      bytes: 0,
    }));
    const results: (ParseResult | undefined)[] = new Array(tasks.length);
    // An exit with code 0 and no error event used to leave the scan waiting forever.
    await expect(parseOnWorkers(tasks, 1024, 2, results, pathToFileURL(script))).rejects.toThrow(
      "parse worker exited 0",
    );
    expect(results.every((result) => result === undefined)).toBe(true);
  });
});
