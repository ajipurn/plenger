import { readFileSync } from "node:fs";
import { embeddedAsset } from "./assets.ts";

export const VERSION: string = JSON.parse(
  (
    embeddedAsset("package.json") ?? readFileSync(new URL("../package.json", import.meta.url))
  ).toString("utf8"),
).version;
