# Proof session and harness fix: scripted runs (2026-11-04)

Developer qualification of the M11b engine (`proofEntries`, `proofSession`) and of a
harness fix, with `pnpm qualify:proof` and the offline suites. No live model was
called and no API credentials were used; sessions used a scripted model.

| Item | Value |
| --- | --- |
| Host | macOS Apple silicon |
| Backend | Podman 6.0.2 (libkrun machine), `linux/arm64` |
| Python image | `sha256:7529eb0d085046e6723b59867d4f31c7e2a3c48b636f68963bca1636c72ab5f0` |
| Node image | `sha256:cd970c535f9d19425b6d4de80a03c9029b90a4ca65cf0294f099b7ef46f195d1` |
| Bases and packages | As in [proof-harness-2026-11-04.md](proof-harness-2026-11-04.md) |

## A false proof found and fixed

A test could move the working directory next to a guarded folder (`process.chdir`
in Node, `contextlib.chdir` in Python). A safe project's relative path then resolved
inside the guarded folder, and an ordinary read counted as a traversal. On the
M11a images (`sha256:f8ed0073…`, `sha256:2674a698…`) both new adversarial tests were
Proven: `env-root-python` and `ts-read-tool-no-separators`, both safe. The labeling
review of the corpus found the gap.

The harness now refuses a working-directory change by the test, watches the working
directory and `process.chdir` and `process.cwd` as changed code, and resolves paths
against the directory it saved before the test loaded. The text rules refuse
`chdir`. On the new images both tests are Not reproduced.

## Results

- `test/proof-runtime.test.ts`: 33 passed. The 16 handwritten cases as before; 12
  tests that try to fake a proof, none Proven; and 4 scripted sessions
  (`py-shell-tool`, `ts-route-git-log-exec` and their safe twins) that derive the
  entry from the scan and run in the real image, with the expected outcome each.
- `test/proof-entry.test.ts`: on all 62 labeled Python, JavaScript and TypeScript
  cases of CWE-22 and CWE-78, the derived entry holds the hand-labeled one; 56
  come from routes and tools, 6 from the public-function fallback.
- `test/proof-session.test.ts` and `test/proof-evaluation.test.ts`: the session's
  stops and limits, and the measurement's scoring, with a scripted model.

This qualifies the engine with scripted models. It does not measure a live model
writing tests; that is `pnpm evaluate --proof`, not yet run.
Status: [../STATUS.md](../STATUS.md).
