# Distribution

npm is the primary distribution for the CLI and local dashboard. The user
flow follows [promptfoo's npm installation](https://www.promptfoo.dev/docs/installation/):
install a CLI package or run it with npx, then open the dashboard through a CLI
command. Plenger uses `plenger serve [path]` with `--port`, `--workspace` and
`--data-dir`. User steps are in [../guide/install.md](../guide/install.md).
Release availability and platform evidence are in [../STATUS.md](../STATUS.md).

## npm package contents

The package is named `plenger-cli` because the `plenger` package name and the
`@plenger` scope belong to other npm accounts. `package.json` maps the
`plenger` command to `dist/bin.js`. Node.js 22.18 or newer runs the compiled
JavaScript. npm only warns about `engines`, so `dist/bin.js` checks the Node.js
version before it loads the CLI. The package contains:

- compiled CLI, scan engine, storage, dashboard service and red-team engine
- the built frontend in `dashboard/dist`, including bundled fonts
- the four tree-sitter grammars and their manifest in `grammars`
- the managed container recipes listed in `RUNTIME_FILES`, under `runtimes`
- report and campaign JSON schemas in `schemas`
- the Apache-2.0 `LICENSE` and third-party notices in
  `dist/THIRD_PARTY_NOTICES.txt`

npm installs the three pinned production dependencies. Dashboard dependencies
are bundled into the frontend. TypeScript sources, tests, developer scripts,
source maps and standalone binaries are excluded from the package.

Asset paths resolve relative to the installed package. The command works from
any project directory without the source checkout. `serve` uses the packaged
frontend and keeps its SQLite data outside the installation directory.

The package includes static and red-team commands. Static scans and plans
never import project code, install its dependencies or load `.env` files.
Dynamic runs require Docker or Podman and start only after an explicit action.
`RUNTIME_FILES` remains the recipe list used by the container builder and checked
against the npm archive. Shipping recipes does not execute a project or build
an image during npm installation.

## Build and pack

Maintainers use Node.js and pnpm from
[../../CONTRIBUTING.md](../../CONTRIBUTING.md).

```sh
pnpm build:package
npm pack
```

`build:package` compiles the engine, builds the frontend and generates notices.
`pnpm build` first clears compiled output in `dist/`, keeping `dist/binary` and
`dist/npm`, so files from removed sources never ship.
The `prepack` hook runs this build for `npm pack` and `npm publish`. npm
installation uses the prepared files and runs no Plenger install scripts.
The npm notices include the WASM grammars and dashboard dependency closure.
They omit Node.js because the npm package uses the user's installed runtime.
`private: true` in `package.json` makes `npm publish` refuse while `npm pack`
still works.

## Installed package check

```sh
pnpm test:package
```

`scripts/smoke-package.ts` runs `npm pack` with its build hook and writes
`dist/npm/plenger-cli-<version>.tgz`. It packs the installed production dependency
closure locally and installs all archives into a temporary directory without registry
access. From that directory it checks:

- npm executable resolution, version and command help
- a JSON scan covering Python, JavaScript, TypeScript and TSX
- offline preparation of the managed Next.js fixture
- runtime files that match `RUNTIME_FILES` exactly
- no compiled file in `dist/` without a matching source file
- `serve` with its real HTML, JavaScript, CSS and browser routes
- session issuance, authenticated scanning and shutdown
- packaged third-party notices without a bundled Node.js runtime

The [npm package workflow](../../.github/workflows/package.yml) runs this check
on Ubuntu 24.04, macOS 15 and Windows 2022. It saves the npm archive as an
artifact. Publishing to the registry is a separate maintainer action.

## Optional standalone binary

The standalone build is an additional contributor workflow. It packages the
same CLI and dashboard with Node.js, so users of that archive need no separate
Node.js installation. It is not part of npm installation.

```sh
pnpm build:binary
pnpm test:binary
```

`scripts/build-binary.ts` bundles the CLI with esbuild and creates a Node.js
single executable application with postject. It embeds the frontend, parser
runtime, grammars and recipes. SQLite comes from the bundled Node.js runtime.
The archive also contains third-party notices for that runtime.

Build on the target platform with its matching Node.js executable. Windows
uses `plenger.exe` in a ZIP archive. Linux and macOS use `plenger` in a tarball.
The binary check runs outside the checkout with an empty `PATH` and checks
scans, planning, dashboard assets, saved providers and SQLite persistence.
The [binary workflow](../../.github/workflows/binary.yml) checks native builds
separately. Platform qualifications are tracked in [../STATUS.md](../STATUS.md).
