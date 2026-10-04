import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// tsc never deletes output, so files compiled from removed sources would otherwise
// stay in dist/ and ship in the npm package. Binary and npm archives are kept.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const keep = new Set(["binary", "npm"]);
await mkdir(dist, { recursive: true });
for (const entry of await readdir(dist)) {
  if (!keep.has(entry)) await rm(join(dist, entry), { recursive: true, force: true });
}
