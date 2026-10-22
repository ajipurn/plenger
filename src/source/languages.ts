/** A tree-sitter grammar plenger can load. TSX needs its own grammar. */
export type Grammar = "python" | "javascript" | "typescript" | "tsx";

/** The language a file is reported under. */
export type Language = "python" | "javascript" | "typescript";

/** The detector and fact-extractor family a language belongs to: TypeScript is JavaScript here. */
export type LanguageFamily = "python" | "javascript";

const FAMILY_OF: Record<Language, LanguageFamily> = {
  python: "python",
  javascript: "javascript",
  typescript: "javascript",
};

export function familyOf(language: Language): LanguageFamily {
  return FAMILY_OF[language];
}

/**
 * The value for a language's family. `values` names every family, so a new family is a
 * compile error at each call until that place decides what the family means there. Every
 * value is computed before the call; pass functions when only the chosen one may run.
 */
export function byFamily<T>(language: Language, values: Record<LanguageFamily, T>): T {
  return values[familyOf(language)];
}

export const LANGUAGE_OF: Record<Grammar, Language> = {
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
  tsx: "typescript",
};

const GRAMMAR_BY_EXTENSION: Record<string, Grammar> = {
  ".py": "python",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
};

/**
 * A text file without a parser that the AI review reads as plain text: code in another
 * language or a template, or configuration and infrastructure definitions.
 */
export type TextKind = "code" | "config";

const TEXT_EXTENSIONS: Record<TextKind, string> = {
  code: [
    // Other languages.
    ".go .java .kt .kts .scala .groovy .gradle .rb .php .cs .fs .vb .rs .swift .m .mm .c .h",
    ".cc .cpp .cxx .hpp .ex .exs .erl .clj .cljs .dart .lua .pl .pm .r .jl .hs .ml .zig .sol",
    ".vue .svelte .astro .coffee",
    // Shell and queries.
    ".sh .bash .zsh .ps1 .psm1 .bat .cmd .sql .graphql .gql",
    // Templates.
    ".html .htm .jinja .jinja2 .j2 .njk .erb .ejs .hbs .twig .liquid .pug .mustache .cshtml",
    ".razor .jsp",
  ].join(" "),
  config: [
    ".yaml .yml .toml .ini .cfg .conf .properties .xml .json",
    // Infrastructure, schemas and access rules.
    ".tf .hcl .proto .prisma .rules",
  ].join(" "),
};
const TEXT_KIND_BY_EXTENSION = new Map(
  (Object.entries(TEXT_EXTENSIONS) as [TextKind, string][]).flatMap(([kind, list]) =>
    list.split(" ").map((extension) => [extension, kind] as const),
  ),
);
const TEXT_KIND_BY_NAME: Record<string, TextKind> = {
  dockerfile: "config",
  containerfile: "config",
  caddyfile: "config",
  procfile: "config",
  makefile: "code",
  jenkinsfile: "code",
  vagrantfile: "code",
  rakefile: "code",
  gemfile: "code",
};
/** Dependency lockfiles: resolved versions, not reviewable code. */
const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "packages.lock.json",
  "composer.lock",
]);

/** How the AI review reads a file the parser does not handle, or null when it does not. */
export function textKindOf(path: string): TextKind | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (LOCKFILES.has(name) || /[.-]min\.|\.pb\.go$|[._]generated\./.test(name)) return null;
  const named = TEXT_KIND_BY_NAME[name];
  if (named !== undefined) return named;
  if (/^(?:dockerfile|containerfile)\.|\.dockerfile$/.test(name)) return "config";
  const dot = name.lastIndexOf(".");
  return (dot > 0 && TEXT_KIND_BY_EXTENSION.get(name.slice(dot))) || null;
}

/**
 * A file that declares the runtime a project deploys on: a container build, a Compose
 * file, another YAML file that may be a Kubernetes manifest, `composer.json`, PHP
 * configuration or PHP code that changes it.
 */
export type PlatformKind = "dockerfile" | "compose" | "yaml" | "composer" | "php-config" | "php";

const PLATFORM_KIND_BY_EXTENSION: Record<string, PlatformKind> = {
  ".yml": "yaml",
  ".yaml": "yaml",
  ".ini": "php-config",
  ".conf": "php-config",
  ".htaccess": "php-config",
  ".php": "php",
  ".phtml": "php",
};

/** Which runtime declarations a file may hold, or null when it holds none plenger reads. */
export function platformKindOf(path: string): PlatformKind | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (/^(?:dockerfile|containerfile)(?:\..+)?$|\.dockerfile$/.test(name)) return "dockerfile";
  if (/^(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/.test(name)) return "compose";
  if (name === "composer.json") return "composer";
  const dot = name.lastIndexOf(".");
  return (dot >= 0 && PLATFORM_KIND_BY_EXTENSION[name.slice(dot)]) || null;
}

/** A compiled or packaged file the scan lists but cannot read. */
export type BinaryKind =
  | "native library"
  | "executable"
  | "WebAssembly"
  | "JVM bytecode"
  | "Python package";

const BINARY_EXTENSIONS: Record<BinaryKind, string> = {
  "native library": ".so .dylib .dll .pyd .node .a .lib .o",
  executable: ".exe .bin .elf .appimage",
  WebAssembly: ".wasm",
  "JVM bytecode": ".jar .war .class",
  "Python package": ".whl .egg",
};
const BINARY_KIND_BY_EXTENSION = new Map(
  (Object.entries(BINARY_EXTENSIONS) as [BinaryKind, string][]).flatMap(([kind, list]) =>
    list.split(" ").map((extension) => [extension, kind] as const),
  ),
);

/** What kind of binary a file name names (`libssl.so.3` included), or null. */
export function binaryKindOf(path: string): BinaryKind | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (/\.so(?:\.\d+)+$/.test(name)) return "native library";
  const dot = name.lastIndexOf(".");
  return (dot > 0 && BINARY_KIND_BY_EXTENSION.get(name.slice(dot))) || null;
}

/** Source files plenger recognises but does not analyse, and why. */
export type IgnoredSourceReason = "declaration" | "minified";

type Classification =
  | { kind: "source"; grammar: Grammar }
  | { kind: "ignored"; reason: IgnoredSourceReason }
  | { kind: "other" };

export function classifyPath(path: string): Classification {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const grammar = dot > 0 ? GRAMMAR_BY_EXTENSION[name.slice(dot)] : undefined;
  if (grammar === undefined) return { kind: "other" };
  if (/\.d\.[mc]?ts$/.test(name)) return { kind: "ignored", reason: "declaration" };
  if (/[.-]min\.[mc]?js$/.test(name)) return { kind: "ignored", reason: "minified" };
  return { kind: "source", grammar };
}
