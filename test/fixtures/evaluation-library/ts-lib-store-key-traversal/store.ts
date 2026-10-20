import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export class LocalFileStore {
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  async get(key: string): Promise<Buffer> {
    return readFile(path.join(this.rootPath, key));
  }

  async set(key: string, value: Buffer): Promise<void> {
    await writeFile(path.join(this.rootPath, key), value);
  }
}
