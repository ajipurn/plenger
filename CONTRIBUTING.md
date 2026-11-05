# Contributing

This guide covers the toolchain, the checks that must pass, and the workflows
for fixtures, generated files, grammars and the container runtimes. The source
layout is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); coding-agent
instructions live in [AGENTS.md](AGENTS.md).

## Toolchain

- Node.js 22.23.4 or later on the 22 line, 24.22.1 or later on the 24 line, or
  26.12.1 or newer. `.nvmrc` pins the major version; run `nvm use` in the
  checkout. Node runs the TypeScript sources directly through type stripping, so
  `pnpm dev` needs no build step.
- pnpm 10.19.0, pinned by the `packageManager` field in `package.json`. Use
  `corepack enable` or install that version; CI reads the same field.

```sh
pnpm install --ignore-scripts
pnpm check
```

Install with `--ignore-scripts`. The repository's supply-chain policy blocks
dependency install scripts anyway, and the flag makes that explicit on every
machine and in CI. The tree-sitter grammars are vendored as WASM, so no native
add-on needs to compile.

## Supply-chain policy

`pnpm-workspace.yaml` sets `minimumReleaseAge: 4320` (three days) and an empty
`onlyBuiltDependencies` list. pnpm therefore refuses versions published less
than three days ago and never runs a dependency's install scripts. Keep runtime
dependencies to a minimum; there are three: `web-tree-sitter`, `ignore` and
`smol-toml`, none with runtime dependencies of its own. Pin exact versions.
Third-party GitHub Actions are pinned to commit SHAs; Dependabot proposes
updates weekly.

## Checks

```sh
pnpm check            # typecheck (engine, dashboard, docs), biome lint, vitest
pnpm typecheck        # engine only
pnpm lint             # biome check .
pnpm format           # biome check --write . (formatting and import order)
pnpm test             # vitest run
pnpm build            # compile to dist/ with tsconfig.build.json
```

`pnpm check` must pass before a commit. It runs offline and does not need
Docker or Podman.

### Erasable TypeScript only

`tsconfig.json` sets `erasableSyntaxOnly`. Use only syntax that Node can strip:
no enums, no namespaces, no parameter properties, no `import x = require()`.
Import local modules with their `.ts` extension; `rewriteRelativeImportExtensions`
turns them into `.js` in the compiled output.

## Running from source

```sh
pnpm dev --workspace path/to/project --port 4180
pnpm dev --help
pnpm dev update --help
pnpm dashboard --workspace path/to/project --port 5173
pnpm dashboard:build
```

`pnpm dashboard` builds the frontend once, then starts Vite with hot reload and
the local API service. `pnpm dev` serves the last frontend build without
Vite. The `dashboard/` package has its own `package.json` and typecheck, run by
`pnpm check`.

## Tests

- Tests live in `test/*.test.ts` and run with Vitest (`vitest.config.ts`).
- `test/support/fixtures.ts` resolves paths under `test/fixtures/`;
  `test/support/tmp.ts` creates temporary directories removed after each test.
  `test/helpers.ts` holds fact and scan helpers for parser-level tests.
- Fixture corpora: `test/fixtures/frameworks`, `crossfile`, `risks` and
  `runtimes` each carry `expected-inventory.json` and `expected-findings.json`
  reviewed against their source. `mixed-agent` is the end-to-end project used by
  report, inventory, dashboard and package smoke tests. `redteam/llmfy` and
  `redteam/vercel` are the discovery and planning fixtures. `reports/` holds the
  unmodified OASIS SARIF 2.1.0 schema.
- Golden files: the JSON schemas under `schemas/` and `docs/RULES.md` are
  generated, and tests fail when they drift from the source of truth.
- Container-dependent tests (`test/redteam-runtime.test.ts`,
  `test/redteam-worker.test.ts`, `test/redteam-vercel-run.test.ts`) skip unless the
  image environment variables below are set.

## Benchmark and expected files

`pnpm bench` (`scripts/benchmark.ts`) reports precision and recall of the
inventory and findings on the fixture corpora. To add a framework, add catalog
rules and a fixture under `test/fixtures/frameworks/`. To add a risk rule, add
it to `src/rules/catalog.ts` with a check in `src/rules/checks/` and positive
and negative cases under `test/fixtures/risks/`. Then:

```sh
pnpm bench -- --write
git diff test/fixtures/*/expected-*.json
```

## Detection evaluation

`pnpm evaluate` (`scripts/evaluate.ts`) measures detection on the labeled corpus in
`test/fixtures/evaluation/`: pairs of a vulnerable case and a safe near-miss per
weakness, described in its README. Without options it scores the static rules
offline. `--provider <saved name>` also runs the AI review of that connection
`--runs` times (default 3) and reports precision, recall and their spread per
run; `--validator` adds a separate second-review connection. `--model <id>` uses
another model of the saved connections instead of their default, with that
model's prices and window, and leaves the saved connection as it is. Check which
model a run will use before starting it: the default may cost far more than the
model a scan used. `--mode explore`
runs exploring reviews, where the model reads each case through read-only tools,
instead of the default `--mode batch`. A live run sends the redacted corpus to
the provider and needs `--yes`; a batch review makes at most two model requests
per case and run, an exploring one at most 18. Write records with `--output
docs/qualifications/<name>.md`. `--json <file>` writes every outcome, including
each finding at a labeled location with its title, STRIDE category, CWE,
severity, second-review verdict and reason, to see why a safe case was reported.

The second review decides the static scanner's findings with the AI candidates,
and the dashboard lists both. So any kept finding of either origin that cites
the labeled lines detects a case. Discovery alone leaves static findings out and
counts an AI finding dismissed as a duplicate of a kept candidate, which keeps it
comparable with runs from before static candidates were validated. Counting only
source-supported findings is stricter. Counting only findings that name the
labeled weakness needs the finding's CWE to be in the label's family
(`src/assessment/weaknesses.ts`); it keeps a second weakness at the same lines
from counting for the labeled one. A table counts the static findings' verdicts
by whether they cite a vulnerable label, a safe label or neither.
The static rules and each AI review also get a table per labeled CWE. Precision and
recall carry a 95% Wilson score interval that counts each case once, so more
`--runs` show the model's spread but do not narrow it. A CWE with one pair has an
interval too wide to compare.
`test/evaluation.test.ts` fails when the static results drift from the labels.
`--corpus test/fixtures/evaluation-library` scores the library corpus, whose cases
are scanned as the engine's library mode scans a package.

```sh
pnpm evaluate
pnpm evaluate --corpus test/fixtures/evaluation-library
pnpm evaluate --provider "Claude review" --runs 3 --yes --output docs/qualifications/detection-claude-2026-10-16.md
pnpm evaluate --provider "Claude review" --runs 1 --mode explore --yes --json explore.json
pnpm evaluate --proof --provider "ChatGPT" --runs 1 --yes --output proof.md
```

`--proof` runs proof sessions on the cases with a `proof` label instead of the
review: the model writes tests and the cases' code runs in the proof images, so it
needs Docker or Podman. It uses `PLENGER_TEST_PROOF_PYTHON_IMAGE` and
`PLENGER_TEST_PROOF_NODE_IMAGE` when set, or builds the images. Without `--yes` it
prints the token ceiling and stops.

`--write` replaces the expected files with the current output. Review every
changed line against the source before committing; the expected files are the
accuracy record, not a cache.

`node scripts/advisories.ts run --cache <dir>` measures the static rules on reviewed
GitHub advisories of AI and agent projects, listed in
`test/fixtures/advisories/manifest.json`. It downloads the code around each fix,
before and after it, scans both versions read-only, and needs `gh` and network
access. Downloads stay in the cache for later runs, which then need neither.
`--library` scans both versions as library scans. `node scripts/advisories.ts
select` rebuilds the manifest from the database with the fixed selection rule; a new
selection changes the benchmark, so record its date.

```sh
node scripts/advisories.ts run --cache ~/.cache/plenger-advisories --output docs/qualifications/<name>.md
node scripts/advisories.ts run --library --cache ~/.cache/plenger-advisories --json library.json
```

## Generated artefacts

```sh
pnpm generate       # docs:rules + schemas
pnpm docs:rules     # scripts/rules-doc.ts writes docs/RULES.md from src/rules/catalog.ts
pnpm schemas        # scripts/report-schemas.ts writes schemas/*.schema.json
```

Run `pnpm generate` after changing the rule catalog or a report, baseline,
suppression or red-team contract. `test/rules.test.ts` and the schema tests
compare the checked-in files with fresh output and fail on drift. Never edit
`docs/RULES.md` or the schemas by hand.

## Grammars

Parsing uses web-tree-sitter with the Python, JavaScript, TypeScript, TSX and PHP
grammars vendored as WASM in `grammars/`. `grammars/manifest.json` records each
file's source package, version and SHA-256, and a test checks them. To change a
grammar version, edit `scripts/update-grammars.ts` and run `pnpm grammars`. The
script unpacks the npm tarballs without installing them, so their native
install scripts never run.

## Container runtimes

The red-team profiles run project code in containers built from
`runtimes/llmfy/` and `runtimes/vercel/`. The launcher
(`src/redteam/runtime.ts`) uses Docker when `docker info` succeeds and falls
back to Podman. Both need a running Linux backend. Regular `pnpm check` never
touches them.

Managed runs remove their runtime images on completion,
failure or cancellation. Campaign repetitions share one image and remove it at
the end. Docker needs Buildx for a dedicated builder whose cache is removed after
each build. Podman disables intermediate image caching. Shared base images stay
reusable, as do images built by the developer qualification scripts.
The next run builds a new runtime image.

```sh
pnpm qualify:llmfy    # builds the llmfy image, runs the synthetic suite and the container tests
pnpm qualify:vercel   # builds the Next.js image and runs test/redteam-vercel-run.test.ts against it
pnpm qualify:proof    # builds both proof images and runs test/proof-runtime.test.ts against them
```

Each script prints the immutable image id it tested. To rerun the container
tests against an existing image, set the variable and run Vitest directly:

| Variable | Used by | Value |
| --- | --- | --- |
| `PLENGER_TEST_LLMFY_IMAGE` | `test/redteam-runtime.test.ts`, `test/redteam-worker.test.ts` | `sha256:<id>` for Podman, `docker:sha256:<id>` for Docker |
| `PLENGER_TEST_VERCEL_IMAGE` | `test/redteam-vercel-run.test.ts` | Same format |
| `PLENGER_TEST_PROOF_PYTHON_IMAGE` | `test/proof-runtime.test.ts` | Same format |
| `PLENGER_TEST_PROOF_NODE_IMAGE` | `test/proof-runtime.test.ts` | Same format |

Mutable tags are rejected. The image must come from this repository's recipe;
the variables are not an interface for arbitrary images.

### Regenerating the runtime lockfiles

The llmfy image installs hashed wheels only. After changing
`runtimes/llmfy/requirements.in`:

```sh
uv pip compile runtimes/llmfy/requirements.in --python-version 3.12 \
  --python-platform aarch64-unknown-linux-gnu --only-binary :all: \
  --exclude-newer 2026-09-29 --generate-hashes --no-header --no-annotate \
  --output-file runtimes/llmfy/requirements.txt
```

Move `--exclude-newer` forward deliberately and record the date in the commit.
The Next.js image installs `runtimes/vercel/package.json` with `npm ci`. After
changing a version there, regenerate `runtimes/vercel/package-lock.json` with
`npm install --package-lock-only --ignore-scripts` in that directory, then
rebuild with `pnpm qualify:vercel`. The host checks the exact `ai`, Node and
observer versions reported by the worker, so a version change also touches
`src/redteam/vercel-run.ts` and the worker.

The proof images carry a fixed package set instead of project dependencies; see
[docs/design/proof-tests.md](docs/design/proof-tests.md#decision-1-dependencies).
After changing `runtimes/proof-python/requirements.in`:

```sh
uv pip compile runtimes/proof-python/requirements.in --python-version 3.12 \
  --python-platform aarch64-unknown-linux-gnu --only-binary :all: \
  --exclude-newer 2026-11-04 --generate-hashes --no-header --no-annotate \
  --output-file runtimes/proof-python/requirements.txt
```

After changing `runtimes/proof-node/package.json`, run
`npm install --package-lock-only --ignore-scripts` in that directory. Then run
`pnpm qualify:proof`; the harness reports the versions it found.

Base images are pinned by digest in each `Dockerfile`. A recipe change produces
a new image digest; the qualification records in `docs/qualifications/` state
which image they tested.

## npm package

```sh
pnpm build:package   # compile the CLI, build the dashboard and write notices
pnpm test:package    # pack, install offline and check the installed CLI and dashboard
```

`npm pack` and `npm publish` run `prepack`, which builds the package first.
To release, set the version in `package.json`, give the changelog's Unreleased
entries that version and date, and commit to `main`. Once the installed-package
jobs pass on Linux, macOS and Windows, push a tag such as `v0.1.1`. The
[Release workflow](.github/workflows/release.yml) checks that the tag names the
package version, runs `pnpm check` and `pnpm test:package`, and stages the
version with npm trusted publishing, which needs no token and adds provenance.
The trusted publisher may only stage, so the version is released once a
maintainer approves it with 2FA, in **Staged Packages** on npmjs.com or with
`npm stage approve <stage-id>`. A manual run of the workflow publishes nothing:
it dry-runs a prerelease of the current version, since npm refuses even a dry
run of a published version. See
[docs/STATUS.md](docs/STATUS.md) for what has been published.
Installation from the tarball or registry uses the built files and runs no
Plenger install scripts. The package includes all CLI commands, the dashboard,
grammars and container recipes. Docker or Podman is needed only for red-team
execution.

The smoke check writes `dist/npm/plenger-<version>.tgz`. It installs the archive
and the locally packed production dependency closure in a temporary directory
without registry access. It fails on runtime files outside `RUNTIME_FILES` and
on compiled files without a matching source. It checks npm command resolution,
launcher and update help, and an authenticated scan on the real dashboard that
parses Python, JavaScript, TypeScript and TSX files.
The npm package workflow runs it on Linux, macOS and Windows for every push to
main, pull request and manual run. It keeps no artifact.

See [docs/design/distribution.md](docs/design/distribution.md).

## Documentation

The Fumadocs site reads the maintained Markdown directly. Run `pnpm docs:dev` to
open it at `http://127.0.0.1:4192/docs/`. `pnpm docs:build` exports static files
to `docs-site/out`, ready for a static host.
See [docs-site/README.md](docs-site/README.md) for routes and content configuration.

Docs are English, present tense, short sentences, no marketing. Status claims
belong in [docs/STATUS.md](docs/STATUS.md); other pages link there. Dated
qualification evidence goes to `docs/qualifications/`. Every CLI flag mentioned
must exist in the command's usage string. [docs/README.md](docs/README.md) is the
index.

## Commit style

Use conventional commit prefixes as in the log: `feat:`, `feat(redteam):`,
`fix:`, `docs:`, `refactor:`, `test:`, `chore:`. The subject is imperative and
under 72 characters. The body explains what changed and why, names the tests
that cover it and records measurements (test count, benchmark result) when they
changed. Commit generated files together with the change that caused them.

## Licence

plenger is licensed under the Apache License 2.0. Contributions are licensed
under the same terms, as section 5 of [LICENSE](LICENSE) states. No separate
contributor agreement is needed.
