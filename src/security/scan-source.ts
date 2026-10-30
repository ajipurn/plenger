import { createHash } from "node:crypto";
import { readProjectFile } from "../redteam/project-files.ts";
import { collectSourceFiles, DEFAULT_MAX_FILE_BYTES } from "../source/files.ts";

/** A local fingerprint only. No source or keys are persisted or sent by this check. */
export async function scanSourceDigest(root: string, signal?: AbortSignal): Promise<string> {
  const collected = await collectSourceFiles(root, { texts: true });
  if (collected.root !== root) throw new Error("source-root-changed");
  const paths = [
    ...new Set(
      [...collected.files, ...collected.texts, ...collected.platform].map((file) => file.path),
    ),
  ].sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    signal?.throwIfAborted();
    const bytes = await readProjectFile(root, path, DEFAULT_MAX_FILE_BYTES).catch(() => null);
    hash.update(
      JSON.stringify([
        path,
        bytes === null ? null : createHash("sha256").update(bytes).digest("hex"),
      ]),
    );
  }
  hash.update(JSON.stringify(collected.skipped));
  return hash.digest("hex");
}
