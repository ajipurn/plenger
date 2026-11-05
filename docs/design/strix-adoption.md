# Ideas adopted from Strix (design)

Status: M10 is implemented and measured; M11 is in progress. The checkpoints
are [M10](../ROADMAP.md#m10-review-discipline-and-scope-done) and
[M11](../ROADMAP.md#m11-validation-by-execution-in-progress). What works and
what is qualified is in [../STATUS.md](../STATUS.md).

## Why

[Strix](https://github.com/usestrix/strix) is an open-source (Apache-2.0) agent
that tests applications and confirms findings by running a proof of concept.
Its white-box methodology overlaps with Plenger's AI review: closure rules for
candidates, severity calibration, a shared threat model, a coverage ledger and
diff-scoped review. This page records which of its ideas Plenger adopts, in
which form and in which order, and which it leaves out.

The summary below was taken from Strix's README, documentation and source at
commit `a3c3123` on `main` (2026-10-21). Strix changes quickly. Check the
source again before relying on a detail.

## How Strix works

- **Sandbox.** One Docker container per scan, shared by all agents of that scan.
  Local source is mounted under `/workspace`. The container has network access,
  extra network capabilities and a route to the host, so agents can reach
  running applications.
- **Agents.** Built on the OpenAI Agents SDK. The model is called from the host.
  Shell and file tools run inside the container.
- **Graph of agents.** A root agent creates child agents for subtasks. Each child
  carries up to five skills: Markdown knowledge files grouped by vulnerability
  class, framework, technology, scan mode and analysis method. Children report
  to their parent when they finish or stall.
- **Run ledgers.** Notes, a to-do list, one threat model per run and a coverage
  ledger. Coverage entries are the agents' own account and are labelled apart
  from what the runner observed.
- **Limits.** A maximum number of turns and a USD budget. At the budget the scan
  either stops or pauses until the user raises the limit.
- **Output.** A run folder, a local viewer and a non-interactive mode for CI,
  where a quick scan covers the changed files of a pull request.

## Selection criteria

An idea is adopted when it meets all three:

1. It adds detection value or evidence.
2. Scans stay read-only and local, and source leaves the machine only for the
   selected provider.
3. Its effect can be measured on the evaluation corpus or checked by an
   integration test.

## What Plenger already has

- **Counterevidence rules.** `VALIDATION_RULES` in
  `src/assessment/security-review.ts` lists which controls count, when they
  count and which checks do not. This is more specific than Strix's
  counterevidence skill. A dismissal names its control only in free text.
- **Observed coverage.** The host records the files sent and the files read.
- **STRIDE.** Every batch assesses all six categories.
- **Review context.** Up to 2,000 characters per project, reused by later scans.
- **Budgets.** Token or USD limits, Quick and Full coverage.
- **Isolated workers.** Host and container exchange JSON over stdio, with the
  container started with `--network=none`
  ([worker-protocol.md](worker-protocol.md)).

## Adopted

| Idea | Strix source | Checkpoint |
| --- | --- | --- |
| Severity calibration | `skills/analysis/severity_calibration.md` | M10a |
| Cited controls for dismissals | `skills/analysis/counterevidence.md` | M10a |
| Closure of every traced path | `tools/coverage`, `skills/analysis/counterevidence.md` | M10b |
| Framework review guides | `skills/frameworks`, `load_skill` | M10c |
| Project threat model | `tools/threat_model` | M10c |
| Change review in the dashboard | `skills/scan_modes/diff.md` | M10d |
| Change review in the GitHub Action | Non-interactive mode in CI | M10d |
| Continue a scan after its limit | Budget policy `pause` | M10e |
| Live activity | Terminal UI and viewer | M10e |
| Proof tests and retest | Proof of concept in a sandbox, `skills/analysis/fix_verification.md` | M11 |

### M10a Decision discipline

**Severity calibration.** Discovery instructions gain a rubric for each
severity and a checklist before high or critical: who can reach the path, which
preconditions it needs and what the impact is. A candidate that fails the
checklist is downgraded, not dropped. The prompt digest changes, so reviews
stay comparable by version.

Measurement: evaluation cases gain a `severity` label. Record agreement with
the label over three runs before and after the change. Precision and recall
must not drop.

**Cited controls for dismissals.** A dismissed decision gains a `basis`:
`control`, `unreachable`, `contradicted` or `duplicate`. The first three
require a citation that the host checks against the source the review supplied
or read. A duplicate names the other candidate id. A dismissal without a valid
citation becomes Needs review, and the limitation names the reason.

Measurement: over three runs, vulnerable cases dismissed by mistake must not
rise, and safe cases must still be dismissed.

### M10b Path closure

The static scan already lists traced paths: HTTP and MCP entry points that
reach an effect, tools with effects and model output that reaches an effect.
The host gives every path in a batch an id in the first message. The review
closes each one:

- `finding`: the id of the candidate that reports it.
- `safe`: a cited control or a cited reason the effect cannot be reached.
- `open`: what is missing to decide.

Paths the review does not close are listed as unclosed. Outputs show the table.
The list of paths is an observation by the host. The closure is the model's
account and is labelled as such. Files without a parser have no traced paths
and keep file coverage only.

Measurement: the share of paths closed per batch, recall on the cross-file
pairs, and no drop in precision.

### M10c Review guides and project threat model

**Framework guides.** Short guides written for code review, one per framework:
where authentication and middleware attach, which framework calls are safe by
default and which mistakes are common. The host selects guides from the
frameworks in the static inventory. Selection is deterministic and part of the
prompt digest. Explore mode could add a read-only tool that loads a guide for a
framework seen only in plain-text files; that tool is not built. Guides count
toward the request budget. Plenger writes its own guides. Strix's skills are
testing playbooks and serve only as a reference for which frameworks matter.

Measurement: precision and recall per framework with and without its guide.
A guide that does not help is removed.

Result: no guide helped. On the cases that got one, precision fell in both
modes, mostly through reports of routes without authentication and tools
without approval, the controls the guides pointed to. All guides were
removed; the
[record](../qualifications/detection-claude-haiku-2026-10-21-m10.md#framework-guides)
has the subsets. A later attempt needs corpus cases for each framework and
guides that do not invite reports of a missing control.

**Project threat model.** Full coverage derives architecture, assets, trust
boundaries and STRIDE again in every batch. Instead, the first batch derives a
project threat model and later batches receive it and only add to it. The model
is saved per project, shown on the project page and editable next to Review
context. The next scan starts from it. Each scan records which version it used.

Measurement: tokens per batch, consistency of trust boundaries across batches,
and detection on the corpus not lower than before.

### M10d Change review

Removed on 2026-10-25: plenger stays local-first for now, and the dashboard
reviews whole projects. The design stays here.

**In the dashboard.** New Scan gains a scope that reviews the changes since a
commit or branch. The static scan still covers the whole project. The AI review
receives the changed files and line ranges, plus their imports and callers
through `review-related.ts`. The instructions take over Strix's scope rules:

- A weakness the change introduces or reintroduces is in scope.
- An existing weakness that the change newly reaches is in scope.
- A shared helper, guard or wrapper that the change weakens is in scope, with
  each affected call site.
- A control that the change removes or narrows is in scope, even without new
  code at the sink.
- Unrelated existing weaknesses are out of scope. They are noted, not reported
  against the change.

Git can run external diff drivers and text conversion filters that the
project's configuration and attributes name. The design chooses between a
commit-to-commit diff with `--no-ext-diff --no-textconv` and the overrides in
`src/security/git.ts`, and an in-process diff of the base blob, read with
`git cat-file`, against the file on disk. Neither reads working-tree status.
Plenger uses the in-process diff.

**In the GitHub Action.** The Action runs from the repository's source, so it
does not wait for the npm release in M8. Model use stays opt-in:
an input names a provider, the key comes from a CI secret, and a token or USD
limit is required. The gate and SARIF inputs work as today. The workflow needs
the base commit, for example through `fetch-depth: 0`.

Measurement: new diff cases in the corpus, and an Action integration test with
the synthetic provider.

### M10e Long scans

**Continue after the limit.** A Full coverage scan that stopped at its limit can
continue with a new limit. Later batches skip files already sent whole and
continue excerpted files, as within one scan. The job records both limits.

**Live activity.** Scan details show a timeline while a job runs: batch, phase,
files read, tool calls and accounted tokens. It uses records the job already
writes.

Measurement: integration tests for continuation, and a browser check for the
timeline.

### M11 Validation by execution

Strix confirms a finding by running a proof of concept in a networked
container. Plenger's form is a **proof test**: a test that fails when the
weakness exists.

- **Verify.** An explicit start on a source-supported finding opens one
  session. The host copies the captured source into a container started with
  `--network=none`, as a non-root user, with a read-only root filesystem and
  time and memory limits. The model runs on the host. Its tools write one test
  file and run a fixed test command inside the container through the worker
  protocol. The outcome is one of:
  - **Proven**, with the test file, the command and its output.
  - **Not reproduced**. This is not evidence of safety.
  - **Could not run**, with the reason.
- **Retest.** After the user applies a fix, the same test runs against the new
  source. Strix's fix verification gates inform the checks: the weakness is
  gone and the test of the intended behaviour still passes.
- **Regression test.** The user can copy the test into the repository.
  Plenger does not write to the project.

Execution stays in `src/redteam/`, after an explicit start, as the scan rules
require. M11 changes the priority set on 2026-10-16, when red-team work was
postponed. It starts only after M10a and a reviewed design of its own.

Decisions that design must make. The draft that answers them is
[proof-tests.md](proof-tests.md).

1. **Dependencies.** Installing them needs network access and runs package
   scripts. Options: a separate install stage in its own container with
   registry-only egress, tests limited to modules without third-party imports,
   or an image the user supplies.
2. **Images.** Python and Node first, pinned and listed in `RUNTIME_FILES`.
3. **Finding types.** Start with effects a test can observe by calling a
   function directly: file access outside a base, observed through a canary
   file, and text that reaches a recording double for a command or a query.
4. **Measurement.** Evaluation cases that can run, with an expected outcome for
   both cases of a pair.

## Not adopted

| Strix feature | Reason |
| --- | --- |
| Testing live applications, URLs and domains; reconnaissance | Touches systems outside the user's checkout and needs network access in the sandbox |
| A sandbox image of offensive tools with network capabilities | Conflicts with networkless workers |
| An open-ended graph of agents | Hard to bound and to measure. Fixed roles (discovery, second review, proof test) are enough |
| Patches applied by the tool and automatic pull requests | The dashboard does not change code |
| External MCP servers inside the review | Source may leave the machine only for the selected provider |
| Hosted scans, continuous scanning, SSO and compliance reports | Plenger is local-first, with no hosted service |
| Notes and to-do tools | Explore sessions are short (12 and 6 model calls). Revisit if sessions grow |
| Strix's coverage and threat model tools as built | Plenger adopts the ideas in M10b and M10c, with host-derived paths and a saved project model |

## Order

M10a, M10b, M10c, M10d in the dashboard, M10e and the Action part of M10d,
then the M11 design and M11. Each checkpoint is reviewed and measured before
the next. Results are recorded in
[../STATUS.md](../STATUS.md) and [../qualifications/](../qualifications/).

## Open questions

- How many paths one batch can close before output limits matter, and whether
  closure needs its own request on large batches.
- Who labels severity for the existing evaluation cases, and how a disputed
  label is settled.
- Whether guides help languages without a parser, where the inventory cannot
  name the framework.
- Whether the project threat model replaces Review context or sits next to it.
