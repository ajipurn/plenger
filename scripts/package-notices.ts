import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeBinaryNotices } from "./binary-notices.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

await writeBinaryNotices(root, join(root, "dist/THIRD_PARTY_NOTICES.txt"), {
  includeNodeRuntime: false,
});
