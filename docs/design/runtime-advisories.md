# Runtime advisories (design)

Status: implemented for PHP2Shell. What works is recorded in
[../STATUS.md](../STATUS.md).

## Why

Some critical vulnerabilities are in the interpreter, not in the project's
code. PHP2Shell (CVE-2026-109618 and CVE-2026-109619, published 2026-10-21) is
a use-after-free in PHP's `session.upload_progress` handling that allows
unauthenticated remote code execution. It is fixed in 8.5.12, 8.4.27, 8.3.36
and 8.2.35. Branches 8.1 and older are end of life and get no fix from
php.net.

Whether a deployment is affected depends on the PHP version and configuration
that actually run. Tools such as
[php2shell-scanner](https://github.com/aancw/php2shell-scanner) check a live
server over HTTP or SSH. Plenger reads a repository and never contacts a
server. What it can read is the runtime the repository declares: the base
image of a container build, an image in a Compose file or Kubernetes manifest,
the distribution packages a build installs, and the PHP configuration it ships.
A deterministic check of those declarations stops a vulnerable image before it
is built, and the GitHub Action can gate on it. It complements a live scanner;
it does not replace one.

The check is deterministic. Model guidance on frameworks lowered precision in
M10, and a model does not know an advisory published after its training.

## What is read

The scan always lists these files, also when it lists no text files for the
AI review, under the same walker rules (`.gitignore`, excluded directories,
size limit). It reads them only; nothing runs.

| File | What is read |
| --- | --- |
| `Dockerfile`, `Containerfile`, `Dockerfile.*`, `*.dockerfile` | `FROM` images with `ARG` defaults substituted, build stages, `COPY --from`, package installs in `RUN`, PHP settings written by any instruction |
| Compose files (`compose.yaml`, `docker-compose.*.yml` and similar) | `image:` with `${VAR:-default}` substituted |
| Other YAML with top-level `apiVersion:` and `kind:` | `image:` of Kubernetes manifests |
| `composer.json` | `config.platform.php` |
| `*.ini`, `.user.ini`, `*.conf`, `.htaccess` | `session.upload_progress.enabled` in php.ini syntax, FPM pools, Apache and nginx directives |
| `*.php`, `*.phtml` | `ini_set()` and `ini_alter()` of that setting |

An image is a PHP image when its name is `php`, `php-fpm`, `php-apache` or
`php-nginx` (official and common third-party images), when its tag names a
PHP version (`wordpress:6.6-php8.2-apache`, `frankenphp:1-php8.3`), or when it
is a known application image built on PHP (WordPress, Drupal, Joomla,
Nextcloud, MediaWiki, Matomo, phpMyAdmin). The tag decides the server API:
`apache` is mod_php, `fpm` is PHP-FPM, `cli` and `zts` and the bare official
tags are the CLI.

A build stage that only other stages copy from does not ship, so its image is
not reported. A stage ships when it is the last one, when nothing copies from
it (a `--target`), or when a shipping stage builds on it.

## Rules

| Rule | Severity | Reported for |
| --- | --- | --- |
| PLG001 `runtime-known-vulnerable` | critical | An image pinned to a release below the fix of its branch, or naming an end-of-life branch. `composer.json` naming an end-of-life platform is reported at high severity and low confidence, and only when no image or package declares PHP |
| PLG002 `runtime-unpinned-version` | medium | A floating tag of a supported branch (`php:8.3-apache`, `php:8`, `php:latest`), an application image whose tag hides the PHP version, a version from a build argument or variable without a default, and PHP from distribution packages. These have the fix only if the image was built after the fix shipped |
| PLG003 `runtime-setting-too-late` | medium | `session.upload_progress.enabled` turned off by `ini_set()` or in `.user.ini`. The setting is `PHP_INI_PERDIR`, so `ini_set()` cannot change it, and the PHP2Shell guidance warns that `.user.ini` applies too late. Low when the repository also turns it off where it takes effect |

An image whose server API is the CLI is rated one step lower: it is affected
only when it serves HTTP, for example with `php -S`. A web server API marks
the finding as exposed. Distribution packages are never PLG001, because
distributions backport fixes without changing the upstream version.

Every PLG001 and PLG002 finding names the advisory, its CVEs and the fix of
the branch. It notes where the repository turns `session.upload_progress.enabled`
off before the request is parsed (php.ini, `conf.d`, an FPM pool,
`php_admin_value`, `.htaccess` or a Dockerfile instruction), because that
setting closes the known session paths but not every variant. The severity
stays, since the patch is still needed.

## Where it lives

- `src/source/languages.ts` classifies the platform files; `src/source/files.ts`
  lists them.
- `src/platform/` reads them into declarations: images, packages, platform
  versions and settings. It depends only on `source` and `shared`.
- `src/platform/advisories.ts` holds the advisory table: CVEs, publication
  date, the fixed release per branch and the mitigating setting. A later
  runtime advisory is a new row and, for another runtime, a new image list.
- `src/rules/checks/runtimes.ts` turns declarations into findings.

## Not covered

- The version a server actually runs. Use a live scanner for deployed hosts.
- Managed runtimes whose patch level the provider sets (App Engine,
  Platform.sh, Heroku buildpacks).
- CI definitions (`setup-php`, CI images) and local tool files
  (`.php-version`, `.tool-versions`): they run tests, not requests.
- Build arguments that Compose passes to a Dockerfile, Helm values and images
  pinned only by digest.
- Application code that includes a session file, which turns the content
  injection into code execution. That is a file inclusion finding for the AI
  review.
