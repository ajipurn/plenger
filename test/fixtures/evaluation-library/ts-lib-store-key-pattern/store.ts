import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const KEY = /^[A-Za-z0-9_-]+$/;

export class LocalFileStore {
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  async get(key: string): Promise<Buffer> {
    if (!KEY.test(key)) throw new Error(`invalid key: ${key}`);
    return readFile(path.join(this.rootPath, key));
  }

  async set(key: string, value: Buffer): Promise<void> {
    if (!KEY.test(key)) throw new Error(`invalid key: ${key}`);
    await writeFile(path.join(this.rootPath, key), value);
  }
}
