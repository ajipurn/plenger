# Install and update

Plenger is an npm package containing the local service, dashboard, static
engine and bundled grammar assets. Users need npm and Node.js 22.23.4 or later on
the 22 line, 24.22.1 or later on the 24 line, or 26.12.1 or newer. Earlier patches
have the Brotli flaw CVE-2026-111497, which `fetch` reaches on provider responses.
Release availability is recorded in [../STATUS.md](../STATUS.md).

## npm

For a published release:

```sh
npm install -g plenger
plenger --version
plenger
```

The same package runs on Windows, Linux and macOS. Installation uses prepared
JavaScript and dashboard assets. No frontend build or pnpm installation is needed.

## npx

Run a published release without installing it globally:

```sh
npx plenger@latest
npx plenger@latest --workspace path/to/project --port 4180
```

The first invocation downloads the package and its production dependencies.

## Dashboard

```sh
plenger
plenger --workspace path/to/project --port 4180
plenger --data-dir path/to/data
plenger --help
plenger --version
```

Open the printed local URL in your browser. The workspace defaults to the
current directory. Port 0, the default, chooses a free loopback port.
`--data-dir` selects the SQLite data folder. Stop the service with Ctrl+C.
See [dashboard.md](dashboard.md) for projects, scans and provider settings.

The old scan, facts, rules, assess, serve and redteam commands are removed.
The launcher accepts options directly. Analysis uses the dashboard and its local API.

## Background update checks

Published builds check the npm registry for a stable release after startup.
The check has a three-second timeout and caches successful checks for 24 hours
in the dashboard data folder. Missing releases are cached too. Registry failures
leave the dashboard running. Checks send only a package metadata request.

A newer version prints a notice with `plenger update`. Nothing installs
automatically. Set `NO_UPDATE_NOTIFIER=1` to disable background checks.
Private builds skip registry checks and self-update.

## Update

Stop any running dashboard, then use an interactive terminal:

```sh
plenger update
```

The updater verifies that the running package is the npm global installation.
It fetches fresh release metadata, shows the installed and target versions,
and asks for confirmation. Entering an empty answer or declining cancels.
No non-interactive confirmation bypass is provided.

After confirmation, npm installs that exact version into the existing prefix,
with install scripts disabled and Node.js engine checks enforced. The updater
checks the installed version before reporting success. Start the dashboard
again with `plenger`.

For npx, run `npx plenger@latest` again. Update project-local packages with
their package manager and source checkouts through Git. An npm-linked checkout
is treated as development source. Dashboard data and provider credentials live
outside the installation directory.

## Local tarball

Maintainers can build and verify the package before a registry release:

```sh
pnpm install --ignore-scripts
pnpm test:package
npm install -g ./dist/npm/plenger-<version>.tgz
plenger --port 4180
```

Use the archive filename printed by the smoke check for the current version.
For a private build, install its replacement archive directly with
`npm install -g <archive>`. See [../../CONTRIBUTING.md](../../CONTRIBUTING.md).
