import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

interface Package {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface LicenseSource {
  name: string;
  version: string;
  filename: string;
  source: string;
  sha256: string;
}

/** Include full upstream texts for the runtime and the production dependency closure. */
export async function writeBinaryNotices(root: string, destination: string): Promise<void> {
  const sources = JSON.parse(
    await readFile(join(root, "docs/licenses/sources.json"), "utf8"),
  ) as LicenseSource[];
  const notices = new Map<string, string>();
  const seen = new Set<string>();

  async function vendoredLicense(name: string, version: string): Promise<string> {
    const source = sources.find((entry) => entry.name === name && entry.version === version);
    if (source === undefined)
      throw new Error(`Missing upstream license text for ${name}@${version}.`);
    const text = await readFile(join(root, "docs/licenses", source.filename), "utf8");
    if (createHash("sha256").update(text).digest("hex") !== source.sha256)
      throw new Error(`Upstream license checksum mismatch: ${source.filename}`);
    return `Source: ${source.source}\n\n${text}`;
  }

  async function visit(name: string, parent: string, optional = false): Promise<void> {
    const loader = createRequire(parent);
    const candidate = loader.resolve
      .paths(name)
      ?.map((path) => join(path, name, "package.json"))
      .find(existsSync);
    if (candidate === undefined) {
      if (optional) return;
      throw new Error(`Cannot find the installed production dependency ${name}.`);
    }
    const filename = await realpath(candidate);
    const pkg = JSON.parse(await readFile(filename, "utf8")) as Package;
    const id = `${pkg.name}@${pkg.version}`;
    if (seen.has(id)) return;
    seen.add(id);
    const directory = dirname(filename);
    const licenseFiles = (await readdir(directory))
      .filter((entry) => /^(licen[sc]e|copying|notice)([-.].*)?$/i.test(entry))
      .sort();
    const texts =
      licenseFiles.length > 0
        ? await Promise.all(
            licenseFiles.map(
              async (entry) =>
                `Source: installed npm package ${id}/${entry}\n\n${await readFile(join(directory, entry), "utf8")}`,
            ),
          )
        : [await vendoredLicense(pkg.name, pkg.version)];
    notices.set(id, `License: ${pkg.license ?? "see upstream text"}\n${texts.join("\n\n")}`);
    for (const dependency of Object.keys(pkg.dependencies ?? {})) await visit(dependency, filename);
    for (const dependency of Object.keys(pkg.optionalDependencies ?? {}))
      await visit(dependency, filename, true);
  }

  for (const name of ["package.json", "dashboard/package.json"]) {
    const filename = join(root, name);
    const pkg = JSON.parse(await readFile(filename, "utf8")) as Package;
    for (const dependency of Object.keys(pkg.dependencies ?? {})) await visit(dependency, filename);
  }
  // Tailwind's generated CSS ships in the dashboard although its compiler is a dev dependency.
  await visit("tailwindcss", join(root, "dashboard/package.json"));
  const grammars = JSON.parse(
    await readFile(join(root, "grammars/manifest.json"), "utf8"),
  ) as Record<string, { package: string; version: string }>;
  for (const grammar of Object.values(grammars)) {
    const id = `${grammar.package}@${grammar.version}`;
    if (!notices.has(id)) notices.set(id, await vendoredLicense(grammar.package, grammar.version));
  }

  const nodeSource = `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`;
  const nodeLicense = [
    join(dirname(process.execPath), "LICENSE"),
    join(dirname(dirname(process.execPath)), "LICENSE"),
  ].find(existsSync);
  let nodeText: string;
  if (nodeLicense !== undefined) nodeText = await readFile(nodeLicense, "utf8");
  else {
    const response = await fetch(nodeSource, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Cannot retrieve the Node.js license (${response.status}).`);
    nodeText = await response.text();
  }
  notices.set(`Node.js@${process.versions.node}`, `Source: ${nodeSource}\n\n${nodeText}`);
  const sections = [...notices]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, text]) => `${"=".repeat(72)}\n${name}\n${"=".repeat(72)}\n\n${text.trim()}\n`);
  await writeFile(
    destination,
    `Plenger third-party notices\n\nFull license texts for the bundled Node.js runtime, WASM grammars, and backend\nand dashboard production dependencies (including dependencies trimmed by bundling).\nTailwind CSS is included because its generated styles ship in the dashboard.\n\n${sections.join("\n")}\n`,
  );
  console.log(
    `Third-party notices: ${notices.size} components (including Node.js bundled notices).`,
  );
}
