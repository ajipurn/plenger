# Instructions for coding agents

plenger is an npm package with a CLI and a local dashboard for security review of
any repository, modeled on Codex Security Cloud. The dashboard is the main journey:
a bounded AI source review with a second validation pass, STRIDE and findings.
Static triage is the agentic AI specialty for Python, JavaScript and TypeScript.
The public CLI starts the dashboard and provides confirmed npm updates. The
red-team engine and recipes remain internal. See docs/STATUS.md for their status.
The product direction is in [docs/ROADMAP.md](docs/ROADMAP.md#goal). Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the source layout and
[CONTRIBUTING.md](CONTRIBUTING.md) for the toolchain. This file lists the rules that
are easy to get wrong.

## Commands

```sh
source ~/.nvm/nvm.sh && nvm use     # Node 22; the shell default may be older
pnpm install --ignore-scripts
pnpm check                           # typecheck (engine, dashboard, docs), biome, vitest; must pass
pnpm dev [options]                   # launch the dashboard from source, no build step
pnpm dashboard                       # Vite dev server + local API with hot reload
pnpm docs:dev                        # documentation site dev server; see docs-site/README.md
pnpm generate                        # regenerate docs/RULES.md and schemas/*.json
pnpm bench -- --write                # regenerate test/fixtures/*/expected-*.json
pnpm evaluate                        # static detection on test/fixtures/evaluation; see CONTRIBUTING.md
```

## Rules

- **Erasable TypeScript only.** No enums, namespaces, parameter properties or
  `import x = require()`. Local imports end in `.ts`. `pnpm dev` runs the sources
  directly through Node type stripping.
- **Scanning never executes project code.** `src/scan.ts` and everything below it
  must only read files. Dynamic tests run only inside `src/redteam/` after an
  explicit start, in networkless containers.
- **Keep the layers one-directional.** `shared` depends on nothing in `src/`;
  `source` depends only on `shared`.
  `facts` → `project` → `inventory` → `capabilities` → `rules` → `report`
  depend downwards only; `platform` depends on `source` and `shared`, and `rules`
  reads it. `redteam` depends on the scan pipeline and `shared`, never on
  `storage`, `security`, `assessment` or `remediation`, which import it;
  `dashboard` and `cli` are adapters on top of everything and nothing
  imports them back. The browser bundle (`dashboard/src`) imports only
  `src/dashboard/contract.ts` and modules that have no `node:` imports
  (`redteam/{constants,model-pricing,provider-config}`, `rules/model`,
  `assessment/review-model`, `security/model`, `storage/records`, ...);
  adding a `node:` import to one of those breaks `pnpm dashboard:build`.
- **Generated files are never edited by hand.** `docs/RULES.md` and `schemas/*.json`
  come from `pnpm generate`; the golden files under `test/fixtures/*/expected-*.json`
  come from `pnpm bench -- --write`. Tests fail on drift. Review a golden diff line
  by line before accepting it.
- **Branch on language family exhaustively.** Choose per-family behavior with
  `byFamily(language, { python, javascript, php })` or a `Record<LanguageFamily, …>`
  table, never `language === "python" ? … : …`, so a new family is a compile error
  where it is undecided. A check that only one family has may test that family
  directly.
- **Constants live in one place.** Red-team limits, provider ids, run states and
  runtime pins are in `src/redteam/constants.ts`; the JSON schemas derive from
  them. Dashboard API paths, request/response types and UI limits are in
  `src/dashboard/contract.ts`. Do not re-type a literal that exists there.
- **Runtime recipes are listed once.** `RUNTIME_FILES` in `src/redteam/runtime.ts`
  drives the container build and the image digest. Adding a file under
  `runtimes/` means adding it there and to the runtime's Dockerfile.
- **Launcher errors map to exit codes in `src/cli/index.ts`.** Throw `UsageError`
  for invalid options (exit 2). Operational failures exit 1. Only the dashboard
  launcher, help, version and confirmed update are public. The GitHub Action calls
  the engine directly through `scripts/lib/github-action.ts`.
- **Secrets are redacted before anything is written.** Use `redact`/`redactReport`
  from `src/shared/secrets.ts`; never log API keys, and never store a key outside
  `src/storage/provider-secrets.ts`.
- **Tests.** Black-box tests call `main()` or `startDashboard()`; use the helpers
  in `test/support/` (`fixturePath`, `temporaryDir`, `stubProvider`, the dashboard
  harness) instead of copying setup code. Container-gated suites skip unless
  `PLENGER_TEST_LLMFY_IMAGE` / `PLENGER_TEST_VERCEL_IMAGE` are set.
- **Status lives in `docs/STATUS.md`.** Do not add "remains pending" sentences to
  other docs; link there. Docs are English, short sentences, no em-dashes.
- **Biome must pass with zero diagnostics.** Run `pnpm format` before finishing.
  Python under `runtimes/llmfy/` is not linted; keep it simple and keep the worker
  protocol in sync with [docs/design/worker-protocol.md](docs/design/worker-protocol.md).
- **Do not commit on the user's behalf** unless asked. Another agent (Codex) also
  works in this checkout; check `git status` and `git log` before resuming work.
