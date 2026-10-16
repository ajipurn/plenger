# Documentation index

Start with [STATUS.md](STATUS.md). It states what is available, what is
qualified and what is pending. Every other page links there instead of
repeating milestone status.

## For users

| Read | When you want to |
| --- | --- |
| [guide/install.md](guide/install.md) | Install through npm, run with npx and start the dashboard |
| [guide/scanning.md](guide/scanning.md) | Understand `plenger scan` output: inventory, capabilities, findings, facts |
| [guide/assessment.md](guide/assessment.md) | Review scoped, redacted scan evidence with Claude and export a STRIDE assessment |
| [guide/ai-security-review.md](guide/ai-security-review.md) | Discover source-based AI findings, review all six STRIDE categories and inspect the second review |
| [guide/rea-evidence.md](guide/rea-evidence.md) | Import external REA JavaScript/Electron evidence and select it for a fix prompt |
| [guide/reports-ci.md](guide/reports-ci.md) | Produce JSON, SARIF or Markdown reports; use baselines, suppressions, the CI gate and the GitHub Action |
| [guide/dashboard.md](guide/dashboard.md) | Use local repositories, background scans, finding triage, fix prompts and provider settings |
| [guide/redteam.md](guide/redteam.md) | Run the managed red-team profiles from the CLI; campaigns, gates, comparisons |
| [RULES.md](RULES.md) | Look up a rule id, its severity, mapping and fix (generated; do not edit) |

## For contributors and reviewers

| Read | When you want to |
| --- | --- |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Set up the toolchain, run checks, add fixtures and rules, regenerate artefacts |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Understand the source layout and the flow from files to findings |
| [design/redteam-contracts.md](design/redteam-contracts.md) | The normative contracts for test packs, budgets, gates, coverage, statistics and isolation |
| [design/worker-protocol.md](design/worker-protocol.md) | The host to container message protocol of both runtimes |
| [design/redteam-engine.md](design/redteam-engine.md) | Engine internals: budget controller, project preparation, qualification broker |
| [design/llmfy-runtime.md](design/llmfy-runtime.md) | The llmfy container image, isolation checks and the synthetic qualification suite |
| [design/generated-attacks.md](design/generated-attacks.md) | Attacker-generated, frozen attack corpora; checkpoint 1 (host templates) is implemented |
| [design/dashboard-ui.md](design/dashboard-ui.md) | Visual design rules for the dashboard |
| [design/distribution.md](design/distribution.md) | How the npm package is built and checked |
| [qualifications/](qualifications/) | Dated qualification records |
| [ROADMAP.md](ROADMAP.md) | Goals, principles, remaining M6 checkpoints, M7, M8, risks |
| [history/m0-m5.md](history/m0-m5.md) | The completed milestones as recorded at completion |
| [../CHANGELOG.md](../CHANGELOG.md) | Changes per milestone |
| [../SECURITY.md](../SECURITY.md) | Execution policy and how to report an issue |

[licenses/](licenses/) holds the third-party licence texts bundled into the
npm package and optional binary, with their provenance in `sources.json`.
