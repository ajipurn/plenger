# plenger

*Please Let Every Null Get Escaped, Right?*

Local security review of your repositories, modeled on Codex Security Cloud.
One npm package with a local dashboard.

Run `plenger` to start the dashboard. Add a project, choose a model connection
and start a scan: bounded source review, a second skeptical review, STRIDE
threat modeling, source evidence and a prompt a coding agent can use to fix a
finding. Source leaves the machine only for the selected provider, after
redaction. See [docs/STATUS.md](docs/STATUS.md) for release availability,
capabilities and qualification evidence.

Static analysis reads source only. It never runs, imports or installs the
project and needs no network access. Its specialty is Python, JavaScript and
TypeScript: agent inventory, tool and entry point capabilities, and findings
with supporting code. Other languages enter AI review as text.

## Install and start

For a published release, use Node.js 22.18 or newer with npm:

```sh
npm install -g plenger
plenger
```

Or run without a global installation:

```sh
npx plenger@latest
```

Open the printed local URL in your browser. Save a connection under
Settings > Providers, then start a scan. Results and credentials are stored
locally, separately from the installed package. Stop the dashboard with Ctrl+C.

## Commands

```sh
plenger
plenger --workspace path/to/project --port 4180
plenger --data-dir path/to/data
plenger --help
plenger --version
plenger update
```

Published builds check for a newer stable release in the background, at most
once per day. Offline checks never block the dashboard. Set
`NO_UPDATE_NOTIFIER=1` to disable them.

`plenger update` updates an official npm global installation after showing
the current and target versions and asking for confirmation. Stop any running
dashboard first. npx, local dependency and source installations get instructions
for their installation method. Update does not move or delete dashboard data.
See [the install guide](docs/guide/install.md).

The CLI contains only the dashboard launcher, help, version and update.
Static analysis and AI review run through the dashboard. The red-team engine
and container recipes remain internal; the CLI does not expose them.
See [the architecture](docs/ARCHITECTURE.md) and [red-team guide](docs/guide/redteam.md).

## Reports and CI

The dashboard exports scan records as JSON. The composite
[GitHub Action](action.yml) calls the static engine directly and writes SARIF,
a Markdown job summary and a severity gate. It accepts explicit baseline and
suppression files. See [reports and CI](docs/guide/reports-ci.md).

## Documentation

- [Documentation index](docs/README.md)
- [Status and qualifications](docs/STATUS.md)
- [Dashboard](docs/guide/dashboard.md) and [AI security review](docs/guide/ai-security-review.md)
- [Static analysis](docs/guide/scanning.md) and [rule catalog](docs/RULES.md)
- [Installation and updates](docs/guide/install.md)
- [Architecture](docs/ARCHITECTURE.md) and [roadmap](docs/ROADMAP.md)
- [Changelog](CHANGELOG.md) and [security policy](SECURITY.md)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the toolchain, checks, fixtures and
benchmarks. [AGENTS.md](AGENTS.md) holds instructions for coding agents.
The earlier Python implementation is kept on the `feat/backup` branch.

## Licence

plenger is licensed under the [Apache License 2.0](LICENSE). Copyright 2026
Aji Purnomo. Grammar and dashboard dependency notices are listed in
[docs/licenses/sources.json](docs/licenses/sources.json) and shipped as
`dist/THIRD_PARTY_NOTICES.txt`.
