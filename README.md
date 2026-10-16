# plenger

Local security review of your repositories, modeled on Codex Security Cloud.
One npm package with a CLI and a local dashboard.

The dashboard is the main workflow; `plenger serve` opens it. A scan combines
offline static analysis with a bounded AI review of the source, in any
language, on a model connection you choose: candidate findings, a second
skeptical review, STRIDE threat modeling, source evidence and a prompt a coding
agent can use to fix a finding. Source leaves the machine only for the selected
provider, after redaction and within the budget you set.

Static analysis reads source code only. It never runs, imports or installs the
project and needs no network access. Its specialty is agentic AI code in
Python, JavaScript and TypeScript: the agent inventory, what each tool and
entry point can do, and ranked findings with the code that supports them. These
rules show where untrusted text reaches a model and what a manipulated agent
could do. They do not prove that an injection succeeds.

`plenger redteam run` tests two supported project shapes inside networkless
containers from the CLI. Further red-team work is postponed. See the
[roadmap](docs/ROADMAP.md).

## Status

| Area | State |
| --- | --- |
| Local dashboard: projects, scans, AI review, STRIDE, findings, fix prompts | Available; see [qualification status](docs/STATUS.md) |
| Static scan, reports, CI gate, GitHub Action | Available (M0 to M5 done) |
| npm package | CLI, dashboard and red-team recipes in one package; see [release status](docs/STATUS.md) |
| Managed red-team profiles, CLI campaigns and comparisons | Available from the CLI; further work postponed |

[docs/STATUS.md](docs/STATUS.md) is the single source of truth for what is
available, qualified and pending.

## Install

The primary distribution is an npm package. Users need Node.js 22.18 or newer.
See [docs/STATUS.md](docs/STATUS.md) for release availability. For a published
release, install the CLI globally:

```sh
npm install -g plenger
plenger --version
```

Or run it with npx:

```sh
npx plenger@latest scan path/to/project
npx plenger@latest serve --port 4180
```

The package includes the CLI, built dashboard, tree-sitter grammars and
container runtime recipes. Users do not build the frontend or install pnpm.
See [docs/guide/install.md](docs/guide/install.md). To build and verify a local
npm tarball, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

```sh
plenger serve path/to/project --port 4180
plenger scan path/to/project
plenger scan path/to/project --format sarif --output plenger.sarif --fail-on high
plenger redteam run path/to/project --provider "Local security tests" --repeat 20 --fail-on high
plenger redteam compare before.json after.json --change "Require approval before a price override"
```

`serve` prints a `http://127.0.0.1:<port>` address. Open it, add a local project and save a model connection under
Settings > Providers. New Scan runs static analysis and a bounded source-based AI review.
Use a finding's Fix with a coding agent action to generate a remediation prompt. Each command accepts only its own options; `plenger <command> --help`
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

Red-team work is postponed. Two managed profiles stay available from the CLI. `llmfy-file-canary-v1` runs an llmfy 0.11.0 project
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

plenger is licensed under the [Apache License 2.0](LICENSE). Copyright 2026
Aji Purnomo.

Third-party notices for the grammars and dashboard dependencies are listed in
[docs/licenses/sources.json](docs/licenses/sources.json) and shipped as
`dist/THIRD_PARTY_NOTICES.txt` in the npm package.
