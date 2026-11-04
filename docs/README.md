# Documentation index

Start with [STATUS.md](STATUS.md). It states what is available, what is
qualified and what is pending. Every other page links there instead of
repeating milestone status.

## For users

| Read | When you want to |
| --- | --- |
| [guide/install.md](guide/install.md) | Install through npm, run with npx and start the dashboard |
| [guide/scanning.md](guide/scanning.md) | Understand static analysis: inventory, capabilities, findings and facts |
| [guide/ai-security-review.md](guide/ai-security-review.md) | Discover source-based AI findings, review all six STRIDE categories and inspect validation |
| [guide/rea-evidence.md](guide/rea-evidence.md) | Import external REA JavaScript/Electron evidence and select it for a fix prompt |
| [guide/reports-ci.md](guide/reports-ci.md) | Produce JSON, SARIF or Markdown reports; use baselines, suppressions, the CI gate and the GitHub Action |
| [guide/dashboard.md](guide/dashboard.md) | Use local repositories, background scans, finding triage, fix prompts and provider settings |
| [guide/redteam.md](guide/redteam.md) | Understand the retained red-team engine and container recipes |
| [RULES.md](RULES.md) | Look up a rule id, its severity, mapping and fix (generated; do not edit) |

## For contributors and reviewers

| Read | When you want to |
| --- | --- |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Set up the toolchain, run checks, add fixtures and rules, regenerate artefacts |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Understand the source layout and the flow from files to findings |
| [design/redteam-contracts.md](design/redteam-contracts.md) | The normative contracts for test packs, budgets, gates, coverage, statistics and isolation |
| [design/worker-protocol.md](design/worker-protocol.md) | The host to container message protocol of every runtime, the proof workers included |
| [design/redteam-engine.md](design/redteam-engine.md) | Engine internals: budget controller, project preparation, qualification broker |
| [design/llmfy-runtime.md](design/llmfy-runtime.md) | The llmfy container image, isolation checks and the synthetic qualification suite |
| [design/review-exploration.md](design/review-exploration.md) | Read-only exploration for the AI review (M9b): tools, limits, citations, failure handling; implemented as Explore mode |
| [design/strix-adoption.md](design/strix-adoption.md) | Ideas adopted from Strix for M10 and M11, the selection criteria and what is left out; M10 is implemented, M11 is in progress |
| [design/proof-tests.md](design/proof-tests.md) | Proof tests for M11: oracles, the harness, dependencies, measurement and checkpoints; M11a is implemented |
| [design/runtime-advisories.md](design/runtime-advisories.md) | Runtime advisories that read the PHP a repository declares (PLG001 to PLG003); implemented for PHP2Shell |
| [design/fastapi-profile.md](design/fastapi-profile.md) | The FastAPI project profile (M6b); checkpoint 1 was implemented and then removed; checkpoints 2 to 4 are design only |
| [design/generated-attacks.md](design/generated-attacks.md) | Attacker-generated, frozen attack corpora; checkpoint 1 (host templates) is implemented |
| [design/dashboard-ui.md](design/dashboard-ui.md) | Visual design rules for the dashboard |
| [design/distribution.md](design/distribution.md) | How the npm package is built and checked |
| [qualifications/](qualifications/) | Dated qualification records |
| [ROADMAP.md](ROADMAP.md) | Goals, principles, remaining M6 checkpoints, M7, M8, M9, M10, M11, risks |
| [history/m0-m5.md](history/m0-m5.md) | The completed milestones as recorded at completion |
| [../CHANGELOG.md](../CHANGELOG.md) | Changes per milestone |
| [../SECURITY.md](../SECURITY.md) | Execution policy and how to report an issue |

[licenses/](licenses/) holds the third-party licence texts bundled into the
npm package, with their provenance in `sources.json`.
