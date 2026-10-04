import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** A private atomic artifact; partial campaign evidence survives process interruption. */
export async function writeCampaignArtifact(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(text, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Parse a JSON file after checking its size; `description` names the file in the error. */
export async function readJsonFile(
  path: string,
  maxBytes: number,
  description: string,
): Promise<unknown> {
  if ((await stat(path)).size > maxBytes)
    throw new Error(`${description} exceeds ${maxBytes / (1024 * 1024)} MiB.`);
  return JSON.parse(await readFile(path, "utf8"));
}
