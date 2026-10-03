import { getAsset, isSea } from "node:sea";

/** Embedded resources are immutable and never resolved against the scanned project. */
export const isEmbeddedBinary = isSea();

export function embeddedAsset(name: string): Buffer | undefined {
  return isEmbeddedBinary ? Buffer.from(getAsset(name)) : undefined;
}
