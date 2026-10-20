# Status

This page is the single source of truth for what plenger can do today, what has
been qualified and what is pending. Other documents link here instead of
repeating milestone status. Last reviewed: 2026-10-20.

## Milestones

| Milestone | State | Summary |
| --- | --- | --- |
| M0 to M5: static triage, reports and CI | Done | See [history/m0-m5.md](history/m0-m5.md) |
| M6a: click-to-run llmfy | Postponed | Managed `llmfy-file-canary-v1` profile runs with one live-model record on the bundled fixture; a live run on a team project and billed-token accounting pending |
| M6b: HTTP and project expansion | Postponed | Managed `vercel-booking-sqlite-v1` profile runs with one live-model record. The FastAPI project profile has its preparation stage (`plenger redteam prepare`); its case packs are pending. See [design/fastapi-profile.md](design/fastapi-profile.md) |
| M6c: MCP and CI | Postponed | Campaigns, statistics, gates, comparisons and CLI reports exist; MCP adapter pending |
| M7: indirect prompt injection | Postponed | See [ROADMAP.md](ROADMAP.md#m7-red-team-indirect-prompt-injection-postponed) |
| M8: distribution | In progress | npm package checks pass in CI on Linux, macOS and Windows; public release pending. The standalone binary was dropped |
| M9: review for any language | In progress | M9a done: dashboard reviews read text files in any language, templates and configuration as plain text. M9b in progress: Explore mode, where the model reads the allowlist through read-only tools, works on Claude for Quick scans, with Unvalidated candidates in both modes and `pnpm evaluate --mode`. A three-run comparison on Claude Haiku 5.5 meets the acceptance on the evaluation corpus: recall not lower than Batch, higher precision on the cross-file pairs ([record](qualifications/detection-claude-haiku-2026-10-17-cross-file.md)). Explore now also runs Full coverage, caches each turn on Claude, shows its read log in Outputs and is the New Scan default for Claude connections; OpenAI, Gemini, Ollama and ChatGPT can use it with plain function tools, tested offline only. A first trial on three open-source projects is [recorded](qualifications/review-real-projects-2026-10-19.md). Live runs on other transports and a measured Full coverage scan are pending. See [design/review-exploration.md](design/review-exploration.md) and [ROADMAP.md](ROADMAP.md#m9-review-for-any-language-in-progress) |

## Capability matrix

| Capability | State | Notes |
| --- | --- | --- |
| Static scan of Python, JavaScript and TypeScript | Available | Inventory, capabilities, 40 risk rules, seven of them for request input in web routes (FastAPI, Flask, Django, Starlette, aiohttp, Express, Fastify, Hono, Koa, NestJS, Next.js) reaching a command, a file path, SQL text, a URL's host, code, a template or a deserializer across modules; never executes project code. Checks before an effect are read: fixed allowlists, equality, lookups into fixed tables and host allowlists, and for file paths name patterns, `..` checks with `/` or absolute-path checks, and resolved paths kept inside a base, also when a project function returns the path after that check or is a check helper that returns true only for a confined path. Calls into project functions carry only what their return values use; database lookups carry nothing of the values they are found by. File names with no separators that are never `.` or `..` (`secure_filename`, a name with fixed text), and absolute paths among program arguments, carry nothing. `plenger-ignore` comments suppress findings in the source. JSX that the JavaScript grammar rejects is parsed again; larger projects parse on worker threads. Calls through fixed tables of functions, pathlib joins and methods on parenthesized expressions are followed, and a project's own tool base classes are detected. Handler traces cut by the depth limit or dynamic calls are reported. Compiled files are listed with size and SHA-256, not analysed. `scan --library` counts the parameters of a package's public functions and methods as untrusted input, reported by seven more rules at medium or low confidence; a path or URL whose start the caller passes is not reported. CLI only. [guide/scanning.md](guide/scanning.md) |
| Reports: terminal, JSON v1, SARIF 2.1.0, Markdown | Available | Baselines, suppressions, `--fail-on` gate, exit codes. [guide/reports-ci.md](guide/reports-ci.md) |
| GitHub Action (composite) | Available | Runs on GitHub-hosted runners in the repository's CI workflow and writes SARIF. Uploading that SARIF to code scanning is left to the calling workflow and has not been exercised |
| Local dashboard (`plenger serve`) | Available | Findings, local Projects, manually started Scans, full finding reports and existing provider settings. [guide/dashboard.md](guide/dashboard.md) |
| Dashboard Red-team page | Postponed | Legacy URL shows a placeholder. It is outside the three main workspace tabs and exposes no testing controls |
| npm package | Available locally | Compiled CLI, built dashboard, grammars, schemas and red-team recipes in one tarball. [guide/install.md](guide/install.md) |
| `redteam discover` and `redteam plan` (offline) | Available | llmfy function/factory discovery; Python source and Next.js route preparation plans |
| Red-team profile `llmfy-file-canary-v1` | Available, one live-model record | A clean control and four fixed file-canary probes, bound to targets by observed file-write semantics. One live run on the bundled fixture; see qualification records below |
| Red-team profile `vercel-booking-sqlite-v1` | Available, one live-model record | Backend checks plus three model trials against a disposable SQLite database |
| FastAPI project profile `fastapi-llmfy-v1` | Preparation stage only, one record | Builds the project's declared dependencies from wheels, starts disposable MySQL and Redis on a private network, imports the application with llmfy 0.6.0 model classes routed to the broker and probes `GET /`. No cases, no model calls. Qualified once on the Dayatech assessment center; see below |
| `redteam run` (CLI campaigns) | Available | Fixed repetitions, shared budget, Wilson intervals, severity/coverage/scope gates, profile export. [guide/redteam.md](guide/redteam.md) |
| `redteam compare` (before/after) | Available | Fixed-configuration checks, 20 usable trials per case per build |
| Saved providers (OpenAI, Gemini, Ollama, Anthropic Claude) | Available | Keys encrypted at rest in SQLite; never sent to workers or included in reports. Claude uses the native Messages API |
| Claude scan cost estimates and model selection | Offline integration tests pass | Per-model manual USD prices for input, output, cache writes and hits, plus an optional long-prompt tier. Per-request accounting and saved price snapshots. New Scan selects a model independently of the provider default. Synthetic browser flow checked; invoice reconciliation is not implemented. [guide/dashboard.md](guide/dashboard.md#claude-model-pricing) |
| Claude defensive assessments (`assess`) | Offline tests pass | One bounded request over redacted scan facts and snippets. Structured STRIDE output, checked file/line scope, refusal stops and audit metadata. Live Anthropic qualification pending. [guide/assessment.md](guide/assessment.md) |
| Source-based AI security review and STRIDE | Offline protocol tests pass; live records | Python, JavaScript and TypeScript plus, in dashboard scans, text files in any other language, templates and configuration, read as plain text and sent in line windows when large. Source ordered by the scan's traced paths in a bounded context sized to known model windows within the token ceiling, with function excerpts of files that do not fit, all six STRIDE categories, independent candidate discovery and a second source review that also reads imports and callers of cited files, optionally on a separate model. Quick (one batch) and Full coverage (batches until the source is covered or a token or USD limit is reached), saved history, checked citations, source excerpts and fix prompts. A CWE id per finding. Explore mode (Quick and Full coverage, the default for Claude; offline tests on every transport, live runs on Claude): the model reads the allowlist through four read-only tools and answers through strict submit tools. A second review that stops keeps its candidates as Unvalidated. Native Claude structured outputs, canonical enum spelling and safe field diagnostics. Synthetic providers tested; live detection records on the evaluation corpus (Claude Haiku 5.5), the latest on 92 cases, three runs per mode; other models, other transports in Explore mode and real projects pending. [guide/ai-security-review.md](guide/ai-security-review.md) |
| Automatic and remote repository scanning | Unavailable | The dashboard scans local folders after an explicit start. Git is optional. Continuous requests are rejected and earlier saved monitors are disabled on startup. GitHub connections and hosted scanning are not implemented. [guide/dashboard.md](guide/dashboard.md#manual-local-scans) |
| Finding triage and workspace migration | Offline integration tests pass | Five saved workflow statuses, matching-fingerprint persistence across rescans, earlier static history imported with its latest review, provider keys retained |
| Coding agent fix prompts | Offline tests pass | Generate instructions for one saved static or AI review finding through an explicitly selected provider. Copy the prompt into a coding agent; no agent execution or code edits. Live provider qualification pending. [guide/dashboard.md](guide/dashboard.md#generate-a-fix-prompt) |
| REA JavaScript/Electron JSON imports | Offline tests pass; one live record | Redacted evidence tied to one saved scan, reported provenance and coverage, explicit selection for fix prompts. Real REA 6.4.0 exports of an 11-file fixture and a 347-file project import; files up to 64 MiB, with the semantic graph dropped before the bounds apply. REA runs only by hand; scans do not start it. [guide/rea-evidence.md](guide/rea-evidence.md) |
| ChatGPT subscription provider | Experimental | Native Sign in with ChatGPT, encrypted OAuth storage, text/function Responses transport and observed token thresholds. Offline protocol tests cover authentication and accounting; one live llmfy run recorded on 2026-10-06. Live qualification on a team project pending. |
| Container runtime | Available | Docker preferred, Podman fallback; networkless, non-root workers. [design/llmfy-runtime.md](design/llmfy-runtime.md) |
| Trial input templates | Available | Generated-attacks checkpoint 1: built-in controls and probes are host templates in `attack-model.ts`, filled per trial; the Vercel worker fills the booking it seeds and the host checks the delivered text. Same text as before; synthetic container suites rerun on Docker on 2026-10-06. [design/generated-attacks.md](design/generated-attacks.md) |
| Attacker and judge model roles | Planned | Managed runs configure the target model only; generated attacks are designed in [design/generated-attacks.md](design/generated-attacks.md) |
| General HTTP and MCP adapters | Planned | M6b/M6c |
| Indirect injection channels | Planned | M7 |
| Worker protocol version | Available | Request and `ready` frames carry `protocolVersion` 2; the host and all three runtimes refuse other values. [design/worker-protocol.md](design/worker-protocol.md#version) |

## npm distribution

npm is the primary installation method. The CLI includes `scan`, `serve` and
`redteam`. Users need Node.js 22.18 or newer. The installed dashboard uses the
built frontend without a separate build. Red-team runs still need Docker or
Podman.

| Package or platform | State |
| --- | --- |
| Package name | `plenger` with the `plenger` command; the `@plenger` npm organisation is registered. The private dashboard workspace is `@plenger/dashboard` |
| Local npm tarball | Built and installed on macOS Apple Silicon with Node.js 22.23.2 and npm 10.9.8 |
| Installed CLI and dashboard | Global install, npm exec, all four grammars, offline Next.js planning and authenticated dashboard scans checked locally |
| Linux, macOS and Windows CI | Installed-package jobs in [package.yml](../.github/workflows/package.yml) passed on Ubuntu 24.04, macOS 15 and Windows 2022 with Node.js 22.18.0 (commit `3f00c03`, 2026-10-04) |
| Public npm registry release | Not published; `private: true` blocks publishing |
| Project licence | Apache-2.0, see [LICENSE](../LICENSE) |

## Qualified versus pending

Qualified means a recorded run on a stated date, image and configuration.
Records live in [qualifications/](qualifications/).

| Profile or path | Qualified | Pending |
| --- | --- | --- |
| llmfy runtime, synthetic model (Podman) | [2026-10-02](qualifications/llmfy-synthetic-2026-10-02.md) | Live-model run on an unmodified project |
| llmfy runtime, synthetic model (Docker) | [2026-10-04](qualifications/llmfy-docker-2026-10-04.md); protocol version and host-death cleanup [2026-10-04](qualifications/worker-lifecycle-docker-2026-10-04.md) | Host-death check on Podman |
| llmfy file canary, live model | [2026-10-06, bundled fixture, ChatGPT `gpt-6.1-sol`](qualifications/llmfy-chatgpt-live-2026-10-06.md) | Live run on an unmodified team project (the candidate project is outside the profile); enforced token accounting against a billed provider; repetition-based estimates |
| Next.js booking profile, scripted model | [2026-10-04](qualifications/vercel-synthetic-2026-10-04.md) | Other models, backends and platforms |
| Next.js booking profile, live model | [2026-10-03, Autocare, `gemma4:31b-cloud`](qualifications/autocare-live-2026-10-03.md) | Repetition-based success-rate estimates |
| FastAPI profile, build and import (checkpoint 1) | [2026-10-06, Dayatech assessment center, Docker, `linux/amd64`](qualifications/fastapi-prepare-dayatech-2026-10-06.md) | Podman; case packs, broker calls and oracles (checkpoints 2 to 4) |
| AI review, evaluation corpus, live model | [2026-10-17, Claude Haiku 5.5, 92 cases with three pairs whose deciding file is outside the first message, three runs per mode: Batch precision 0.80, recall 0.91, labeled weakness 0.91 and 0.89; Explore 0.81 and 0.97, labeled weakness 0.94 and 0.93; on the new pairs, labeled weakness 0.50 and 0.33 in Batch, 1.00 and 1.00 in Explore](qualifications/detection-claude-haiku-2026-10-17-cross-file.md); [86 cases, one run per mode with the discovery noise rules](qualifications/detection-claude-haiku-2026-10-17-explore.md); [weakness-matched baseline](qualifications/detection-claude-haiku-2026-10-17-cwe.md); [calibrated second review, 3 runs](qualifications/detection-claude-haiku-2026-10-17-validation.md); [82-case baseline, 3 runs](qualifications/detection-claude-haiku-2026-10-17.md); earlier [2026-10-16, 16 cases](qualifications/detection-claude-haiku-2026-10-16.md) | Other models, separate second-review model, Full coverage, real projects; a rerun after the fix for replies with more than eight tool calls |
| Static rules, evaluation corpus | [2026-10-21, 126 labeled cases, precision 1.00, recall 0.89 with `torch.load(weights_only=True)`, pathlib text members, `re.fullmatch`, chained `str.replace` and checks on Flask request variables read; advisory results unchanged](qualifications/detection-static-2026-10-21.md); [2026-10-20, library scans: 20 of 105 reviewed advisories reported before the fix against 4 in a default scan, 15 of them still after it; 18 library cases, precision 1.00, recall 1.00; default results unchanged](qualifications/detection-static-2026-10-20-library.md); [2026-10-20, 118 labeled cases, precision 1.00, recall 0.88, six open-source projects and 105 reviewed advisories](qualifications/detection-static-2026-10-20-advisories.md); [2026-10-20, 106 labeled cases, precision 1.00, recall 0.87 with return-value summaries and check helpers](qualifications/detection-static-2026-10-20.md); [2026-10-19, 102 labeled cases, precision 1.00, recall 0.87 with the web route rules](qualifications/detection-static-2026-10-19.md); [2026-10-17, 72 labeled cases covering all 26 rules then, precision 1.00, recall 0.97; six open-source projects scanned](qualifications/detection-static-2026-10-17.md); earlier [2026-10-16](qualifications/detection-static-2026-10-16.md) | Second-order flows and constructor arguments kept on `self`, which most remaining advisories need; whole-package scans in the advisory benchmark; projects built on their own agent framework |
| REA import, live CLI export | [2026-10-17, REA 6.4.0: 11-file fixture imports; the 347-file project, rejected at first, imports after the bounds change](qualifications/rea-import-2026-10-17.md) | Exports above 64 MiB, such as a working tree with dependencies; Electron applications and ASAR archives |
| npm package smoke test | macOS Apple Silicon locally (Node.js 22.23.2, npm 10.9.8); Ubuntu 24.04, macOS 15 and Windows 2022 in CI (Node.js 22.18.0) | Intel macOS and other Node.js versions |

Every qualification used bundled fixtures, the evaluation corpus or a few named
projects. None establishes support for arbitrary projects, provider billing caps or
protection against malicious project code.

## Exit codes at a glance

| Command | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| `scan` | Completed, gate passed or disabled | Scan or I/O error | Invalid arguments or policy | New unsuppressed findings met `--fail-on` |
| `redteam discover`, `redteam plan` | Report produced | I/O or scan error | Invalid arguments or target | Not used |
| `redteam run` | Completed, all enabled gates passed | Execution, budget, coverage or scope failure | Invalid configuration | Observed finding met the severity gate |
| `redteam compare` | Eligible comparison, gates passed | Incomplete or incompatible comparison | Invalid report or arguments | After-campaign finding gate failed |
