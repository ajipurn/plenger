import { MITIGATION_SETTINGS } from "./advisories.ts";
import { parseVersion } from "./images.ts";
import type { PlatformLocation, RuntimePlatform, RuntimeSetting, SettingScope } from "./model.ts";

const escaped = (name: string) => name.replace(/[.[\]]/g, "\\$&");
const NAMES = [...MITIGATION_SETTINGS].map(escaped).join("|");

/**
 * A setting in php.ini (`name = 0`), FPM pool (`php_admin_value[name] = 0`), Apache
 * (`php_flag name off`) or nginx (`PHP_VALUE "name=0"`) syntax, and `-d name=0`.
 */
const DIRECTIVE = new RegExp(`(${NAMES})(?:\\]\\s*=|\\s*=|\\s+)\\s*["']?([^\\s"';\\]#]*)`, "gi");
/** A line that is only a comment in ini, FPM, Apache and nginx files. */
const CONFIG_COMMENT = /^\s*[;#]/;

/** Settings in PHP, FPM, Apache or nginx configuration. `.user.ini` applies late. */
export function configSettings(path: string, text: string): RuntimeSetting[] {
  const scope: SettingScope = /(?:^|\/)\.user\.ini$/i.test(path) ? "user_ini" : "startup";
  const settings: RuntimeSetting[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (CONFIG_COMMENT.test(line)) return;
    settings.push(...directives(line, { path, line: index + 1 }, scope));
  });
  return settings;
}

/** Settings written into one line or instruction of a build, which apply at startup. */
export function directives(
  text: string,
  at: { path: string; line: number },
  scope: SettingScope,
): RuntimeSetting[] {
  const settings: RuntimeSetting[] = [];
  for (const match of text.matchAll(DIRECTIVE)) {
    const [whole, name = "", value = ""] = match;
    settings.push({
      runtime: "php",
      name: name.toLowerCase(),
      enabled: iniBoolean(value),
      scope,
      location: span(at, match.index, whole.length),
    });
  }
  return settings;
}

/** `config.platform.php` of `composer.json`, or null when it sets none or cannot be read. */
export function composerPlatform(path: string, text: string): RuntimePlatform | null {
  let value: unknown;
  try {
    value = (JSON.parse(text) as { config?: { platform?: { php?: unknown } } })?.config?.platform
      ?.php;
  } catch {
    return null;
  }
  if (typeof value !== "string") return null;
  const version = /^\s*v?(\d+(?:\.\d+){0,2})/.exec(value)?.[1];
  const parsed = version === undefined ? null : parseVersion(version);
  if (parsed === null || parsed.minor === undefined) return null;
  // The entry after `"platform"`, so that `require.php` is not taken for it.
  const platform = text.indexOf('"platform"');
  const entry = /"php"\s*:\s*"[^"]*"/g;
  entry.lastIndex = Math.max(platform, 0);
  const found = entry.exec(text);
  const offset = found?.index ?? 0;
  const before = text.slice(0, offset).split("\n");
  const line = before.length;
  const column = (before.at(-1)?.length ?? 0) + 1;
  return {
    kind: "platform",
    runtime: "php",
    version: parsed,
    text: value,
    location: {
      path,
      line,
      column,
      endLine: line,
      endColumn: column + (found?.[0].length ?? 0),
    },
  };
}

/** php.ini booleans: `0`, `off`, `false`, `no`, `none` and empty are off. */
export function iniBoolean(value: string): boolean | null {
  const word = value
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
  if (/^(?:0|off|false|no|none|)$/.test(word)) return false;
  if (/^(?:1|on|true|yes)$/.test(word)) return true;
  return null;
}

function span(at: { path: string; line: number }, index: number, length: number): PlatformLocation {
  return {
    path: at.path,
    line: at.line,
    column: index + 1,
    endLine: at.line,
    endColumn: index + 1 + length,
  };
}
