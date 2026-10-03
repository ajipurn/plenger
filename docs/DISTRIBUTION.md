# Binary distribution

Plenger builds a standalone executable containing the Node.js runtime, CLI,
dashboard service, built frontend, tree-sitter runtime and four WASM grammars.
End users do not install Node.js, pnpm, parser packages or dashboard dependencies.
Both interfaces use the same executable:

```sh
plenger scan path/to/project
plenger serve path/to/project --port 4180
```

`serve` prints a local browser address and binds to `127.0.0.1`. Omitting `--port`
chooses an available port. Select a project in the dashboard to scan it; the
binary includes all frontend assets, so this does not start a Vite development
server. Ctrl+C stops the service.

## Current availability

Native binary packaging is available from this repository. There is no public
release download or published npm package yet. The macOS Apple Silicon
(`darwin-arm64`) build was verified locally with Node.js 22.23.2. Its smoke test
copies the executable outside the checkout and uses an empty `PATH`. It checks
version/help, scans with all four grammars, embedded dashboard JavaScript/CSS,
direct `/findings` loads, session-token authentication, scan API parity and a clean
service exit on SIGTERM.

Native CI build, smoke-test and artifact-upload jobs are configured for
`ubuntu-24.04`, `macos-14` and `windows-2022`, using Node.js 22.18.0. Those remote
jobs have not run yet. Linux, Windows and Intel macOS need their own passing build
and smoke-test evidence before being advertised as supported. A static scanner
binary does not qualify a dynamic execution backend.

The current binary runs static scans and offline red-team discovery/preparation.
It does not run an application's agents or call live model providers. M6a remains
incomplete. See [REDTEAM.md](REDTEAM.md) for current limits and [ROADMAP.md](ROADMAP.md)
for the remaining runtime and release work.

## Build from source

Maintainers need Node.js 22.18 or newer and pnpm 10. From the repository root:

```sh
pnpm install --ignore-scripts
pnpm build:binary
pnpm test:binary
```

The build bundles the engine and dashboard, embeds their runtime assets into a
Node.js single executable application, and creates the native executable under
`dist/binary/`. The macOS Apple Silicon output is `dist/binary/plenger`, with
`plenger-0.1.0-darwin-arm64.tar.gz` and `SHA256SUMS` in the same directory. Archive
names use the package version and the build machine's OS and architecture.

The archive contains the executable and `THIRD_PARTY_NOTICES.txt`, which preserves
the notices and licenses for the bundled runtime, parser grammars, engine
dependencies and frontend dependencies. The executable runs independently of
that text file; keep the notices with your installation. License source
provenance is recorded in [licenses/sources.json](licenses/sources.json). These
third-party licenses do not choose a license for Plenger itself.

Build on the target platform with its matching Node.js executable. The build is
native; changing an archive name does not produce a binary for another OS or
architecture. esbuild and postject are build dependencies, not end-user
requirements.

## Install an archive

After obtaining the archive and its accompanying checksum file, verify the
archive before extracting it. On macOS:

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

Keep the `PATH` line in your shell's startup file, such as `~/.zshrc`, to use
`plenger` in future terminals. The executable can also be run directly as
`./plenger`; it does not need the repository checkout beside it.
If you run it from an extracted archive instead of installing it, retain
`THIRD_PARTY_NOTICES.txt` in that directory.

For a later update, stop any running `serve` process, verify and extract the new
archive, then replace the executable and notices in the same locations. An
automatic updater is not implemented.

## Release work remaining

M8 still needs passing native CI evidence for each published platform, public
release artifacts and checksums, publisher signing for macOS and Windows, and
installation documentation for those releases. macOS builds currently use a local
ad-hoc signature; this is not publisher signing or notarization. The project has
not declared a license yet, so the project license also needs to be chosen before
public distribution. No published download URL or download/install command should
be advertised until release artifacts exist.

Static scans and preparation do not import project code, install dependencies or
load project `.env` files. Bundling the runtime changes installation, not this
execution policy. The binary dashboard retains the loopback Host/Origin checks,
launch token and Content Security Policy described in [DASHBOARD.md](DASHBOARD.md).
