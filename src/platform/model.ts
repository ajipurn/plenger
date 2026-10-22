/** Where a declaration is written: a file and a span in it, 1-based. */
export interface PlatformLocation {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** A runtime version as far as a declaration states it. */
export interface RuntimeVersion {
  major: number;
  minor?: number;
  patch?: number;
}

/**
 * How the runtime serves requests: `apache` is mod_php, `fpm` is PHP-FPM, `cli` serves
 * none unless it runs a server itself, `web` serves them through something unnamed.
 */
export type ServerApi = "apache" | "fpm" | "cli" | "web";

/** A container image that ships a runtime. */
export interface RuntimeImage {
  kind: "image";
  runtime: "php";
  /** The image reference as written, after build arguments and variables are filled in. */
  reference: string;
  /** Null when the reference does not show the version: a floating tag or a hidden one. */
  version: RuntimeVersion | null;
  /** Why the version is not shown, when it is not. */
  hidden?: "tag" | "variable" | "application";
  api: ServerApi;
  location: PlatformLocation;
  /** Where the image is declared. */
  source: "dockerfile" | "compose" | "manifest";
}

/** Runtime packages that a container build installs from a distribution. */
export interface RuntimePackages {
  kind: "packages";
  runtime: "php";
  /** The package manager, e.g. `apt-get` or `apk`. */
  manager: string;
  /** The first runtime package named. */
  package: string;
  /** The branch the package names (`php8.2-fpm`, `php83`), when it names one. */
  version: RuntimeVersion | null;
  api: ServerApi;
  location: PlatformLocation;
}

/** The runtime version a dependency manager resolves for (`config.platform.php`). */
export interface RuntimePlatform {
  kind: "platform";
  runtime: "php";
  version: RuntimeVersion;
  /** As written. */
  text: string;
  location: PlatformLocation;
}

export type RuntimeDeclaration = RuntimeImage | RuntimePackages | RuntimePlatform;

/**
 * Where a configuration setting is written. `startup` settings apply before a request is
 * parsed: php.ini and `conf.d`, FPM pools, Apache and nginx directives, a build step or a
 * `-d` option. `user_ini` (`.user.ini`) and `ini_set` (`ini_set()`, `ini_alter()`) apply
 * later.
 */
export type SettingScope = "startup" | "user_ini" | "ini_set";

export interface RuntimeSetting {
  runtime: "php";
  name: string;
  /** Whether the value turns the setting on; null when it cannot be read. */
  enabled: boolean | null;
  scope: SettingScope;
  location: PlatformLocation;
}

/** What a repository declares about the runtimes it deploys on. */
export interface Platform {
  declarations: RuntimeDeclaration[];
  settings: RuntimeSetting[];
}
