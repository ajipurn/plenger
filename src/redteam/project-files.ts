import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export class ProjectFileError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/** Read a bounded regular file; reject links and changes during the read. */
export async function readProjectFile(root: string, path: string, limit: number): Promise<Buffer> {
  const absolute = join(root, path);
  const local = relative(root, absolute);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
    throw new ProjectFileError("outside-project");
  try {
    const before = await lstat(absolute);
    if (!before.isFile() || before.nlink !== 1)
      throw new ProjectFileError("not-a-single-regular-file");
    if ((await realpath(absolute)) !== absolute) throw new ProjectFileError("linked-path");
    if (before.size > limit) throw new ProjectFileError("too-large");
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.ino !== before.ino ||
        opened.dev !== before.dev ||
        opened.nlink !== 1
      )
        throw new ProjectFileError("file-changed");
      const buffer = Buffer.alloc(limit + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
      }
      if (bytes > limit) throw new ProjectFileError("too-large");
      const after = await handle.stat();
      const current = await lstat(absolute);
      if (
        after.size !== bytes ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        current.ino !== after.ino ||
        current.dev !== after.dev ||
        current.isSymbolicLink() ||
        after.nlink !== 1 ||
        (await realpath(absolute)) !== absolute
      )
        throw new ProjectFileError("file-changed");
      return Buffer.from(buffer.subarray(0, bytes));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ProjectFileError) throw error;
    throw new ProjectFileError(
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "missing"
        : "unreadable",
    );
  }
}

export function decodeSource(bytes: Buffer): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("binary");
    return text;
  } catch {
    throw new ProjectFileError("not-utf8-text");
  }
}
