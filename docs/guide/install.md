# Install

plenger ships as one standalone executable containing the Node.js runtime, the
CLI, the dashboard service with its built frontend, the tree-sitter runtime,
four WASM grammars and the container runtime recipes for the red-team profiles.
End users do not install Node.js, pnpm, parser packages or dashboard
dependencies.

There is no public release download or npm package yet. Maintainers build the
archive from source with `pnpm build:binary`; see
[../design/distribution.md](../design/distribution.md). Platform status is in
[../STATUS.md](../STATUS.md#binary-per-platform).

## Install an archive

Verify the archive against its checksum file, then extract it. On macOS:

```sh
shasum -a 256 -c SHA256SUMS
tar -xzf plenger-0.1.0-darwin-arm64.tar.gz
mkdir -p ~/.local/bin ~/.local/share/plenger
install -m 755 plenger ~/.local/bin/plenger
install -m 644 THIRD_PARTY_NOTICES.txt ~/.local/share/plenger/THIRD_PARTY_NOTICES.txt
export PATH="$HOME/.local/bin:$PATH"
plenger --version
plenger scan path/to/project
plenger serve path/to/project --port 4180
```

Keep the `PATH` line in your shell's startup file, such as `~/.zshrc`. The
executable can also run directly as `./plenger` from the extracted directory;
it does not need the repository checkout beside it. Keep
`THIRD_PARTY_NOTICES.txt` with the installed executable: it preserves the
notices and licences of the bundled runtime, grammars and dashboard
dependencies.

Archive names use the package version, operating system and architecture, for
example `plenger-0.1.0-darwin-arm64.tar.gz`. A binary runs only on the platform
it was built for.

## Update

Stop any running `serve` process, verify and extract the new archive, then
replace the executable and the notices in the same locations. There is no
automatic updater.

## What the binary does and does not do

- `plenger scan`, `facts`, `rules`, `redteam discover` and `redteam plan` read
  source only. They never import project code, install dependencies or load
  `.env` files.
- `plenger serve` binds the dashboard to `127.0.0.1` with a per-launch session
  token and keeps its state in a local SQLite database; see
  [dashboard.md](dashboard.md#saved-data-and-clearing).
- `plenger redteam run` and the dashboard's Start action run project code only
  inside a networkless container. They need Docker or Podman on the machine; the
  binary embeds the runtime recipes and builds the pinned image itself. See
  [redteam.md](redteam.md#prerequisites).

## Container prerequisites

Red-team runs need one of:

- Docker Desktop or a Docker engine reachable through the `docker` CLI
  (preferred when `docker info` succeeds), or
- Podman with a running Linux backend.

The first run downloads the pinned base image and dependency packages and
builds a local image. A cold build can take several minutes. Static scanning
needs neither.
