import { parseVersion, phpImage, UNRESOLVED } from "./images.ts";
import type { PlatformLocation, RuntimeDeclaration, RuntimeSetting, ServerApi } from "./model.ts";
import { directives } from "./settings.ts";

/** One instruction, its continuation lines joined. */
interface Instruction {
  keyword: string;
  args: string;
  /** 1-based line where the instruction starts, and that line as written. */
  line: number;
  raw: string;
  /** Every line of the instruction as written, from `line` on. */
  lines: string[];
}

interface Stage {
  name: string | null;
  /** The earlier stage this one builds on, by index. */
  base: number | null;
  /** The image reference as written and with arguments filled in. */
  written: string;
  reference: string;
  line: number;
  raw: string;
  packages: RuntimeDeclaration[];
}

/** A package manager command that installs packages, up to the end of its command. */
const INSTALL =
  /\b(apt-get|apt|apk|dnf|microdnf|yum|zypper)\s+(?:[^&|;]*?\s)?(?:install|add|in)\s+([^&|;]*)/g;
/** A PHP package: `php`, `php-fpm`, `php8.2-cli`, `php83`, `libapache2-mod-php8.2`. */
const PHP_PACKAGE = /^(?:libapache2-mod-)?php(\d+(?:\.\d+)?)?(?:-[a-z0-9][\w.+-]*)?(?:[=~<>].*)?$/;

/**
 * The PHP images, PHP packages and settings a Dockerfile declares. Images of stages that
 * only other stages copy from are left out, as they do not ship.
 */
export function readDockerfile(
  path: string,
  text: string,
): { declarations: RuntimeDeclaration[]; settings: RuntimeSetting[] } {
  const globals = new Map<string, string | undefined>();
  const stages: Stage[] = [];
  const copied = new Set<string>();
  const settings: RuntimeSetting[] = [];
  let variables = new Map<string, string | undefined>();

  for (const instruction of instructions(text)) {
    const { keyword, args } = instruction;
    const stage = stages.at(-1);
    settings.push(...directives(args, { path, line: instruction.line }, "startup"));
    if (keyword === "ARG" || keyword === "ENV") {
      for (const [name, value] of assignments(args, keyword)) {
        if (stage === undefined) globals.set(name, value);
        else variables.set(name, value ?? (keyword === "ARG" ? globals.get(name) : undefined));
      }
    } else if (keyword === "FROM") {
      const words = args.split(/\s+/).filter((word) => !word.startsWith("--"));
      const written = words[0] ?? "";
      const reference = substitute(written, globals);
      const alias = words[1]?.toLowerCase() === "as" ? (words[2] ?? null) : null;
      const base = stages.findIndex((item) => item.name?.toLowerCase() === reference.toLowerCase());
      stages.push({
        name: alias,
        base: base >= 0 ? base : null,
        written,
        reference,
        line: instruction.line,
        raw: instruction.raw,
        packages: [],
      });
      variables = new Map();
    } else if (stage !== undefined) {
      for (const match of args.matchAll(/--(?:from|mount=[^\s]*\bfrom)=([^\s,]+)/g))
        if (match[1] !== undefined) copied.add(match[1].toLowerCase());
      if (keyword === "RUN") {
        const packages = installedPackages(substitute(args, variables), path, instruction);
        if (packages !== null) stage.packages.push(packages);
      }
    }
  }

  const ships = shippingStages(stages, copied);
  const declarations: RuntimeDeclaration[] = [];
  stages.forEach((stage, index) => {
    if (!ships[index]) return;
    if (stage.base === null) {
      const image = phpImage(stage.reference);
      if (image !== null) {
        declarations.push({
          kind: "image",
          runtime: "php",
          // A variable without a value is shown as written.
          reference: stage.reference.includes(UNRESOLVED) ? stage.written : stage.reference,
          ...image,
          location: locate(path, stage.line, stage.raw, stage.written),
          source: "dockerfile",
        });
        return;
      }
    }
    // Packages in a stage built on a PHP image add extensions, not another PHP.
    if (!buildsOnPhp(stages, index)) declarations.push(...stage.packages);
  });
  return { declarations, settings };
}

/**
 * Whether each stage ships: the last stage, a stage nothing builds on or copies from (a
 * `--target`), or a stage a shipping stage builds on.
 */
function shippingStages(stages: Stage[], copied: Set<string>): boolean[] {
  const ships = stages.map(() => false);
  for (let index = stages.length - 1; index >= 0; index--) {
    const stage = stages[index] as Stage;
    const children = stages.flatMap((item, child) => (item.base === index ? [child] : []));
    const copiedFrom =
      copied.has(String(index)) || (stage.name !== null && copied.has(stage.name.toLowerCase()));
    ships[index] =
      index === stages.length - 1 ||
      (children.length > 0 ? children.some((child) => ships[child]) : !copiedFrom);
  }
  return ships;
}

function buildsOnPhp(stages: Stage[], index: number): boolean {
  const stage = stages[index];
  if (stage === undefined) return false;
  if (stage.base !== null) return buildsOnPhp(stages, stage.base);
  return phpImage(stage.reference) !== null;
}

/** The first PHP package an install command in `args` names, or null. */
function installedPackages(
  args: string,
  path: string,
  instruction: Instruction,
): RuntimeDeclaration | null {
  for (const match of args.matchAll(INSTALL)) {
    const manager = match[1] ?? "";
    const names = (match[2] ?? "")
      .split(/\s+/)
      .filter((word) => word !== "" && !word.startsWith("-"))
      .map((word) => word.replace(/^["']|["']$/g, "").replaceAll(UNRESOLVED, ""));
    const php = names.filter((name) => PHP_PACKAGE.test(name));
    const first = php[0];
    if (first === undefined) continue;
    const branch = php.map((name) => PHP_PACKAGE.exec(name)?.[1]).find((item) => item);
    return {
      kind: "packages",
      runtime: "php",
      manager,
      package: first.replace(/[=~<>].*$/, ""),
      version: branch === undefined ? null : parseVersion(branch),
      api: packagesApi(php, manager),
      location: locateWord(path, instruction, first),
    };
  }
  return null;
}

/**
 * The server API the packages install. A bare `php` or `php8.2` is a metapackage that
 * brings a web server API, except on Alpine, where it is the CLI; anything else without
 * a server package (the CLI, extensions) serves no requests.
 */
function packagesApi(names: string[], manager: string): ServerApi {
  if (names.some((name) => /^libapache2-mod-php|-apache2?\b/.test(name))) return "apache";
  if (names.some((name) => /-fpm\b/.test(name))) return "fpm";
  const bare = names.some((name) => /^php[\d.]*(?:[=~<>].*)?$/.test(name));
  return bare && manager !== "apk" ? "web" : "cli";
}

/** `ARG A=1 B`, `ENV A=1`, and the older `ENV A 1`. */
function assignments(args: string, keyword: string): [string, string | undefined][] {
  const legacy = /^([A-Za-z_]\w*)\s+([^=\s].*)$/.exec(args.trim());
  if (keyword === "ENV" && legacy !== null && !args.includes("="))
    return [[legacy[1] as string, unquote(legacy[2] as string)]];
  const found: [string, string | undefined][] = [];
  for (const match of args.matchAll(/([A-Za-z_]\w*)(?:=("[^"]*"|'[^']*'|\S*))?/g))
    found.push([match[1] as string, match[2] === undefined ? undefined : unquote(match[2])]);
  return found;
}

/** `$NAME`, `${NAME}`, `${NAME:-default}` and `${NAME-default}`; unknown names become `UNRESOLVED`. */
export function substitute(text: string, values: Map<string, string | undefined>): string {
  return text.replace(
    /\$\{([A-Za-z_]\w*)(?::?-([^}]*))?\}|\$([A-Za-z_]\w*)/g,
    (
      _whole,
      braced: string | undefined,
      fallback: string | undefined,
      bare: string | undefined,
    ) => {
      const value = values.get(braced ?? bare ?? "");
      if (value !== undefined && value !== "") return value;
      return fallback ?? UNRESOLVED;
    },
  );
}

/** The instructions of a Dockerfile, with comments left out and continuations joined. */
function instructions(text: string): Instruction[] {
  const lines = text.split(/\r?\n/);
  let escapeChar = "\\";
  // Parser directives come first: `# escape=\``.
  for (const line of lines) {
    const directive = /^#\s*(\w+)\s*=\s*(\S+)\s*$/.exec(line);
    if (directive === null) break;
    if (directive[1]?.toLowerCase() === "escape") escapeChar = directive[2] ?? escapeChar;
  }
  const found: Instruction[] = [];
  let current: { line: number; raw: string; text: string; last: number } | null = null;
  let heredocs: string[] = [];
  lines.forEach((raw, index) => {
    if (current !== null && heredocs.length > 0) {
      current.text += `\n${raw}`;
      current.last = index;
      if (raw.trim() === heredocs[0]) heredocs.shift();
      if (heredocs.length === 0) finish();
      return;
    }
    // Comment and empty lines are left out, also inside a continuation.
    if (/^\s*#/.test(raw) || raw.trim() === "") return;
    const trimmed = raw.trimEnd();
    const continued = trimmed.endsWith(escapeChar);
    const body = continued ? trimmed.slice(0, -escapeChar.length) : raw;
    if (current === null) current = { line: index + 1, raw, text: body, last: index };
    else {
      current.text += ` ${body}`;
      current.last = index;
    }
    if (continued) return;
    heredocs = [...current.text.matchAll(/<<-?\s*(["']?)([A-Za-z_]\w*)\1/g)].map(
      (match) => match[2] as string,
    );
    if (heredocs.length === 0) finish();
  });
  if (current !== null) finish();
  return found;

  function finish(): void {
    if (current === null) return;
    const match = /^\s*(\S+)\s*([\s\S]*)$/.exec(current.text);
    if (match !== null)
      found.push({
        keyword: (match[1] as string).toUpperCase(),
        args: (match[2] as string).trim(),
        line: current.line,
        raw: current.raw,
        lines: lines.slice(current.line - 1, current.last + 1),
      });
    current = null;
    heredocs = [];
  }
}

function unquote(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

/** A PHP package word as written, with any variables in it: `php${PHP_VERSION}-cli`. */
const WRITTEN_PACKAGE = /(?<=^|\s)(?:libapache2-mod-)?php[\w.${}-]*/;

/**
 * Where a package appears in an instruction that may span lines: its name as filled in,
 * else the first PHP package word as written, else the first line.
 */
function locateWord(path: string, instruction: Instruction, filled: string): PlatformLocation {
  const found = (match: (raw: string) => string | undefined): PlatformLocation | null => {
    for (const [offset, raw] of instruction.lines.entries()) {
      const word = match(raw);
      if (word === undefined) continue;
      return locate(path, instruction.line + offset, raw, word);
    }
    return null;
  };
  return (
    found((raw) => (raw.includes(filled) ? filled : undefined)) ??
    found((raw) => WRITTEN_PACKAGE.exec(raw)?.[0]) ??
    locate(path, instruction.line, instruction.raw, "")
  );
}

/** Where `written` appears on the instruction's first line, or the whole line. */
export function locate(path: string, line: number, raw: string, written: string): PlatformLocation {
  const at = written === "" ? -1 : raw.indexOf(written);
  const column = at >= 0 ? at + 1 : 1;
  const end = at >= 0 ? column + written.length : raw.trimEnd().length + 1;
  return { path, line, column, endLine: line, endColumn: end };
}
