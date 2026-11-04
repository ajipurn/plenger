import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { API_KEY_PREVIEW } from "../redteam/constants.ts";
import type { ProviderModelConnection } from "../redteam/provider-models.ts";
import { isErrno } from "../shared/guards.ts";
import { StoreValidationError } from "./errors.ts";

/**
 * Creates the private file `path` holding `content` unless it exists. The content is
 * written and synced to a temporary file that is then linked into place, so a second
 * dashboard starting at the same time, or a start after a crash, never reads it empty or
 * half written. Returns whether this call created the file.
 */
async function createPrivateFile(path: string, content: Buffer | string): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    if (!["EPERM", "ENOTSUP", "ENOSYS"].some((code) => isErrno(error, code))) throw error;
    // A filesystem without hard links: an exclusive copy keeps the file whole once written.
    try {
      await copyFile(temporary, path, constants.COPYFILE_EXCL);
      return true;
    } catch (copyError) {
      if (isErrno(copyError, "EEXIST")) return false;
      throw copyError;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** One non-secret installation identity, reused across ChatGPT account registrations. */
export async function chatgptHostId(directory: string): Promise<string> {
  const path = join(directory, "chatgpt-host");
  await createPrivateFile(path, `urn:uuid:${randomUUID()}`);
  const value = await readFile(path, "utf8");
  if (!/^urn:uuid:[a-f0-9-]{36}$/.test(value))
    throw new Error("Invalid ChatGPT host identity in the data directory.");
  return value;
}

/** Local encryption at rest. The key belongs to this user's data directory, not exports or SQLite. */
export async function providerEncryptionKey(directory: string): Promise<Buffer> {
  const path = join(directory, "provider-key");
  const key = randomBytes(32);
  if (await createPrivateFile(path, key)) return key;
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    // Earlier versions created the file before writing it, so a crash could leave it empty.
    if (stat.isFile() && stat.size === 0)
      throw new Error(
        `The provider encryption key file ${path} is empty, as an interrupted first start leaves it. If no provider keys were saved yet, delete it and start again.`,
      );
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

/** Scope cached models to one connection without persisting its key or an unkeyed hash. */
export function providerModelCacheKey(key: Buffer, connection: ProviderModelConnection): string {
  return createHmac("sha256", key)
    .update("provider-model-catalog\0")
    .update(JSON.stringify([connection.provider, connection.baseUrl, connection.apiKey]))
    .digest("hex");
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

/** Derive a bounded display hint locally. Short or unreadable keys stay fully masked. */
export function redactedProviderKey(key: Buffer, id: string, sealed: string): string {
  try {
    const secret = Array.from(openProviderKey(key, id, sealed));
    return secret.length >= API_KEY_PREVIEW.minimumLength
      ? `${API_KEY_PREVIEW.mask}${secret.slice(-API_KEY_PREVIEW.suffixLength).join("")}`
      : API_KEY_PREVIEW.mask;
  } catch {
    // Keep damaged credentials editable; resolving them still fails closed.
    return API_KEY_PREVIEW.mask;
  }
}
