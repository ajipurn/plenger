import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isErrno } from "../shared/guards.ts";
import { StoreValidationError } from "./errors.ts";

/** One non-secret installation identity, reused across ChatGPT account registrations. */
export async function chatgptHostId(directory: string): Promise<string> {
  const path = join(directory, "chatgpt-host");
  try {
    await writeFile(path, `urn:uuid:${randomUUID()}`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const value = await readFile(path, "utf8");
  if (!/^urn:uuid:[a-f0-9-]{36}$/.test(value))
    throw new Error("Invalid ChatGPT host identity in the data directory.");
  return value;
}

/** Local encryption at rest. The key belongs to this user's data directory, not exports or SQLite. */
export async function providerEncryptionKey(directory: string): Promise<Buffer> {
  const path = join(directory, "provider-key");
  try {
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      const key = randomBytes(32);
      await file.writeFile(key);
      await file.sync();
      return key;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size !== 32 ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
      throw new Error(
        "Provider encryption key needs a private 32-byte file. Check data-directory permissions.",
      );
    return await file.readFile();
  } finally {
    await file.close();
  }
}

export function sealProviderKey(key: Buffer, id: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(id));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

export function openProviderKey(key: Buffer, id: string, sealed: string): string {
  try {
    const bytes = Buffer.from(sealed, "base64");
    if (bytes.length < 29) throw new Error();
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    cipher.setAAD(Buffer.from(id));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
  } catch (error) {
    // Tampering and a changed key look alike here; the remedy is the same for both.
    throw new StoreValidationError(
      "Saved provider key could not be unlocked. Enter the API key again in Providers.",
      { cause: error },
    );
  }
}
