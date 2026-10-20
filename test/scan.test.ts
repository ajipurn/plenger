import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  });
});
