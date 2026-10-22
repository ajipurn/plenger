import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exposure, PHP2SHELL } from "../src/platform/advisories.ts";
import { phpImage } from "../src/platform/images.ts";
import type { Finding } from "../src/rules/index.ts";
import { scan } from "../src/scan.ts";
import { collectSourceFiles } from "../src/source/files.ts";
import { platformKindOf } from "../src/source/languages.ts";
import { temporaryDir } from "./support/tmp.ts";

async function project(files: Record<string, string>): Promise<string> {
  const root = await temporaryDir("plenger-runtimes-");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

/** `rule severity/confidence path:line` for each finding, most urgent first. */
async function found(files: Record<string, string>): Promise<string[]> {
  return (await scan(await project(files))).findings.map(line);
}

const line = (finding: Finding) =>
  `${finding.rule} ${finding.severity}/${finding.confidence} ${finding.location.path}:${finding.location.line}`;

describe("PHP2Shell exposure of a version", () => {
  it.each([
    ["8.3.35", "vulnerable"],
    ["8.3.36", "unaffected"],
    ["8.2.34", "vulnerable"],
    ["8.4.26", "vulnerable"],
    ["8.5.11", "vulnerable"],
    ["8.5.12", "unaffected"],
    ["8.1.31", "end_of_life"],
    ["8.1", "end_of_life"],
    ["7", "end_of_life"],
    ["8.3", "floating"],
    ["8", "floating"],
    ["8.6", "unaffected"],
    ["9", "unaffected"],
  ])("%s is %s", (text, kind) => {
    const [major, minor, patch] = text.split(".").map(Number);
    const version = {
      major: major as number,
      ...(minor === undefined ? {} : { minor }),
      ...(patch === undefined ? {} : { patch }),
    };
    expect(exposure(PHP2SHELL, version).kind).toBe(kind);
  });
});

describe("PHP images", () => {
  it.each([
    ["php:8.3.35-apache", { version: { major: 8, minor: 3, patch: 35 }, api: "apache" }],
    ["php:8.3-fpm-alpine3.20", { version: { major: 8, minor: 3 }, api: "fpm" }],
    [
      "docker.io/library/php:8.2.34-zts",
      { version: { major: 8, minor: 2, patch: 34 }, api: "cli" },
    ],
    ["php", { version: null, hidden: "tag", api: "cli" }],
    ["php:apache", { version: null, hidden: "tag", api: "apache" }],
    ["bitnami/php-fpm:8.2.20", { version: { major: 8, minor: 2, patch: 20 }, api: "fpm" }],
    ["wordpress:6.6.2-php8.1-apache", { version: { major: 8, minor: 1 }, api: "apache" }],
    ["dunglas/frankenphp:1-php8.3.12", { version: { major: 8, minor: 3, patch: 12 }, api: "web" }],
    ["ghcr.io/acme/app:2.4-php83", { version: { major: 8, minor: 3 }, api: "web" }],
    ["wordpress:cli", { version: null, hidden: "application", api: "cli" }],
    ["drupal:10-fpm", { version: null, hidden: "application", api: "fpm" }],
  ])("reads %s", (reference, expected) => {
    expect(phpImage(reference)).toEqual(expected);
  });

  it.each(["nginx:1.27", "composer:2", "php@sha256:0123abcd", "mariadb:11", "acme/phpunit:10"])(
    "leaves %s alone",
    (reference) => {
      expect(phpImage(reference)).toBeNull();
    },
  );
});

describe("runtime findings", () => {
  it("rate pinned, end-of-life, floating and fixed images", async () => {
    expect(
      await found({
        Dockerfile: "FROM php:8.3.35-apache\n",
        "eol.Dockerfile": "FROM php:7.4-fpm\n",
        "floating.Dockerfile": "FROM php:8.3-fpm\n",
        "fixed.Dockerfile": "FROM php:8.3.36-apache\n",
        "next.Dockerfile": "FROM php:8.6.0-fpm\n",
        "worker.Dockerfile": "FROM php:8.3.35-cli\n",
      }),
    ).toEqual([
      "PLG001 critical/high Dockerfile:1",
      "PLG001 critical/high eol.Dockerfile:1",
      "PLG001 high/high worker.Dockerfile:1",
      "PLG002 medium/medium floating.Dockerfile:1",
    ]);
  });

  it("name the advisory, the fix and the server API", async () => {
    const [finding] = (await scan(await project({ Dockerfile: "FROM php:8.3.35-apache\n" })))
      .findings;
    expect(finding).toMatchObject({
      rule: "PLG001",
      title: "Image `php:8.3.35-apache` ships PHP 8.3.35, which PHP2Shell affects",
      exposed: true,
      subject: { kind: "runtime", name: "php:8.3.35-apache" },
      snippet: "FROM php:8.3.35-apache",
      location: { path: "Dockerfile", line: 1, column: 6, endColumn: 23 },
    });
    expect(finding?.notes).toEqual([
      "PHP2Shell (CVE-2026-109618, CVE-2026-109619, published 2026-10-21) is fixed in 8.3.36.",
      "The image serves PHP through Apache with mod_php.",
      "No configuration in the repository turns `session.upload_progress.enabled` off before a request is parsed; PHP turns it on by default.",
    ]);
  });

  it("fill in build arguments and report a version without a default", async () => {
    const findings = (
      await scan(
        await project({
          Dockerfile: `ARG PHP_VERSION=8.2.34\nARG VARIANT\nFROM php:\${PHP_VERSION}-fpm\n`,
          "variable.Dockerfile": `ARG PHP_TAG\nFROM php:\${PHP_TAG}-apache\n`,
        }),
      )
    ).findings;
    expect(findings.map((finding) => finding.title)).toEqual([
      "Image `php:8.2.34-fpm` ships PHP 8.2.34, which PHP2Shell affects",
      `Image \`php:\${PHP_TAG}-apache\` takes its PHP version from a variable without a default`,
    ]);
    expect(findings[0]?.location).toMatchObject({ line: 3, column: 6 });
  });

  it("leave out stages that only other stages copy from", async () => {
    const dockerfile = `FROM php:8.1-cli AS vendor
RUN echo vendor
FROM php:8.2.34-cli AS base
FROM base AS assets
FROM nginx:1.27
COPY --from=vendor /app /app
COPY --from=assets /dist /usr/share/nginx/html
`;
    expect(await found({ Dockerfile: dockerfile })).toEqual([]);
  });

  it("report a stage that the shipping stage builds on, and a --target stage", async () => {
    const dockerfile = `FROM php:8.3.35-fpm AS base
FROM base AS production
RUN echo production
FROM php:8.2.34-apache AS debug
FROM base AS test
`;
    expect(await found({ Dockerfile: dockerfile })).toEqual([
      "PLG001 critical/high Dockerfile:1",
      "PLG001 critical/high Dockerfile:4",
    ]);
  });

  it("read images in Compose files and Kubernetes manifests, not in CI definitions", async () => {
    expect(
      await found({
        "docker-compose.prod.yml": `services:\n  web:\n    image: "php:\${TAG:-8.2.30-apache}"\n`,
        "k8s/deploy.yaml":
          "apiVersion: apps/v1\nkind: Deployment\nspec:\n  containers:\n    - image: php:8.0-fpm\n",
        ".gitlab-ci.yml": "image: php:7.4\n",
        ".github/workflows/test.yml": "jobs:\n  test:\n    container:\n      image: php:7.4\n",
        "helm/values.yaml": "image:\n  repository: php\n  tag: 7.4\n",
      }),
    ).toEqual([
      "PLG001 critical/high docker-compose.prod.yml:3",
      "PLG001 critical/high k8s/deploy.yaml:5",
    ]);
  });

  it("report PHP from distribution packages as decided at build time", async () => {
    const findings = (
      await scan(
        await project({
          "debian.Dockerfile":
            "FROM debian:bookworm\nRUN apt-get update && apt-get install -y nginx php8.2-fpm php8.2-mysql\n",
          "alpine.Dockerfile": "FROM alpine:3.20\nRUN apk add --no-cache php83 php83-ctype\n",
          "eol.Dockerfile":
            "FROM ubuntu:22.04\nRUN apt-get install -y php8.1 libapache2-mod-php8.1\n",
          "extension.Dockerfile": "FROM php:8.3.36-fpm\nRUN apt-get install -y php-redis\n",
          "tools.Dockerfile": "FROM debian:bookworm\nRUN apt-get install -y phpunit composer\n",
        }),
      )
    ).findings;
    expect(findings.map(line)).toEqual([
      "PLG002 medium/medium debian.Dockerfile:2",
      "PLG002 medium/medium eol.Dockerfile:2",
      "PLG002 low/medium alpine.Dockerfile:2",
    ]);
    expect(findings[0]?.title).toBe(
      "`apt-get` installs PHP (`php8.2-fpm`) at the distribution's patch level",
    );
    expect(findings[1]?.notes).toContain(
      "PHP 8.1 is end of life upstream; only the distribution's own backport fixes it.",
    );
  });

  it("report an end-of-life composer platform only when nothing ships PHP", async () => {
    const composer = '{"config": {"platform": {"php": "7.4.33"}}}\n';
    const alone = (await scan(await project({ "composer.json": composer }))).findings;
    expect(alone.map(line)).toEqual(["PLG001 high/low composer.json:1"]);
    expect(alone[0]?.location.column).toBe(26);
    expect(
      await found({ "composer.json": composer, Dockerfile: "FROM php:8.3.36-apache\n" }),
    ).toEqual([]);
    expect(await found({ "composer.json": '{"config": {"platform": {"php": "8.2.0"}}}' })).toEqual(
      [],
    );
  });

  it("report mitigations set where they do not take effect", async () => {
    const files = {
      "public/index.php": `<?php
ini_set("session.upload_progress.enabled", 0);
// ini_set('session.upload_progress.enabled', '0');
ini_set('session.upload_progress.enabled', $value);
ini_set('session.upload_progress.enabled', '1');
`,
      "public/admin.php": `<?php
/* ini_set('session.upload_progress.enabled', '0'); */
INI_ALTER(value: 'off', option: 'session.upload_progress.enabled');
`,
      "public/.user.ini": "session.upload_progress.enabled = Off\n",
    };
    expect(await found(files)).toEqual([
      "PLG003 medium/high public/.user.ini:1",
      "PLG003 medium/high public/admin.php:3",
      "PLG003 medium/high public/index.php:2",
    ]);
    const mitigated = await found({
      ...files,
      "docker/www.conf": "[www]\nphp_admin_flag[session.upload_progress.enabled] = off\n",
    });
    expect(mitigated).toEqual([
      "PLG003 low/high public/.user.ini:1",
      "PLG003 low/high public/admin.php:3",
      "PLG003 low/high public/index.php:2",
    ]);
  });

  it.each([
    ["php.ini", "session.upload_progress.enabled = 0\n"],
    ["conf.d/zz.ini", 'session.upload_progress.enabled="Off"\n'],
    ["www.conf", "php_admin_value[session.upload_progress.enabled] = 0\n"],
    [".htaccess", "php_flag session.upload_progress.enabled off\n"],
    ["nginx/site.conf", 'fastcgi_param PHP_VALUE "session.upload_progress.enabled=0";\n'],
    [
      "mitigation.Dockerfile",
      "FROM debian\nRUN echo 'session.upload_progress.enabled=0' > /etc/php/8.2/fpm/conf.d/x.ini\n",
    ],
  ])("note the mitigation in %s on the runtime finding", async (path, content) => {
    const root = await project({ Dockerfile: "FROM php:8.3.35-fpm\n", [path]: content });
    const [finding] = (await scan(root)).findings;
    expect(finding?.rule).toBe("PLG001");
    expect(finding?.notes.at(-1)).toMatch(
      new RegExp(
        `^\`session\\.upload_progress\\.enabled\` is turned off in ${path.replace(".", "\\.")}:`,
      ),
    );
  });

  it("ignore a mitigation in a comment", async () => {
    const root = await project({
      Dockerfile: "FROM php:8.3.35-fpm\n",
      "php.ini": "; session.upload_progress.enabled = 0\n",
    });
    const [finding] = (await scan(root)).findings;
    expect(finding?.notes.at(-1)).toMatch(/^No configuration in the repository/);
  });

  it("keep their fingerprints when lines move and honour plenger-ignore", async () => {
    const before = (await scan(await project({ Dockerfile: "FROM php:8.3.35-apache\n" }))).findings;
    const after = (
      await scan(await project({ Dockerfile: "# Web image.\n\nFROM php:8.3.35-apache\n" }))
    ).findings;
    expect(after.map((finding) => finding.fingerprint)).toEqual(
      before.map((finding) => finding.fingerprint),
    );
    const ignored = (
      await scan(
        await project({
          Dockerfile:
            "# plenger-ignore PLG001 patched by the base image vendor\nFROM php:8.3.35-apache\n",
        }),
      )
    ).findings;
    expect(ignored[0]?.inline).toEqual({ line: 1, reason: "patched by the base image vendor" });
  });
});

describe("platform files", () => {
  it.each([
    ["Dockerfile", "dockerfile"],
    ["docker/Dockerfile.prod", "dockerfile"],
    ["deploy/api.dockerfile", "dockerfile"],
    ["Containerfile", "dockerfile"],
    ["compose.yaml", "compose"],
    ["docker-compose.override.yml", "compose"],
    ["k8s/web.yaml", "yaml"],
    ["composer.json", "composer"],
    ["php.ini", "php-config"],
    ["public/.user.ini", "php-config"],
    ["public/.htaccess", "php-config"],
    ["php-fpm.d/www.conf", "php-config"],
  ])("reads %s as %s", (path, kind) => {
    expect(platformKindOf(path)).toBe(kind);
  });

  // PHP code is parsed, and its `ini_set()` calls are read from its facts.
  it.each(["package.json", "README.md", "app.py", "php.ini-production", "src/index.php"])(
    "leaves %s alone",
    (path) => {
      expect(platformKindOf(path)).toBeNull();
    },
  );

  it("are listed without text files, under the walker's rules", async () => {
    const root = await project({
      Dockerfile: "FROM php:8.3.36-fpm\n",
      "public/.htaccess": "php_flag engine on\n",
      "vendor/acme/Dockerfile": "FROM php:7.4\n",
      "app.py": "print('ok')\n",
    });
    const collected = await collectSourceFiles(root);
    expect(collected.platform.map((file) => file.path)).toEqual(["Dockerfile", "public/.htaccess"]);
    expect(collected.texts).toEqual([]);
  });
});
