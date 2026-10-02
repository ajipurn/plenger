# plenger

Static triage for agentic AI projects written in Python, JavaScript and TypeScript:
what can the agent do, what can reach it, and what should a reviewer look at first.

plenger reads source code only. It never runs, imports or installs the project it
scans, and scanning needs no network access.

**Status:** M0–M5 implemented; M6a has offline llmfy discovery and project
preparation plans, synthetic runtime qualification and a shared model-budget
controller tested with synthetic providers. Live model access and the dashboard
remain pending.
`plenger scan` parses every supported file,
links the project's modules, and reports the agent inventory (models, LLM calls,
agents, tools, MCP servers and clients, prompts, data stores, HTTP entry points),
what each tool, agent and entry point can do (run commands, execute code, touch
files, reach the network, databases, messages and payments), and risk findings
ranked for triage, each with the code that supports it and its OWASP and CWE
mapping. Reports include versioned JSON, SARIF 2.1.0 and Markdown, with baselines,
suppression files, a CI severity gate and a GitHub Action. See
[docs/ROADMAP.md](docs/ROADMAP.md). The earlier Python implementation (v0) is kept
on the `feat/backup` branch.

The planned MVP also includes red-teaming of the running agent: a harness that tests
direct input to HTTP APIs, Python/Node agent functions and MCP endpoints (M6), then
indirect prompt injection through content the agent reads (M7), followed by
distribution (M8). For supported integrations, the planned React + Vite dashboard
lets users choose a project or endpoint and start built-in tests without writing wrappers,
adding instrumentation or preparing fixtures; plenger manages that setup. Missing
access or ambiguous targets are handled through the interface, and profiles can
be reused from the CLI or CI. The dashboard will also expose static scans, agent
inventory, findings and local run history. These dynamic workflows and the
dashboard are not implemented yet; the current CLI remains an offline static scanner.

The product direction is core capability parity with promptfoo, developed in
stages. Generated/adaptive attacks, multi-turn testing, hybrid grading and broader
evaluation/regression workflows are planned beyond the initial M6/M7 foundation.

## Requirements

Node.js 22.18 or newer (see `.nvmrc`) and pnpm 10.

## Usage

```sh
pnpm install
pnpm dev scan path/to/project
pnpm dev scan path/to/project --all
pnpm dev scan path/to/project --json
pnpm dev scan path/to/project --format sarif --output plenger.sarif --fail-on high
pnpm dev scan path/to/project --format markdown --output report.md
pnpm dev rules
pnpm dev facts path/to/project/agent.py
pnpm dev redteam discover path/to/llmfy-project
pnpm dev redteam discover path/to/llmfy-project --json
pnpm dev redteam plan path/to/llmfy-project --json
```

`scan` reports the files it parsed per language, files with syntax errors (results
for those may be partial), files it skipped and why, and directories it excluded
(dependencies, build output, virtualenvs, and whatever the project's `.gitignore`
files ignore; `--no-gitignore` turns that off). A path can also be a single file.

It then summarises the agent inventory, for example:

```text
  Agent inventory
    Frameworks           llmfy (26 files), OpenAI SDK
    Models           37  gemini-2.5-flash-lite ×10, ${OLLAMA_MODEL:-gemma4:e4b} ×4, …
    LLM calls        39  llmfy invoke ×18, llmfy chat ×13, …
    Agents           47  LLMfy ×36, FlowEngine ×11
    Tools            12  get_current_weather, get_current_time
    Prompts          31  0 with dynamic parts, 5 with template variables
    Data stores      14  checkpointer ×8, embeddings ×6
    Not understood yet: google.genai (1 file)
```

After the inventory, a capabilities section lists the tools that can run commands,
execute code, write or delete files and so on, the agents that execute code
themselves, and the HTTP entry points that reach a model or agent.

Last come the findings, most urgent first (`--all` lists every one):

```text
  Findings  10 critical · 19 high · 7 medium · 4 low

    CRITICAL 100  Tool `run` runs a shell command built from model input
                  mcp_servers.py:13  PLG101 · high confidence · exposed
                  │ return subprocess.run(command, shell=True, capture_output=True, text=True).stdout

    CRITICAL 100  Tool `shell` runs a shell command built from model input
                  tools_unsafe.py:18  PLG101 · high confidence · exposed
                  │ return subprocess.run(command, shell=True, capture_output=True, text=True).stdout
```

The score (0–100) combines severity, confidence and exposure (reachable from an HTTP
route or a network MCP server). `plenger rules` lists the rules;
[docs/RULES.md](docs/RULES.md) describes each one with its fix. A rule that finds
nothing proves nothing: plenger reports what it can see in the code.

`scan --json` includes every item with its location, every capability with its
call chain and the non-constant inputs of the effect (and where each input comes
from), and every finding with its evidence chain, source lines and a stable
fingerprint. Recognised secrets are redacted throughout the output, including
`facts`: plenger reports their kind and location, and shows `<redacted>` in their
place. Supported frameworks are listed
in [docs/ROADMAP.md](docs/ROADMAP.md#m2-agent-inventory-done); the detection rules
are data in [src/inventory/catalog/](src/inventory/catalog/).

`facts` prints, per file, the imports, definitions (with decorators, base classes
and docstrings), assignments and calls. Call targets are resolved through imports,
variables, `self`/`this` attributes and destructuring into canonical names such as
`openai.OpenAI().chat.completions.create` (Python) or
`openai#default().chat.completions.create` (JS/TS); see
[src/facts/model.ts](src/facts/model.ts). Both commands emit JSON report version 1;
[schemas/report-v1.schema.json](schemas/report-v1.schema.json) defines the contract.

`redteam discover` finds llmfy function/factory candidates using the static
inventory and reports unsupported shapes with reasons. It reads source without
importing the project, installing dependencies or calling a model. Its terminal
and JSON outputs include scan gaps and root dependency-manifest presence. A
candidate is not yet a runnable target: runtime qualification, input/output
mapping, isolation, test packs and execution are still pending. The discovery JSON
uses its own `kind: "redteam-discovery"` contract with `executionReady: false`;
it is not a scan report or an attack result. See [docs/REDTEAM.md](docs/REDTEAM.md)
for the current scope and the remaining M6a stages.

`redteam plan` reviews dependency declarations and Python source preparation.
It selects a sole candidate automatically; use `--target <id>` when a choice is
needed. Plans report captured source hashes, exclusions and pending runtime work.
Planning uses a temporary private source snapshot, removes it afterward, and
never imports the project or installs its dependencies. `preparation.status:
"ready"` means a source snapshot can be prepared, while `executionReady` remains
`false`. See [docs/REDTEAM.md](docs/REDTEAM.md#available-offline-project-preparation)
for the supported metadata and source policy.

## Reports and CI

`--format terminal|json|sarif|markdown` selects a report; `--json` is an alias for
`--format json`. `--output` writes it to a file and creates parent directories.
JSON, SARIF and Markdown include every finding, its evidence and the rules that
fired. Terminal output shows the first 20 active findings (`--all` shows all).
When the scanned path is a subdirectory, `--source-root <repository root>` makes
SARIF and Markdown paths relative to the repository, as GitHub code scanning
expects.

Create a reviewed baseline, then gate new findings:

```sh
pnpm dev scan path/to/project --write-baseline plenger-baseline.json
pnpm dev scan path/to/project --baseline plenger-baseline.json --fail-on high
```

`--fail-on high` fails for new, unsuppressed high or critical findings. The default
is `none`; thresholds are `critical`, `high`, `medium`, `low` or `none`. Reports are
written before a failed gate exits with code 3. Scan/I/O errors exit 1; invalid
arguments or policy files exit 2. Baseline findings remain visible and do not fail
the gate. A `--suppressions` file requires a review reason for each exclusion;
`--omit-suppressed` leaves suppressed findings out of the report but keeps their count.

The composite [GitHub Action](action.yml) produces SARIF and a Markdown job summary
from one scan, and defaults to `fail-on: high`. Its SARIF paths are relative to the
repository root, and it leaves suppressed findings out of the SARIF because GitHub
does not honour SARIF suppressions. The repository's
[CI workflow](.github/workflows/ci.yml) tests it with `uses: ./`.
See [docs/REPORTS.md](docs/REPORTS.md) for report contracts, policy formats and
the workflow for uploading results to GitHub code scanning.

## Development

```sh
pnpm check      # type-check, lint and test
pnpm build      # compile to dist/
pnpm format     # apply Biome formatting and import order
node scripts/benchmark.ts   # precision and recall of the inventory and findings on the fixture corpora
node scripts/rules-doc.ts  # regenerate docs/RULES.md after changing the rule catalog
node scripts/report-schemas.ts # regenerate the versioned JSON schemas
pnpm qualify:llmfy # opt-in Podman integration checks; builds the pinned synthetic runtime
```

The llmfy qualification command requires an active Podman Linux backend and
downloads its pinned image dependencies during setup. It runs a bundled fixture
with synthetic model responses and no worker network access; it does not execute
user projects. See [docs/LLMFY_RUNTIME.md](docs/LLMFY_RUNTIME.md). Regular
`pnpm check` does not require Podman.

To support a new framework, add rules to the catalog and a fixture under
`test/fixtures/frameworks/`; to add a risk rule, add it to
[src/rules/catalog.ts](src/rules/catalog.ts) with a check in
[src/rules/checks/](src/rules/checks/) and positive and negative cases under
`test/fixtures/risks/`. Then run `node scripts/benchmark.ts --write` and review the
diff of `expected-inventory.json` and `expected-findings.json` line by line before
committing it.

Source is TypeScript that Node runs directly (type stripping), so `pnpm dev` needs
no build step. Use only erasable TypeScript syntax: no enums, namespaces or
parameter properties.

### Grammars

Parsing uses [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) with the
Python, JavaScript, TypeScript and TSX grammars vendored as WASM in `grammars/`.
`grammars/manifest.json` records each file's source package, version and SHA-256,
and a test checks them. To change a grammar version, edit
`scripts/update-grammars.ts` and run `pnpm grammars`; the script unpacks the npm
tarballs without installing them, so their native install scripts never run.

### Dependencies

`pnpm-workspace.yaml` only accepts package versions published at least three days
ago and blocks dependency install scripts. Keep runtime dependencies to a minimum;
there are three today: `web-tree-sitter`, `ignore` (for `.gitignore` rules) and
`smol-toml` (for declarative project metadata). None has runtime dependencies of
its own. Reading metadata never invokes a project's build backend or installer.
