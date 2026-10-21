# Architecture

plenger is one TypeScript codebase with two adapters, a command line and a local
dashboard, on top of a static-analysis pipeline and a red-team engine. Node 22 runs
the sources directly; `pnpm build` compiles them to `dist/`. `pnpm build:package`
prepares the npm CLI with its built dashboard and assets; the npm package is the
only distribution. This page describes the layers, the direction of dependencies and where each kind of
change belongs.

## Layers

```
src/
  bin.ts                 process entry (`plenger`)
  cli/                   adapter: argument parsing, usage text, exit codes
  dashboard/             adapter: HTTP routes, static assets, security headers
  storage/               SQLite repositories shared by the dashboard and the CLI
  redteam/               dynamic testing engine: discovery, plans, campaigns, workers
  scan.ts                composition root of the static pipeline
  security/              repository, job and finding domain; read-only Git metadata
  assessment/            source-based AI review, STRIDE and retained facts-only assessments
  remediation/           explicit model-generated coding agent prompts from saved findings
  evidence/              bounded, redacted imports of external REA JavaScript analysis
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
pipeline through `scan.ts` and `facts`/`inventory` types, plus `shared`. `security` normalizes static and AI findings without changing the static
pipeline. `storage` depends on persisted domain record types. `dashboard` and `cli` sit on top and nothing
imports them back; `src/bin.ts` and `src/dashboard/bin.ts` are the only entry
points.

## The static pipeline

`scan(root, options)` in `src/scan.ts` wires the steps and never executes project
code:

1. `source/files.ts` walks the tree, applies `.gitignore` and the built-in
   exclusions, and classifies files by language.
2. `source/read.ts` reads each file and skips binaries, non-UTF-8 and minified
   output; `source/parser.ts` parses with the vendored tree-sitter WASM grammars,
   after `source/typescript-syntax.ts` blanks TypeScript 5 type syntax the
   TypeScript grammar does not know.
3. `facts/` extracts imports, definitions, assignments, calls and the guards of
   `if` statements per file (`python.ts`, `javascript.ts`) into the shapes in
   `facts/model.ts`. `facts/query.ts` holds the generic queries over facts
   (dereferencing values, selecting arguments, provenance, fixed collections and
   lookups, literal credentials).
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
   (`effects.ts`, which also follows fixed tables of functions and drops input the
   guards around a call limit), which approvals guard it (`approvals.ts`) and which
   outputs it produces (`output.ts`), using the sink catalog in
   `sinks.ts`/`catalog.ts`. A library scan (`library: true`) also traces the
   package's public functions and methods, listed by `library.ts`, like handlers.
7. `rules/engine.ts` evaluates the checks in `rules/checks/` with a `RuleContext`
   (`checks/library.ts` only has public functions to check in a library scan),
   then `rules/scoring.ts` scores, fingerprints and de-duplicates the findings.
   `rules/snippets.ts` attaches source lines.
8. `report/model.ts` applies baselines and suppressions and decides the CI gate;
   `report/format.ts` and `report/summary.ts` render the result; `report/schema.ts`
   is the source of the JSON schemas.

Secrets are redacted by `shared/secrets.ts` before anything is written.

## Read-only model assessment

`assessment/security-review.ts` runs bounded source discovery and a skeptical
second review through the saved provider. `review-source.ts` rereads only files
in a saved scan's allowlist through the bounded regular-file reader. It redacts
and line-numbers source before model dispatch. `review-focus.ts` orders files by
the scan's traced entry point, tool and model output paths. `review-excerpt.ts`
cuts a file that does not fit into whole functions with original line numbers,
using facts parsed at review time. `review-related.ts` gives the second review
the imports and callers of cited files, resolved through the project linker over
the same allowlist. An optional separate connection runs the second review. `review-model.ts` checks
all six STRIDE categories, citation ranges and complete host-assigned decision
ids. It canonicalizes known enum casing while preserving exact source scope.
Validation failures identify the stage and JSON field without echoing model values.
Native Claude reviews pass a host-owned output schema through the provider.
Its transport converts unsupported schema bounds to descriptions; the host
parser remains authoritative. The host supplies snippets from captured source.
A batch review exposes no model tools. An exploring review runs each pass as one
conversation in `review-explore.ts`: `list_files`, `read_file`, `search` and
`outline` over the same reader, a submit tool whose arguments the same parsers
check, a read log that bounds citations, and per-session limits with a closing
turn. Its limits live in `EXPLORE_LIMITS` in `review-model.ts`.
`storage/review-repository.ts` persists per-scan results. The explicit dashboard
route `routes/security-review.ts` remains available. The repository workspace
coordinates new jobs through `security-coordinator.ts` and exposes coverage,
threat models and source traces in scan Outputs. See
[guide/ai-security-review.md](guide/ai-security-review.md).

`assessment/assess.ts` composes an offline scan with one explicit Claude request.
It selects bounded, redacted facts and finding snippets from the chosen path.
`assessment/model.ts` validates the structured STRIDE response and its file/line
references. It defines the generated assessment schema. `assessment/format.ts`
renders JSON or escaped Markdown. Refusals and failures stop after one request.
No project execution or model tools are exposed. This retained engine is no longer
exposed as a public CLI command.

## Repository security workspace

`security/model.ts` defines local repositories, environments, monitoring, scan
jobs, finding statuses and scan depths. `security/findings.ts` normalizes
static and AI evidence into reports with stable fingerprints. The workflow
status is separate from an AI validation verdict.

`dashboard/security-coordinator.ts` owns background jobs and local commit
monitoring. It captures an offline scan, runs one or up to three independent
source-review batches, saves results and stops at failures or refusals.
`OperationSupervisor` serializes jobs with other project operations and owns
cancellation. Navigating away does not abort a job. Monitoring checks local
HEAD every 30 seconds while the service runs. Provider failures pause it.

`security/git.ts` reads revision metadata using fixed Git commands, disables
hooks and fsmonitor, and removes inherited Git configuration variables. It is
outside the static pipeline. The reported revision does not freeze source;
review file digests identify captured content. No application code executes.

`routes/security-workspace.ts` validates repository registration, job starts,
monitoring pauses, cancellation and finding status updates. It resolves saved
provider IDs without accepting raw credentials or model-supplied execution.

## The red-team engine

`src/redteam/` runs supported projects inside networkless containers after an
explicit start.

- **Offline preparation.** `discover.ts` finds candidate targets from the static
  inventory. `plan.ts` (llmfy) and `vercel-plan.ts` (Next.js) capture a private
  source snapshot, review dependencies (`dependencies.ts`) and report readiness as
  a `ProjectPlan` (`plan-model.ts`). `profile.ts` decides whether a plan is
  runnable. `format.ts` retains text rendering for both.
- **Model access.** `provider-config.ts` validates saved provider settings and
  converts them to `ProviderAccess`; `provider.ts` is the HTTP transport for
  OpenAI, Gemini and Ollama and the connection test. `anthropic-provider.ts`
  translates text and function tools to Claude's native Messages API and accounts
  for cache tokens. Provider refusals stop the step and campaign repetitions.
  `budget.ts` enforces one shared call, token and time budget. The experimental ChatGPT subscription
  provider has two modules: `chatgpt-auth.ts` runs the Sign in with ChatGPT
  flow (PKCE, loopback callback, id-token verification, refresh, model
  catalog) and `chatgpt-provider.ts` is its streaming Responses API transport,
  which reports observed token thresholds instead of an enforced output cap.
- **FastAPI preparation.** `fastapi-prepare.ts` builds a FastAPI project's image,
  starts the disposable MySQL and Redis services from `services.ts` on a private
  network and imports the application in a worker; it is the M6b profile's first
  stage and makes no model calls. `runtimes/fastapi/` holds its recipe, preflight,
  worker and the llmfy version adapters.
- **Trial input.** `attack-model.ts` holds the built-in control and probe
  input as templates with `{{name}}` placeholders, the placeholders each
  profile's runner fills, and the fill and validation helpers. It has no
  `node:` imports, so the dashboard can render templates.
- **Runs.** `run-model.ts` defines a run and its trials. `run.ts` executes the
  llmfy file-canary profile and dispatches `vercel-booking-sqlite-v1` to
  `vercel-run.ts`. `run-lifecycle.ts` holds the shared executor core (budget,
  state transitions, source reading, model dispatch, ready-frame validation).
  `worker.ts` launches one container per trial and turns protocol violations and
  cleanup results into a typed `WorkerError`. `runtime.ts` builds the pinned
  images and lists the recipe files (`RUNTIME_FILES`) shipped by both distributions.
  Runs own disposable runtime images. Docker builds have a dedicated Buildx
  builder whose cache is removed after building; Podman disables intermediate
  image caching. Runtime images are removed when a run or campaign ends; expired
  images and builders left by a host that died are swept when the next runtime is
  prepared.
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
`runtimes/llmfy/`, `runtimes/vercel/` and `runtimes/fastapi/`.

Modules the browser bundles must stay free of `node:` imports: `constants.ts`,
`campaign-model.ts`, `campaign-evidence.ts`, `comparison.ts`, `profile.ts`,
`plan-model.ts`, `run-model.ts`, `provider-config.ts` and `budget.ts`. The page
imports only types from `run.ts`, `campaign.ts` and `plan.ts`.

## Storage

`src/storage/` owns the SQLite database used by the dashboard, including saved
provider connections. `database.ts` opens the file and
applies `migrations.ts` (an ordered list keyed by `user_version`).
`scan-repository.ts` keeps projects, scans, plans, the selected workspace and the
theme; `redteam-repository.ts` keeps runs, campaigns and run profiles and
recovers interrupted ones on open; `provider-repository.ts` keeps provider
connections and their sealed keys (`provider-secrets.ts`), including the sealed
ChatGPT OAuth session and the lease that serialises its refresh across
processes. `store.ts` is the
facade the dashboard uses. `security-repository.ts` stores repository settings,
scan jobs and current finding statuses. Migration 8 adds its tables without
replacing existing provider storage. Interrupted jobs become failed on open.
The coordinator imports earlier static history with its latest review once.
`review-repository.ts` and `evidence-repository.ts` retain source reviews and
redacted REA imports tied to the underlying static snapshot. `records.ts`
defines the persisted shapes that the dashboard contract re-exports.

Migration 9 adds provider model catalogs. `provider-repository.ts` stores only the
sanitized model list and an opaque connection fingerprint. `provider-secrets.ts`
derives the fingerprint from the provider, normalized endpoint and key using the
installation encryption key. Draft credentials are never saved with a catalog.

## The command line

`src/cli/index.ts` exposes only the default dashboard launcher, help, version
and explicit update. `dashboard.ts` parses launcher options and owns signal
handling. `update.ts` checks stable npm metadata in the background, caches it for
24 hours and installs a confirmed exact version only for an npm global install.
Private builds skip update checks and self-update. `UsageError` exits 2 and
operational failures exit 1. `io.ts` lets tests call `main()` directly.
`scripts/github-action.ts` is the composite Action entry. Its adapter in
`scripts/lib/github-action.ts` calls the engine directly and has no dependency
on the public dispatcher or update checks.

## The dashboard

The service in `src/dashboard/` binds `127.0.0.1`, issues a per-process token and
serves the built page from `dashboard/dist` in the npm package or checkout.
`server.ts` listens and dispatches through the explicit route table in
`routes/index.ts`; each file under `routes/` handles one area (session, state,
scan, history, folders, providers, security workspace, red-team, theme). `http.ts` holds the request
validators and `HttpError`, `security.ts` the headers and CSP, `operations.ts` the
supervisor that serialises long operations and cancellation, `static-assets.ts`
the asset serving, and `chatgpt-login.ts` the one browser sign-in a dashboard
runs at a time, exposing only its public progress through the provider routes.

`contract.ts` is the single contract between the service and the page: the `API`
route map, request and response types, the limits both sides enforce and the
theme markup both rewrite. It has no `node:` imports.

The page in `dashboard/src/security/` implements the Findings, Repositories and
Scans shell, job details, finding reports and scan forms. `app/App.tsx` exports
this shell. `providers/` retains the existing connection settings, `findings/`
supplies fix prompt and REA components, `api/` owns the fetch client, and
`shared/` owns UI primitives. The earlier overview, inventory, history and red-team
views were removed; they remain in Git history. `/redteam` renders its placeholder.
The red-team, campaign and plan HTTP routes remain for the internal API and
their tests, without a page client. Styles live in `styles/`; the
visual rules are in [design/dashboard-ui.md](design/dashboard-ui.md).

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
| Add a report format | `src/report/format.ts` |
| Add a CLI command or option | `src/cli/`, usage text in `src/cli/index.ts`, a case in `test/cli.test.ts` |
| Add a dashboard endpoint | `src/dashboard/contract.ts`, a handler in `src/dashboard/routes/`, `dashboard/src/api/client.ts`, a test in `test/dashboard-*.test.ts` |
| Add a red-team profile | `src/redteam/constants.ts`, a planner and an executor, a worker under `runtimes/`, `RUNTIME_FILES`, the schemas via `pnpm generate` |
| Change persisted data | a new entry in `src/storage/migrations.ts` and the matching repository |
