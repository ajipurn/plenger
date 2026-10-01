# plenger

Static triage for agentic AI projects written in Python, JavaScript and TypeScript:
what can the agent do, what can reach it, and what should a reviewer look at first.

plenger reads source code only. It never runs, imports or installs the project it
scans, and scanning needs no network access.

**Status:** milestone M1 of a rebuild. `plenger scan` walks a project and parses
every supported file, and `plenger facts` shows what each file imports, defines,
assigns and calls; agent inventory and risk rules come next. See
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
```

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
