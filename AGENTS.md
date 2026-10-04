# Instructions for coding agents

plenger is a TypeScript CLI and local dashboard that statically triages agentic AI
projects and runs managed red-team campaigns in containers. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the source layout and
[CONTRIBUTING.md](CONTRIBUTING.md) for the toolchain. This file lists the rules that
are easy to get wrong.

## Commands

```sh
source ~/.nvm/nvm.sh && nvm use     # Node 22; the shell default may be older
pnpm install --ignore-scripts
pnpm check                           # typecheck (engine + dashboard), biome, vitest; must pass
pnpm dev <command> ...               # run the CLI from source, no build step
pnpm dashboard                       # Vite dev server + local API with hot reload
pnpm generate                        # regenerate docs/RULES.md and schemas/*.json
pnpm bench -- --write                # regenerate test/fixtures/*/expected-*.json
```

## Rules

- **Erasable TypeScript only.** No enums, namespaces, parameter properties or
  `import x = require()`. Local imports end in `.ts`. `pnpm dev` runs the sources
  directly through Node type stripping.
- **Scanning never executes project code.** `src/scan.ts` and everything below it
  must only read files. Dynamic tests run only inside `src/redteam/` after an
  explicit start, in networkless containers.
- **Keep the layers one-directional.** `shared` and `source` depend on nothing in
  `src/`. `facts` → `project` → `inventory` → `capabilities` → `rules` → `report`
  depend downwards only. `redteam` depends on the scan pipeline, `storage` and
  `shared`; `dashboard` and `cli` are adapters on top of everything and nothing
  imports them back. The browser bundle (`dashboard/src`) imports only
  `src/dashboard/contract.ts` and modules that have no `node:` imports
  (`redteam/{campaign-model,campaign-evidence,comparison,profile,constants,...}`);
  adding a `node:` import to one of those breaks `pnpm dashboard:build`.
- **Generated files are never edited by hand.** `docs/RULES.md` and `schemas/*.json`
  come from `pnpm generate`; the golden files under `test/fixtures/*/expected-*.json`
  come from `pnpm bench -- --write`. Tests fail on drift. Review a golden diff line
  by line before accepting it.
- **Constants live in one place.** Red-team limits, provider ids, run states and
  runtime pins are in `src/redteam/constants.ts`; the JSON schemas derive from
  them. Dashboard API paths, request/response types and UI limits are in
  `src/dashboard/contract.ts`. Do not re-type a literal that exists there.
- **Runtime recipes are listed once.** `RUNTIME_FILES` in `src/redteam/runtime.ts`
  drives both the container build and the binary bundle. Adding a file under
  `runtimes/` means adding it there and to the runtime's Dockerfile.
- **Errors map to exit codes in `src/cli/index.ts`.** Throw `UsageError` for bad
  command lines, `PolicyError` for bad policy files, `PreparationError` for
  red-team preparation problems. Each CLI command parses only its own options with
  `parseCommandArgs`.
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
