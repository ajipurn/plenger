# plenger

Red-teaming and static triage for agentic AI projects written in Python,
JavaScript and TypeScript. One CLI and one local dashboard.

`plenger scan` reads source code only. It never runs, imports or installs the
project and needs no network access. It reports the agent inventory, what each
tool and entry point can do, and ranked findings with the code that supports
them. `plenger redteam run` tests supported projects inside networkless
containers after an explicit start, with a model connection and budget you
choose. The product direction is capability parity with promptfoo's red-teaming
workflow; see the [roadmap](docs/ROADMAP.md).

## Status

| Area | State |
| --- | --- |
| Static scan, reports, CI gate, GitHub Action | Available (M0 to M5 done) |
| Local dashboard with scan history, providers and red-team runs | Available |
| Managed red-team profiles: llmfy file canary, Next.js booking/SQLite | Available; synthetic qualification plus one live-model record |
| CLI campaigns (`redteam run`) and before/after comparisons (`redteam compare`) | Available |
| npm package | CLI, dashboard and red-team recipes in one package; see [release status](docs/STATUS.md) |

[docs/STATUS.md](docs/STATUS.md) is the single source of truth for what is
available, qualified and pending.

## Install

The primary distribution is an npm package. Users need Node.js 22.18 or newer.
See [docs/STATUS.md](docs/STATUS.md) for release availability. For a published
release, install the CLI globally:

```sh
npm install -g plenger-cli
plenger --version
```

Or run it with npx:

```sh
npx plenger-cli@latest scan path/to/project
npx plenger-cli@latest serve --port 4180
```

The package includes the CLI, built dashboard, tree-sitter grammars and
container runtime recipes. Users do not build the frontend or install pnpm.
See [docs/guide/install.md](docs/guide/install.md). To build and verify a local
npm tarball, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

```sh
plenger scan path/to/project
plenger scan path/to/project --format sarif --output plenger.sarif --fail-on high
plenger serve path/to/project --port 4180
plenger redteam run path/to/project --provider "Local security tests" --repeat 20 --fail-on high
plenger redteam compare before.json after.json --change "Require approval before a price override"
```

`serve` prints a `http://127.0.0.1:<port>` address. Open it, select a project
and scan it. Save a model connection under Settings → Providers before a
red-team run. Each command accepts only its own options; `plenger <command> --help`
lists them.

## Static scan

The scan parses every supported file, links the project's modules and reports
frameworks, models, LLM calls, agents, tools, MCP servers and clients, prompts,
data stores and HTTP entry points. A capabilities section lists which tools run
commands, execute code, touch files or reach the network, databases, messages and
payments. Findings come last, most urgent first, each with its evidence chain,
score and OWASP/CWE mapping. [docs/guide/scanning.md](docs/guide/scanning.md)
explains the output; [docs/RULES.md](docs/RULES.md) describes every rule.

```text
  Agent inventory
    Frameworks           llmfy (26 files), OpenAI SDK
    Models           37  gemini-2.5-flash-lite ×10, ${OLLAMA_MODEL:-gemma4:e4b} ×4, …
    LLM calls        39  llmfy invoke ×18, llmfy chat ×13, …
    Agents           47  LLMfy ×36, FlowEngine ×11
    Tools            12  get_current_weather, get_current_time

  Findings  10 critical · 19 high · 7 medium · 4 low

    CRITICAL 100  Tool `run` runs a shell command built from model input
                  mcp_servers.py:13  PLG101 · high confidence · exposed
                  │ return subprocess.run(command, shell=True, capture_output=True, text=True).stdout
```

## Red-teaming

Two managed profiles exist. `llmfy-file-canary-v1` runs an llmfy 0.11.0 project
and checks whether a forbidden file write happens. `vercel-booking-sqlite-v1`
runs a Next.js booking route handler against a disposable SQLite database and
checks price-override and zero-payment boundaries. plenger captures the source,
builds a pinned container image, installs its observation hooks and runs a clean
control before the attacks. The project's own tool handlers and approval checks
execute unchanged inside the container. Campaigns repeat trials, share one
budget, report 95% Wilson intervals and gate CI on severity, coverage and scope.
See [docs/guide/redteam.md](docs/guide/redteam.md).

Docker is used when available, otherwise Podman. Workers have no network, no
host mounts and no credentials; the model provider runs on the host.

## Reports and CI

`--format terminal|json|sarif|markdown` selects a scan report and `--output`
writes it. `--write-baseline` records reviewed findings; `--baseline` plus
`--fail-on high` fails only for new high or critical findings (exit 3). The
composite [GitHub Action](action.yml) writes SARIF and a job summary.
`redteam run` produces the same four formats for dynamic campaigns. See
[docs/guide/reports-ci.md](docs/guide/reports-ci.md).

## Documentation

- [docs/README.md](docs/README.md): index of all documentation
- [docs/STATUS.md](docs/STATUS.md): capabilities, qualifications, pending work
- Guides: [scanning](docs/guide/scanning.md), [reports and CI](docs/guide/reports-ci.md),
  [dashboard](docs/guide/dashboard.md), [red-teaming](docs/guide/redteam.md),
  [install](docs/guide/install.md)
- Design: [red-team contracts](docs/design/redteam-contracts.md),
  [worker protocol](docs/design/worker-protocol.md),
  [red-team engine](docs/design/redteam-engine.md),
  [llmfy runtime](docs/design/llmfy-runtime.md),
  [dashboard UI](docs/design/dashboard-ui.md),
  [distribution](docs/design/distribution.md),
  [architecture](docs/ARCHITECTURE.md)
- [docs/ROADMAP.md](docs/ROADMAP.md) and [CHANGELOG.md](CHANGELOG.md)
- [SECURITY.md](SECURITY.md)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the toolchain, checks, fixture and
benchmark workflow, container prerequisites and commit style. [AGENTS.md](AGENTS.md)
holds instructions for coding agents. The earlier Python implementation (v0) is
kept on the `feat/backup` branch.

## Licence

The project licence status is tracked in [docs/STATUS.md](docs/STATUS.md).
Third-party notices for the grammars and dashboard dependencies are listed in
[docs/licenses/sources.json](docs/licenses/sources.json) and shipped as
`dist/THIRD_PARTY_NOTICES.txt` in the npm package. Optional standalone archives
also include the bundled Node.js runtime notices.
