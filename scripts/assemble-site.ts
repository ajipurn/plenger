import { cp } from "node:fs/promises";

// Run after both builds. Keep each package's standalone output intact.
for (const directory of ["docs", "_next"]) {
  await cp(
    new URL(`../docs-site/out/${directory}`, import.meta.url),
    new URL(`../landing/dist/${directory}`, import.meta.url),
    { recursive: true },
  );
}
