import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatgptHostId, providerEncryptionKey } from "../src/storage/provider-secrets.ts";
import { temporaryDir } from "./support/tmp.ts";

describe("provider key files", () => {
  it("give every dashboard starting at once the same whole key and leave no temporary file", async () => {
    const directory = await temporaryDir();
    const keys = await Promise.all(
      Array.from({ length: 8 }, () => providerEncryptionKey(directory)),
    );
    const saved = await readFile(join(directory, "provider-key"));
    expect(saved).toHaveLength(32);
    for (const key of keys) expect(key.equals(saved)).toBe(true);
    if (process.platform !== "win32")
      expect((await stat(join(directory, "provider-key"))).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["provider-key"]);
  });

  it("names an empty key file left by an interrupted first start", async () => {
    const directory = await temporaryDir();
    await writeFile(join(directory, "provider-key"), "", { mode: 0o600 });
    await expect(providerEncryptionKey(directory)).rejects.toThrow(
      "is empty, as an interrupted first start leaves it",
    );
  });

  it("gives concurrent ChatGPT sign-ins one host identity", async () => {
    const directory = await temporaryDir();
    const ids = await Promise.all(Array.from({ length: 8 }, () => chatgptHostId(directory)));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^urn:uuid:[a-f0-9-]{36}$/);
  });
});
