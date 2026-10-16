# Install

The primary distribution is an npm package. It contains the CLI, the built
local dashboard, tree-sitter grammars and the managed container recipes.
Users need Node.js 22.18 or newer with npm. They do not need pnpm or a frontend
build. Release availability and platform evidence are in
[../STATUS.md](../STATUS.md).

## npm

For a published release, install globally:

```sh
npm install -g plenger
plenger --version
plenger scan path/to/project
```

npm adds the `plenger` command to its executable directory. The same package
is used on Windows, Linux and macOS. The installation runs no Plenger build
or install scripts.

## npx

For a published release, run a command without a global installation:

```sh
npx plenger@latest --version
npx plenger@latest scan path/to/project
npx plenger@latest serve --port 4180
```

The first invocation downloads the package and its production dependencies.
Once installed, static scans and offline preparation need no network.

## Dashboard

Start the local dashboard from the CLI:

```sh
plenger serve
plenger serve path/to/project --port 4180
plenger serve --workspace path/to/project --port 4180 --data-dir path/to/data
```

Open the printed local URL in your browser. Without `--port`, Plenger chooses
a free port. `--data-dir` selects the local SQLite data folder. Stop the service
with Ctrl+C. See [dashboard.md](dashboard.md) for project selection, providers,
red-team runs and saved data.

## Local tarball

Maintainers can build and verify the npm package before a registry release.
From the repository root:

```sh
pnpm install --ignore-scripts
pnpm test:package
npm install -g ./dist/npm/plenger-0.1.0.tgz
plenger serve --port 4180
```

Use the archive filename printed by the smoke check for the current version.
The archive includes the compiled CLI and built dashboard. It runs outside
the source checkout. See [../../CONTRIBUTING.md](../../CONTRIBUTING.md) and
[../design/distribution.md](../design/distribution.md).

## Update

Stop any running `serve` process, then update a published release:

```sh
npm install -g plenger@latest
```

For a local tarball, install the new archive with `npm install -g <archive>`.
Dashboard data is stored separately from the installed package.

## Container prerequisites

Red-team runs need Docker Desktop or a Docker engine with the Buildx plugin,
reachable through the `docker` CLI, or Podman with a running Linux backend.
Docker is preferred when `docker info` succeeds. Each run builds its own image
from the pinned recipe without a shared build cache, so every build downloads
dependency packages and needs network access. Static scanning needs neither.
See [redteam.md](redteam.md#prerequisites).

The npm package includes all red-team commands and recipes. Containers are
started only by `plenger redteam run` or the dashboard's explicit Start action.
