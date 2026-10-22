import type { PlatformFile } from "../source/files.ts";
import { readSource } from "../source/read.ts";
import { MITIGATION_SETTINGS } from "./advisories.ts";
import { readDockerfile } from "./dockerfile.ts";
import { mentionsPhpImage } from "./images.ts";
import { readManifest } from "./manifests.ts";
import type { Platform } from "./model.ts";
import { composerPlatform, configSettings } from "./settings.ts";

/**
 * Reads what the listed files declare about the runtimes the project deploys on. Reads
 * files only; files that cannot be read, are too large or are not UTF-8 text are left out.
 */
export async function readPlatform(files: PlatformFile[], maxFileBytes: number): Promise<Platform> {
  const platform: Platform = { declarations: [], settings: [] };
  for (const file of files) {
    const text = await readSource(file.absolutePath, maxFileBytes);
    if (typeof text !== "string") continue;
    switch (file.kind) {
      case "dockerfile": {
        const found = readDockerfile(file.path, text);
        platform.declarations.push(...found.declarations);
        platform.settings.push(...found.settings);
        break;
      }
      case "compose":
      case "yaml":
        if (mentionsPhpImage(text))
          platform.declarations.push(...readManifest(file.path, text, file.kind === "compose"));
        break;
      case "composer": {
        const found = composerPlatform(file.path, text);
        if (found !== null) platform.declarations.push(found);
        break;
      }
      case "php-config":
        if (mentionsSetting(text)) platform.settings.push(...configSettings(file.path, text));
        break;
    }
  }
  return platform;
}

function mentionsSetting(text: string): boolean {
  const lower = text.toLowerCase();
  for (const name of MITIGATION_SETTINGS) if (lower.includes(name)) return true;
  return false;
}
