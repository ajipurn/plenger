import { createHash } from "node:crypto";

/** Hex SHA-256 of `input`, optionally truncated to `length` characters. */
export function sha256Hex(input: string | Uint8Array, length?: number): string {
  const digest = createHash("sha256").update(input).digest("hex");
  return length === undefined ? digest : digest.slice(0, length);
}
