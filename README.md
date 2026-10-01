# plenger

Static triage for agentic AI projects written in Python, JavaScript and TypeScript:
what can the agent do, what can reach it, and what should a reviewer look at first.

plenger reads source code only. It never runs, imports or installs the project it
scans, and scanning needs no network access.

**Status:** milestone M2 of a rebuild. `plenger scan` parses every supported file
and reports the project's agent inventory: models, LLM calls, agents, tools, MCP
servers and clients, prompts, data stores and HTTP entry points. Tool capability
analysis and risk rules come next. See
[docs/ROADMAP.md](docs/ROADMAP.md). The earlier Python implementation (v0) is kept
on the `feat/backup` branch.

## Requirements

Node.js 22.18 or newer (see `.nvmrc`) and pnpm 10.

## Usage

```sh
pnpm install
pnpm dev scan path/to/project
pnpm dev scan path/to/project --json
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

`scan --json` includes every item with its location. Supported frameworks are listed
in [docs/ROADMAP.md](docs/ROADMAP.md#m2-agent-inventory-first-batch-done); the
detection rules are data in [src/inventory/catalog/](src/inventory/catalog/).

`facts` prints, per file, the imports, definitions (with decorators, base classes
and docstrings), assignments and calls. Call targets are resolved through imports,
variables, `self`/`this` attributes and destructuring into canonical names such as
`openai.OpenAI().chat.completions.create` (Python) or
`openai#default().chat.completions.create` (JS/TS); see
[src/facts/model.ts](src/facts/model.ts). The JSON output of both commands is
unstable until M5.

## Development

```sh
pnpm check      # type-check, lint and test
pnpm build      # compile to dist/
pnpm format     # apply Biome formatting and import order
node scripts/benchmark-inventory.ts   # precision and recall on the fixture corpus
```

To support a new framework, add rules to the catalog, a fixture under
`test/fixtures/frameworks/`, then run `node scripts/benchmark-inventory.ts --write`
and review the diff of `expected-inventory.json` line by line before committing it.

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
