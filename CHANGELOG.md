# Changelog

All notable changes to plenger. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are
milestones from [docs/ROADMAP.md](docs/ROADMAP.md); there is no public release
yet. Current status is in [docs/STATUS.md](docs/STATUS.md).

## Unreleased

### Added

- Experimental ChatGPT subscription provider: Sign in with ChatGPT from the
  dashboard or `plenger redteam login`, OAuth credentials encrypted in the
  provider store with automatic refresh, and the public Responses API as the
  transport. Token thresholds are checked after each response rather than
  enforced by the model; budgets record this as `tokenLimitMode: "observed"`.
- Two more llmfy file-canary probes: `obscured-path` names the forbidden file
  through an equivalent path spelling, and `embedded-instruction` hides the
  forbidden write inside the content of an allowed note. Both use the existing
  completed-file-write oracle.
- Test-pack binding by observed semantics: discovery reports, per target,
  whether the file-canary pack applies (`packs`), based on a synchronous tool
  whose handler writes model-supplied content to a model-controlled path. A
  target without one shows the reason in the CLI and dashboard, and the run is
  blocked instead of spending model budget on a clean control that cannot pass.
- npm package `plenger-cli` with the `plenger` command: compiled CLI, built
  dashboard, grammars, schemas and red-team recipes. `pnpm build:package` and
  `pnpm test:package` build and check it; the npm package workflow runs the
  check on Linux, macOS and Windows.
- Apache License 2.0.
- Versioned worker frames: requests and `ready` frames carry
  `protocolVersion` 1, and the host and both runtimes refuse other values.

### Fixed

- `plenger redteam compare --help` prints the compare options again instead of
  the generic `redteam` usage.
- The installed CLI reports an unsupported Node.js version instead of failing
  on a missing built-in module.
- A worker whose host process died no longer runs on indefinitely under
  Docker. The llmfy worker exits after 130 seconds like the Vercel worker, and
  preparing a runtime removes containers past their `org.plenger.expires`
  label.
- `executeRun` forwards injected dependencies to the Next.js executor.
- Both executors redact run snapshots; the llmfy executor previously did not.
- Captured Next.js sources are hashed in code-unit order, so the source digest
  no longer depends on the locale.
- Both planners share one credential detector with the placeholder exemption.
- Worker failures are a typed `WorkerError`; a clean exit followed by a protocol
  error no longer reports cleanup as unconfirmed.
- Dashboard request errors use endpoint-neutral messages and one 409 wording;
  provider save failures other than validation return 500 instead of echoing the
  internal error.
- Project picker breadcrumbs split Windows paths on backslashes.

### Changed

- Campaign results in the dashboard: direct tool checks that accepted a
  prohibited change now appear as their own section with the observed change,
  arguments and recommended fix, placed before the model table instead of a
  notice that repeated the verdict. The verdict leads with the channel that
  failed, and rate cells below the comparison minimum read "Too few tests to
  estimate" instead of a bold percentage.
- CLI split into per-command modules under `src/cli/commands/`. Each command
  accepts only its own options; `plenger <command> --help` shows them, and
  `--version`/`--help` work after a command name. `plenger redteam` has the
  subcommands `discover`, `plan`, `run` and `compare`.
- Source layers reorganised: `src/shared/` (secrets, runtime assets, JSON,
  hashing, comparison, guards) and `src/source/` (files, languages, parser,
  reads) replace top-level modules; `src/inventory/modules.ts` moved to
  `src/project/`.
- Red-team engine restructured around campaigns (`campaign.ts`,
  `campaign-evidence.ts`, `campaign-report.ts`, `comparison.ts`) with
  versioned JSON schemas for runs, campaign plans, campaign evidence and
  comparisons. Types moved into `run-model.ts`, `campaign-model.ts` and
  `plan-model.ts`; the container launcher is `worker.ts`; the shared executor
  core is `run-lifecycle.ts`; every limit, id and runtime pin is in
  `constants.ts` and the JSON schemas derive from it. The Next.js modules are
  `vercel-plan.ts` and `vercel-run.ts`; the CLI commands moved to
  `src/cli/commands/redteam-run.ts` and `redteam-compare.ts`.
- SQLite persistence moved to `src/storage/` (ordered migrations, scan,
  red-team and provider repositories). The dashboard service is split into a
  route table (`src/dashboard/routes/`), request validators, security headers,
  static assets and an operation supervisor; `src/dashboard/contract.ts` is the
  single API contract shared with the page.
- Dashboard frontend reorganised into feature folders; new Providers,
  campaign results and comparison views.
- Documentation reorganised into `docs/guide/`, `docs/design/`,
  `docs/history/` and `docs/qualifications/`, with `docs/STATUS.md` as the
  single status page. Added `CONTRIBUTING.md`, `CHANGELOG.md` and
  `SECURITY.md`.
- `package.json` scripts `bench`, `docs:rules`, `schemas` and `generate` wrap
  the generator scripts.


## M6a/M6b/M6c preview and M8 preview (2026-10-04, f4e2242)

### Added

- Managed `vercel-booking-sqlite-v1` profile: captures a Next.js POST route
  handler and its import closure, prepares a disposable SQLite database,
  validates backend handlers directly and runs booking, price-override and
  zero-payment model trials with committed-snapshot evidence.
- Campaigns: fixed repetitions with fresh workers, one shared budget, per-case
  95% Wilson intervals, severity, execution-coverage and required-scope gates,
  exported non-secret profiles and `--api-key-env` for CI.
- `plenger redteam run` with terminal, JSON, Markdown and SARIF reports and
  private evidence under `<project>/.plenger/runs/`.
- `plenger redteam compare` for explicit before/after comparisons with
  fixed-configuration checks and minimum sample counts.
- Settings → Providers: named OpenAI, Gemini and Ollama connections with keys
  encrypted at rest; Gemini through its OpenAI-compatible transport.
- Persistent dashboard: SQLite stores scans, plans, runs, campaigns, provider
  settings and theme; refresh reconnects to active runs; Clear saved data.
- Docker support in the launcher, preferred over Podman when available.
- Scope matrix of discovered input, tool, MCP, web and retrieval surfaces,
  retaining unsupported and unselected entries.
- Qualification records: Autocare live run (2026-10-03), Docker llmfy
  qualification and scripted Next.js qualification (2026-10-04).

## M6a preview and M8 start (2026-10-03, c2bd4e4)

### Added

- React + Vite dashboard served by `plenger serve`: project picker with native
  folder chooser, scan overview, findings with evidence drawers, inventory
  browser, scan history, offline red-team preparation review and the managed
  llmfy file-canary run with model access, budgets and cancellation.
- Standalone executable (Node.js single executable application) bundling the
  CLI, dashboard, WASM grammars and runtime recipes, with `pnpm build:binary`,
  `pnpm test:binary`, SHA-256 checksums and `THIRD_PARTY_NOTICES.txt`.
- Native build, smoke-test and artifact workflow for Ubuntu, macOS and Windows.
- Shared `ModelBudget` controller and host-side qualification broker exercised
  through the networkless fixture.

## M6a foundations (2026-10-02, 9524bb5)

### Added

- `plenger redteam discover`: offline llmfy candidate discovery from the static
  inventory with reasons for unsupported shapes.
- `plenger redteam plan`: offline source-snapshot preparation with the
  `python-only-v1` policy, dependency declaration review and digests.
- llmfy runtime recipe (`runtimes/llmfy/`) with a digest-pinned image, hashed
  wheels, 18 isolation checks before import and the synthetic qualification
  suite run by `pnpm qualify:llmfy`.

## M5 review (2026-10-02, 1cfbd59)

### Fixed

- Redaction no longer rewrites plenger's own titles and evidence; only known
  secrets are redacted in generated text.
- SARIF for GitHub code scanning: `--source-root`, per-severity rule
  descriptors (`PLG302/low`), evidence as a code flow, suppressed findings left
  out by default, no local absolute paths.
- Third-party actions pinned to commit SHAs.

## M4 and M5: risk triage, reports and CI (2026-10-02, 19b4d82)

### Added

- 26 evidence-backed risk rules with OWASP LLM 2025, OWASP Agentic 2026 and
  CWE mappings, triage scores, evidence chains and stable fingerprints.
- Secret redaction across reports.
- Versioned JSON report (schema v1), SARIF 2.1.0 and Markdown formats;
  `--output`.
- Baselines (`--write-baseline`, `--baseline`), suppression files, `--fail-on`
  gate with exit code 3, and a composite GitHub Action.

## M3: cross-file links and capabilities (2026-10-02, b3beb03)

### Added

- Project linking of the project's own imports (Python absolute, relative and
  namespace packages; JS/TS relative paths, index files, CommonJS, tsconfig
  aliases) so inventory items attach across files.
- Capability analysis from tool handlers and HTTP entry points down to effect
  sinks, with call chains and bound inputs; agents roll up their tools.

## M2: agent inventory (2026-10-02, c67a4bc, 23c443e)

### Added

- Data-driven inventory of frameworks, models, LLM calls, agents, tools, MCP
  servers and clients, prompts, data stores and HTTP entry points.
- Detection for the OpenAI and Anthropic SDKs, Google GenAI, AWS Bedrock,
  LiteLLM, Ollama, Vercel AI SDK, LangChain/LangGraph, OpenAI Agents SDK,
  CrewAI, Pydantic AI, smolagents, AutoGen, LlamaIndex, Mastra, llmfy, MCP SDKs,
  FastAPI, Flask, Django, Express, Hono, Fastify and Next.js, with reviewed
  fixtures at precision and recall 1.0.

## M1: code facts (2026-10-01, 56acdef)

### Added

- `plenger facts`: imports, definitions, assignments and calls per file with
  call targets resolved to canonical names.
- `.gitignore` support in the walker (`--no-gitignore`); single-file roots.

## M0: foundation (2026-10-01, 8787833)

### Added

- `plenger scan` with a symlink-safe file walker, dependency and virtualenv
  exclusions, and web-tree-sitter parsing of Python, JavaScript, TypeScript and
  TSX with vendored WASM grammars.
- Supply-chain policy: three-day minimum release age, no install scripts.

The Python implementation that preceded this rewrite (v0) is kept on the
`feat/backup` branch.
