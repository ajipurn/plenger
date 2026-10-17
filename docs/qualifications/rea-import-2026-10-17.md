# REA import check 2026-10-17

This records the first real REA CLI exports fed to the REA importer
([guide/rea-evidence.md](../guide/rea-evidence.md)). Earlier tests used
contract-shaped synthetic fixtures. The check also asked whether REA output
adds anything to the source review. The importer was not changed.

- REA: CLI 6.4.0 (`rea --version`) on Node.js 24.21.0, provider
  `rea-javascript-application` version `1`.
- Importer: commit `ddb28b0`, `parseReaEvidence` from
  `src/evidence/import-rea.ts`, run on Node.js 22.23.2.
- Machine: macOS 27.0.1 on Apple Silicon, 8 GB memory.
- Command: `rea analyze-javascript-application <absolute path> --format json`,
  with default heap and timeout.

## Runs

| Target | JavaScript files parsed | Time | Peak resident memory | Export | Importer |
| --- | --- | --- | --- | --- | --- |
| This repository's working tree | 26,697, of which 26,070 under `node_modules/.pnpm` | 668.7 s | 1,407 MiB | 831.8 MiB | Not passed: about 416 times the 2 MiB limit |
| Tracked files at `ddb28b0` (`git archive`) | 347 | 19.2 s | 387 MiB | 29.5 MiB | Rejected: "The REA result is too complex" |
| `test/fixtures/frameworks/js` (11 files, 9,253 bytes) | 11 | 4.9 s | not measured | 1.75 MiB | Accepted |

REA does not apply `.gitignore` or skip dependency and build folders: the
working tree run parsed `node_modules`, `dist` and `dashboard/dist`. It wrote
nothing into the repository.

## Importer findings

Every contract check passed on the 347-file export: operation, predicate
type, provider id, subject and artifact digests, format, graph schema, id
patterns, observations, coverage rules and fact authority. Two bounds reject
it:

- **Size and complexity.** The importer measures the whole record before it
  discards the semantic graph. That graph was 22.9 MiB. The structural graph
  the importer keeps was 6.3 MiB: 4.0 MiB of nodes and 2.2 MiB of edges.
- **Limitations.** REA wrote 634 limitation strings; the importer accepts at
  most 256 and rejects the record instead of truncating the list.

With the size, value and depth bounds raised in memory, the semantic graph
removed and the limitations cut to 256, the record imported. The retained
projection was 6.27 MiB, still above the 2 MiB file limit.

## Content

The 347-file export held 1,222 nodes and 1,699 edges.

| Node kind | Count | Edge relation | Count |
| --- | --- | --- | --- |
| unknown (per-file parse scope) | 629 | contains | 1,061 |
| javascript-asset | 347 | imports | 577 |
| javascript-module | 189 | exposes | 53 |
| artifact | 45 | calls | 7 |
| endpoint | 7 | maps_to | 1 |
| package | 4 | | |
| electron-renderer | 1 | | |

- Every Electron count in the summary was 0: windows, preload entry points,
  context bridge APIs, IPC operations and native add-ons. plenger is not an
  Electron application.
- The seven endpoint nodes are labelled `repository`, `project`, `tab` and
  `scan`, without a method or path.
- The electron-renderer node is `dashboard/index.html`, which is not an
  Electron renderer.
- Asset nodes list each file's imports with locations; the static scan already
  extracts these.
- The semantic graph held functions from 26 of 347 modules. Coverage was
  partial: 309 files report that their relationships exceeded the result
  budget.

On the 11-file fixture REA reported the endpoints `/chat` and `/ask` without
methods. The static scan of the same fixture reports three entry points with
methods (`POST /api/chat` in a Next.js route, `POST /chat`, `POST /ask`), nine
tools, twelve LLM calls, one MCP server and ten findings.

## Conclusion

The importer's contract matches REA 6.4.0 output. Its bounds fit a small
fixture but not a project of a few hundred files. On a repository with source,
REA's output repeats what the static scan finds and adds noise, so it stays a
manual import for fix prompts and is not run during scans. Its planned
red-team roles are in [ROADMAP.md](../ROADMAP.md#m6-red-team-harness-direct-input-postponed).
Electron applications and ASAR archives, where REA's summary counts apply,
were not tested.

## Recheck after the bounds change

The importer now drops `raw_result` and the semantic graph before it measures
the record, accepts files up to 64 MiB with 16 MiB for the parts it reads and
500,000 values, and keeps 256 limitations per list with the rest counted in one
closing entry. Fed the same 347-file export (29.5 MiB) on 2026-10-17, still
with REA 6.4.0, `parseReaEvidence` accepted it: 1,222 nodes, 1,699 edges and
257 limitations, the last one counting those not kept. The working tree export
(831.8 MiB) stays above the file limit. The conclusion above does not change:
REA remains a manual import.
