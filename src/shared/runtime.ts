import { readFileSync } from "node:fs";

/** The installed package's version, read from its own package.json, never the scanned project's. */
export const VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;
