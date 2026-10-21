import { readFileSync } from "node:fs";

/** The installed package's version, read from its own package.json, never the scanned project's. */
const metadata: { name: string; version: string; private?: boolean } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

export const VERSION = metadata.version;
export const PACKAGE_NAME = metadata.name;
export const PRIVATE_BUILD = metadata.private === true;
