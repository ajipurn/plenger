# Status

This page is the single source of truth for what plenger can do today, what has
been qualified and what is pending. Other documents link here instead of
repeating milestone status. Last reviewed: 2026-10-04.

## Milestones

| Milestone | State | Summary |
| --- | --- | --- |
| M0 to M5: static triage, reports and CI | Done | See [history/m0-m5.md](history/m0-m5.md) |
| M6a: click-to-run llmfy | In progress | Managed `llmfy-file-canary-v1` profile runs; live-model qualification pending |
| M6b: HTTP and project expansion | In progress | Managed `vercel-booking-sqlite-v1` profile runs with one live-model record; broader profiles pending |
| M6c: MCP and CI | Partly delivered | Campaigns, statistics, gates, comparisons and CLI reports exist; MCP adapter pending |
| M7: indirect prompt injection | Planned | See [ROADMAP.md](ROADMAP.md#m7-red-team-indirect-prompt-injection-planned) |
| M8: distribution | In progress | Binary builds locally; native CI configured; no public release or licence yet |

## Capability matrix

| Capability | State | Notes |
| --- | --- | --- |
| Static scan of Python, JavaScript and TypeScript | Available | Inventory, capabilities, 26 risk rules; never executes project code. [guide/scanning.md](guide/scanning.md) |
| Reports: terminal, JSON v1, SARIF 2.1.0, Markdown | Available | Baselines, suppressions, `--fail-on` gate, exit codes. [guide/reports-ci.md](guide/reports-ci.md) |
| GitHub Action (composite) | Available, unverified remotely | Tested locally and in the repository's own CI workflow; a hosted code-scanning upload has not run because this checkout has no remote |
| Local dashboard (`plenger serve`) | Available | Scans, inventory, findings, history, providers, red-team runs, campaigns and comparisons. [guide/dashboard.md](guide/dashboard.md) |
| `redteam discover` and `redteam plan` (offline) | Available | llmfy function/factory discovery; Python source and Next.js route preparation plans |
| Red-team profile `llmfy-file-canary-v1` | Available, synthetic qualification only | Three fixed file-canary checks; see qualification records below |
| Red-team profile `vercel-booking-sqlite-v1` | Available, one live-model record | Backend checks plus three model trials against a disposable SQLite database |
| `redteam run` (CLI campaigns) | Available | Fixed repetitions, shared budget, Wilson intervals, severity/coverage/scope gates, profile export. [guide/redteam.md](guide/redteam.md) |
| `redteam compare` (before/after) | Available | Fixed-configuration checks, 20 usable trials per case per build |
| Saved providers (OpenAI, Gemini, Ollama) | Available | Keys encrypted at rest in SQLite; never sent to workers or included in reports |
| Container runtime | Available | Docker preferred, Podman fallback; networkless, non-root workers. [design/llmfy-runtime.md](design/llmfy-runtime.md) |
| Attacker and judge model roles | Planned | Today's providers configure the target model only |
| General HTTP and MCP adapters | Planned | M6b/M6c |
| Indirect injection channels | Planned | M7 |
| Worker protocol version field | Gap | Compatibility relies on runtime versions in the `ready` frame. [design/worker-protocol.md](design/worker-protocol.md) |

## Binary per platform

| Platform | State |
| --- | --- |
| macOS Apple Silicon (`darwin-arm64`) | Built and smoke-tested locally with Node.js 22.23.2 |
| Ubuntu 24.04, macOS 15, Windows 2022 | Build, smoke-test and artifact jobs configured in [binary.yml](../.github/workflows/binary.yml); remote runs not yet observed |
| Public release download, npm package | Not available |
| Publisher signing, notarization | Not done; macOS builds carry an ad-hoc signature |
| Project licence | Not chosen |

See [design/distribution.md](design/distribution.md) and
[guide/install.md](guide/install.md).

## Qualified versus pending

Qualified means a recorded run on a stated date, image and configuration.
Records live in [qualifications/](qualifications/).

| Profile or path | Qualified | Pending |
| --- | --- | --- |
| llmfy runtime, synthetic model (Podman) | [2026-10-02](qualifications/llmfy-synthetic-2026-10-02.md) | Live-model run on an unmodified project |
| llmfy runtime, synthetic model (Docker) | [2026-10-04](qualifications/llmfy-docker-2026-10-04.md) | Abrupt host-process death and Docker cleanup after it |
| Next.js booking profile, scripted model | [2026-10-04](qualifications/vercel-synthetic-2026-10-04.md) | Other models, backends and platforms |
| Next.js booking profile, live model | [2026-10-03, Autocare, `gemma4:31b-cloud`](qualifications/autocare-live-2026-10-03.md) | Repetition-based success-rate estimates |
| Binary smoke test | macOS Apple Silicon, local | Linux, Windows and Intel macOS evidence |

Every qualification used the bundled fixture or one user project. None
establishes support for arbitrary projects, provider billing caps or protection
against malicious project code.

## Exit codes at a glance

| Command | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| `scan` | Completed, gate passed or disabled | Scan or I/O error | Invalid arguments or policy | New unsuppressed findings met `--fail-on` |
| `redteam discover`, `redteam plan` | Report produced | I/O or scan error | Invalid arguments or target | Not used |
| `redteam run` | Completed, all enabled gates passed | Execution, budget, coverage or scope failure | Invalid configuration | Observed finding met the severity gate |
| `redteam compare` | Eligible comparison, gates passed | Incomplete or incompatible comparison | Invalid report or arguments | After-campaign finding gate failed |
