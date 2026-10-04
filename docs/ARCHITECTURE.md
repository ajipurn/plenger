# Architecture

plenger is one TypeScript codebase with two adapters, a command line and a local
dashboard, on top of a static-analysis pipeline and a red-team engine. Node 22 runs
the sources directly; `pnpm build` compiles them to `dist/` and `pnpm build:binary`
bundles everything into a single executable. This page describes the layers, the
direction of dependencies and where each kind of change belongs.

## Layers

```
src/
  bin.ts                 process entry (`plenger`)
  cli/                   adapter: argument parsing, usage text, exit codes
  dashboard/             adapter: HTTP routes, static assets, security headers
  storage/               SQLite repositories shared by the dashboard and the CLI
  redteam/               dynamic testing engine: discovery, plans, campaigns, workers
  scan.ts                composition root of the static pipeline
  report/                report shapes, formats (terminal, JSON, SARIF, Markdown), policies
  rules/                 risk rules, the engine that evaluates them, scoring
  capabilities/          what tools, agents and entry points can do
  inventory/             agent inventory detectors over linked facts
  project/               cross-file linking of facts and the per-file index
  facts/                 language-specific fact extraction and generic fact queries
  source/                file discovery, language classification, parsing, reading
  shared/                leaf utilities: secrets, runtime assets, JSON, hashing, guards
dashboard/src/           React page bundled by Vite, organised by feature
runtimes/                container recipes and in-container workers (llmfy, Next.js)
schemas/                 generated JSON schemas (`pnpm generate`)
test/                    vitest suites, `support/` helpers, fixture corpora and golden files
```

Dependencies point downwards only. `shared` and `source` import nothing else from
`src/`. The pipeline layers (`facts` → `project` → `inventory` → `capabilities` →
`rules` → `report`) each depend on the layers below them. `redteam` uses the
pipeline through `scan.ts` and `facts`/`inventory` types, plus `shared`. `storage`
depends on `redteam` record types. `dashboard` and `cli` sit on top and nothing
imports them back; `src/bin.ts` and `src/dashboard/bin.ts` are the only entry
points.

## The static pipeline

`scan(root, options)` in `src/scan.ts` wires the steps and never executes project
code:

1. `source/files.ts` walks the tree, applies `.gitignore` and the built-in
   exclusions, and classifies files by language.
2. `source/read.ts` reads each file and skips binaries, non-UTF-8 and minified
   output; `source/parser.ts` parses with the vendored tree-sitter WASM grammars.
3. `facts/` extracts imports, definitions, assignments and calls per file
   (`python.ts`, `javascript.ts`) into the shapes in `facts/model.ts`.
   `facts/query.ts` holds the generic queries over facts (dereferencing values,
   selecting arguments, provenance, literal credentials).
4. `project/project.ts` links the files of a project so imports resolve to the
   definitions they point at. `Project.link()` is the only constructor, so a
   project is never used unlinked. `project/index.ts` is the shared per-file call
   index used by later layers.
5. `inventory/detect/` runs the detector rules in `inventory/detectors/` over every
   file and produces the agent inventory (`inventory/model.ts`): frameworks, models,
   LLM calls, agents, tools, MCP servers and clients, prompts, data stores and HTTP
   entry points. The detector is split by concern: compiled rules, a file scope,
   instance and tool registries, prompt collection, constructors, relations, MCP
   members and routes.
6. `capabilities/` traces what each tool, agent and entry point can reach
   (`effects.ts`), which approvals guard it (`approvals.ts`) and which outputs it
   produces (`output.ts`), using the sink catalog in `sinks.ts`/`catalog.ts`.
7. `rules/engine.ts` evaluates the checks in `rules/checks/` with a `RuleContext`,
   then `rules/scoring.ts` scores, fingerprints and de-duplicates the findings.
   `rules/snippets.ts` attaches source lines.
8. `report/model.ts` applies baselines and suppressions and decides the CI gate;
   `report/format.ts` and `report/summary.ts` render the result; `report/schema.ts`
   is the source of the JSON schemas.

Secrets are redacted by `shared/secrets.ts` before anything is written.

## The red-team engine

`src/redteam/` runs supported projects inside networkless containers after an
explicit start.

- **Offline preparation.** `discover.ts` finds candidate targets from the static
  inventory. `plan.ts` (llmfy) and `vercel-plan.ts` (Next.js) capture a private
  source snapshot, review dependencies (`dependencies.ts`) and report readiness as
  a `ProjectPlan` (`plan-model.ts`). `profile.ts` decides whether a plan is
  runnable. `format.ts` renders the CLI text for both.
- **Model access.** `provider-config.ts` validates saved provider settings and
  converts them to `ProviderAccess`; `provider.ts` is the HTTP transport for
  OpenAI, Gemini and Ollama and the connection test; `budget.ts` enforces one
  shared call, token and time budget.
- **Runs.** `run-model.ts` defines a run and its trials. `run.ts` executes the
  llmfy file-canary profile and dispatches `vercel-booking-sqlite-v1` to
  `vercel-run.ts`. `run-lifecycle.ts` holds the shared executor core (budget,
  state transitions, source reading, model dispatch, ready-frame validation).
  `worker.ts` launches one container per trial and turns protocol violations and
  cleanup results into a typed `WorkerError`. `runtime.ts` builds the pinned
  images and lists the recipe files (`RUNTIME_FILES`) that the binary bundles.
- **Campaigns.** `campaign-model.ts` defines campaign plans, reports and the
  built-in case catalog; `campaign.ts` creates, validates and executes campaigns;
  `campaign-evidence.ts` computes statistics and the gate; `campaign-report.ts`
  formats evidence; `comparison.ts` and `comparison-report.ts` compare two
  campaigns; `campaign-evidence-io.ts` and `artifact-io.ts` read and write the
  private JSON evidence atomically.
- **Constants and schemas.** `constants.ts` is the single source for provider ids,
  limits, run states, case ids and runtime pins; `schema.ts` derives the JSON
  schemas from it.
- **Qualification.** `qualification.ts` and `qualification-broker.ts` run the
  synthetic container suites used by `pnpm qualify:*`.

The host to container protocol is specified in
[design/worker-protocol.md](design/worker-protocol.md); the workers live in
`runtimes/llmfy/` and `runtimes/vercel/`.

Modules the browser bundles must stay free of `node:` imports: `constants.ts`,
`campaign-model.ts`, `campaign-evidence.ts`, `comparison.ts`, `profile.ts`,
`plan-model.ts`, `run-model.ts`, `provider-config.ts` and `budget.ts`. The page
imports only types from `run.ts`, `campaign.ts` and `plan.ts`.

## Storage

`src/storage/` owns the SQLite database used by `plenger serve` and by
`plenger redteam run` for saved providers. `database.ts` opens the file and
applies `migrations.ts` (an ordered list keyed by `user_version`).
`scan-repository.ts` keeps projects, scans, plans, the selected workspace and the
theme; `redteam-repository.ts` keeps runs, campaigns and run profiles and
recovers interrupted ones on open; `provider-repository.ts` keeps provider
connections and their sealed keys (`provider-secrets.ts`). `store.ts` is the
facade the dashboard uses; `records.ts` defines the persisted shapes that the
dashboard contract re-exports.

## The command line

`src/cli/index.ts` maps a command name to a module in `src/cli/commands/` and maps
errors to exit codes: `UsageError`, `PolicyError`, `SourceRootError` and
`PreparationError` exit 2, anything else exits 1, and a failed finding gate exits 3.
Each command parses only its own options with `parseCommandArgs` (`args.ts`), so an
option of another command is reported as unsupported. `io.ts` abstracts stdout and
stderr so tests can call `main()` directly. `redteam-run.ts` and
`redteam-compare.ts` are the two heavier commands and are loaded on demand.
`github-action.ts` is the entry of the composite GitHub Action.

## The dashboard

The service in `src/dashboard/` binds `127.0.0.1`, issues a per-process token and
serves the built page from `dashboard/dist` (or the embedded assets in the binary).
`server.ts` listens and dispatches through the explicit route table in
`routes/index.ts`; each file under `routes/` handles one area (session, state,
scan, history, folders, providers, red-team, theme). `http.ts` holds the request
validators and `HttpError`, `security.ts` the headers and CSP, `operations.ts` the
supervisor that serialises long operations and cancellation, `static-assets.ts`
the asset serving.

`contract.ts` is the single contract between the service and the page: the `API`
route map, request and response types, the limits both sides enforce and the
theme markup both rewrite. It has no `node:` imports.

The page in `dashboard/src/` is organised by feature: `app/` (shell, routes,
state reducer, polling, theme), `api/` (the fetch client), `shared/` (UI
primitives, formatting, async helpers), and one folder per view: `overview`,
`findings`, `inventory`, `history`, `project`, `redteam`, `campaigns`,
`providers`. Styles live in `styles/`; the visual rules are in
[design/dashboard-ui.md](design/dashboard-ui.md).

## Tests

`test/*.test.ts` are black-box suites: the CLI tests call `main()`, the dashboard
tests speak HTTP to `startDashboard()`, and the inventory and rules tests compare
whole scans with the golden files under `test/fixtures/*/expected-*.json`.
`test/support/` holds the shared helpers (`fixturePath`, `temporaryDir`, the
synthetic provider, the dashboard harness, corpus list, benchmark scoring).
Container-gated suites skip unless `PLENGER_TEST_LLMFY_IMAGE` or
`PLENGER_TEST_VERCEL_IMAGE` is set; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Where a change belongs

| Change | Place |
| --- | --- |
| Support a new framework or library | `src/inventory/detectors/{python,javascript}.ts`, a fixture under `test/fixtures/frameworks/`, `pnpm bench -- --write` |
| Add a risk rule | `src/rules/catalog.ts`, a check in `src/rules/checks/`, cases under `test/fixtures/risks/`, `pnpm generate` |
| Add a tool capability or sink | `src/capabilities/sinks.ts` |
| Add a report format | `src/report/format.ts` and `src/cli/commands/output.ts` |
| Add a CLI command or option | `src/cli/commands/`, usage text in `src/cli/index.ts`, a case in `test/cli.test.ts` |
| Add a dashboard endpoint | `src/dashboard/contract.ts`, a handler in `src/dashboard/routes/`, `dashboard/src/api/client.ts`, a test in `test/dashboard-*.test.ts` |
| Add a red-team profile | `src/redteam/constants.ts`, a planner and an executor, a worker under `runtimes/`, `RUNTIME_FILES`, the schemas via `pnpm generate` |
| Change persisted data | a new entry in `src/storage/migrations.ts` and the matching repository |
