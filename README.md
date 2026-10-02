# plenger

Static triage for agentic AI projects written in Python, JavaScript and TypeScript:
what can the agent do, what can reach it, and what should a reviewer look at first.

plenger reads source code only. It never runs, imports or installs the project it
scans, and scanning needs no network access.

**Status:** milestone M5 of a rebuild. `plenger scan` parses every supported file,
links the project's modules, and reports the agent inventory (models, LLM calls,
agents, tools, MCP servers and clients, prompts, data stores, HTTP entry points),
what each tool, agent and entry point can do (run commands, execute code, touch
files, reach the network, databases, messages and payments), and risk findings
ranked for triage, each with the code that supports it and its OWASP and CWE
mapping. Reports include versioned JSON, SARIF 2.1.0 and Markdown, with baselines,
suppression files, a CI severity gate and a GitHub Action. See
[docs/ROADMAP.md](docs/ROADMAP.md). The earlier Python implementation (v0) is kept
on the `feat/backup` branch.

The planned MVP also includes a red-team harness for HTTP APIs, direct Python/Node
agent functions and MCP endpoints (M6), and indirect prompt-injection testing (M7),
followed by distribution (M8). Those dynamic commands are not implemented yet;
the current CLI remains an offline static scanner.

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
```

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
there are two today: `web-tree-sitter` and `ignore` (for `.gitignore` rules), neither
of which has dependencies of its own.
