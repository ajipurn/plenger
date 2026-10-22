import type { RuntimeImage, RuntimeVersion, ServerApi } from "./model.ts";

/** Stands for a build argument or variable that has no value, inside an image reference. */
export const UNRESOLVED = "\u0000";

/**
 * Images whose tag starts with the PHP version (`php:8.3.35-apache`, `bitnami/php-fpm:8.2`),
 * by the last part of their name, with the server API the name implies.
 */
const PHP_IMAGES: Record<string, ServerApi | null> = {
  php: null,
  "php-fpm": "fpm",
  "php-apache": "apache",
  "php-nginx": "fpm",
};

/** Official application images built on the PHP image, whose tags name the application's version. */
const PHP_APPLICATIONS: ReadonlySet<string> = new Set([
  "wordpress",
  "drupal",
  "joomla",
  "nextcloud",
  "mediawiki",
  "matomo",
  "phpmyadmin",
]);

/** Whether a text may name a PHP image, to skip files that cannot. */
export function mentionsPhpImage(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("php") || [...PHP_APPLICATIONS].some((name) => lower.includes(name));
}

/** A PHP version inside a tag: `6.6-php8.2-apache`, `1-php8.3.12`, `php83`. */
const TAG_VERSION = /(?:^|[-_.])php-?(\d+(?:\.\d+){0,2})(?=$|[-_]|[a-z])/;
const LEADING_VERSION = /^(\d+(?:\.\d+){0,2})(?=$|[^\d.])/;

/** What a container image reference says about the PHP it ships, or null when it ships none plenger knows. */
export function phpImage(
  reference: string,
): Pick<RuntimeImage, "version" | "hidden" | "api"> | null {
  let named = reference.trim();
  const digest = named.indexOf("@");
  if (digest >= 0) named = named.slice(0, digest);
  const slash = named.lastIndexOf("/");
  const colon = named.lastIndexOf(":");
  const repository = colon > slash ? named.slice(0, colon) : named;
  const tag = colon > slash ? named.slice(colon + 1) : null;
  // Pinned by digest alone: the version cannot be read.
  if (tag === null && digest >= 0) return null;
  const name = repository.slice(repository.lastIndexOf("/") + 1).toLowerCase();
  if (name.includes(UNRESOLVED) || name === "") return null;
  const tagText = (tag ?? "").toLowerCase();
  const api = apiOfTag(tagText);

  if (Object.hasOwn(PHP_IMAGES, name)) {
    const leading = LEADING_VERSION.exec(tagText);
    const version = leading?.[1] === undefined ? null : parseVersion(leading[1]);
    return {
      version,
      ...(version === null ? { hidden: tagText.includes(UNRESOLVED) ? "variable" : "tag" } : {}),
      api: api ?? PHP_IMAGES[name] ?? "cli",
    };
  }
  const embedded = TAG_VERSION.exec(tagText);
  if (embedded?.[1] !== undefined) {
    const version = parseVersion(embedded[1]);
    if (version !== null) return { version, api: api ?? "web" };
  }
  if (PHP_APPLICATIONS.has(name))
    return { version: null, hidden: "application", api: api ?? "web" };
  return null;
}

/**
 * `8`, `8.3`, `8.3.35`, or two digits without a dot as a branch (`83` is 8.3), as
 * package and tag names write it.
 */
export function parseVersion(text: string): RuntimeVersion | null {
  const parts = /^\d{2}$/.test(text) ? [text[0], text[1]] : text.split(".");
  const [major, minor, patch] = parts.map(Number);
  if (major === undefined || Number.isNaN(major) || parts.length > 3) return null;
  return {
    major,
    ...(minor === undefined ? {} : { minor }),
    ...(patch === undefined ? {} : { patch }),
  };
}

/** The server API a tag's variant names: `8.3-apache`, `fpm-alpine`, `cli`. */
function apiOfTag(tag: string): ServerApi | null {
  const words = new Set(tag.split(/[-_]/));
  if (words.has("apache") || words.has("apache2")) return "apache";
  if (words.has("fpm")) return "fpm";
  if (words.has("cli") || words.has("zts")) return "cli";
  return null;
}
