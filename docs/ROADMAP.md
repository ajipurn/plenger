# Roadmap

Current capabilities, qualifications and pending work are in [STATUS.md](STATUS.md).
The completed milestones M0 to M5 are recorded in [history/m0-m5.md](history/m0-m5.md).
The normative M6 contracts are in [design/redteam-contracts.md](design/redteam-contracts.md).
This page keeps the goal, principles, stack, the remaining M6 checkpoints, M7,
M8, M9, M10, M11, risks and the work beyond the MVP.

## Goal

Give developers a local repository security review modeled on the supplied
Codex Security Cloud references: Findings, Projects, Scans, detailed source
evidence, STRIDE threat modeling and a prompt that a coding agent can use to
fix a selected finding. The users are the author, other developers and their
coworkers. Each person runs the npm package on their own machine with their
own model connection. There is no hosted service, account system or
multi-tenant deployment.

Plenger reviews any repository, not only agentic AI projects. Its main
journey is the local dashboard, opened with `plenger`. The first
source is local folders. A scan combines offline static triage with bounded
LLM source discovery and skeptical validation. Provider settings remain
configurable. Source leaves the machine only for the selected provider, after
redaction and within a budget. Findings keep triage state, scan provenance and
remediation evidence.

Agentic AI is the specialty, not the boundary. Static rules keep their
agent-specific coverage: where untrusted text enters a prompt, which tools and
effects a request or a model output can reach, and which approvals are
missing. They show what a manipulated agent could do. They do not prove that
an injection succeeds; that needs dynamic tests.

The AI review is the general engine. It reads text files in any language.
Python, JavaScript and TypeScript also get static facts, which order the files
along traced paths and excerpt them by function; other files are read as plain
text. [M9](#m9-review-for-any-language-done) added read-only exploration
by the model. Static parsing stays with the three languages.
[M10](#m10-review-discipline-and-scope-done) adopted review ideas from Strix
that need no execution.

Validation is a second model review of the source. Validation by execution,
reproducing a finding in a sandbox, is planned as
[M11](#m11-validation-by-execution-planned) and builds on the red-team
containers. Red-team work (M6 and M7) is postponed. The
existing managed profiles stay available from the CLI, and the retained
direction and contracts below describe that engine rather than the workspace.

The repair action generates instructions after a finding exists. Users choose
when to hand those instructions to their coding agent. The dashboard does not
execute the agent or apply patches. Scans start manually; continuous scanning
is not part of the current journey. Availability and qualification are
recorded in [STATUS.md](STATUS.md).

### Red-team capability target

[Promptfoo's red-team architecture](https://www.promptfoo.dev/docs/red-team/architecture/)
separates vulnerability-specific cases from attack delivery strategies, and its
[setup workflow](https://www.promptfoo.dev/docs/red-team/quickstart/) treats
application context, target configuration and test selection as one journey.
The intended flow is: choose a project or endpoint → review the target and
application policy → select risks and strategies → review scope and budget →
Start → inspect outcomes and evidence → save cases and retest a fix.

| Capability | Plenger target | Delivery |
| --- | --- | --- |
| Targets and application context | Project, endpoint or model target with purpose, permitted actions, access and observable scope saved in a profile | Two managed project profiles exist; M6a/M6b qualify and broaden them, M6c adds MCP |
| Risk catalogue | Versioned cases for injection, data leakage, unauthorised tool use, access boundaries and application policy; source evidence suggests relevant cases | Fixed file-canary and booking/payment cases exist; broader packs in M6, indirect injection in M7, then the wider catalogue |
| Attack strategies | Delivery separate from the risk: direct input, transformed inputs, adaptive attempts, multi-turn, lower-trust content | Direct fixed prompts exist; M7 adds indirect delivery; transformations, adaptive and multi-turn are beyond the MVP |
| Attack generation and grading | Optional attacker LLM; deterministic oracles with an optional judge LLM | Fixed attacks and deterministic observations exist; attacker and judge roles are planned |
| Campaigns and evidence | Progress, cancellation, shared budgets, clean controls, scoped conclusions, observed effects | Delivered for the two profiles, including saved providers, repetitions, statistics, profiles and CLI gates |
| Security regression | Save a failure as a reusable case, rerun against a fix, compare across builds, gate CI | Saved campaigns exist; before/after comparisons were removed on 2026-10-21 and return with a dashboard adapter; reusable custom suites are planned |

Within managed red-team runs, target, attacker and judge models are distinct
roles; choosing a provider configures the target model only. The sequence is: qualify M6a, broaden
M6b, complete M6c, then M7, then the generated, adaptive, multi-turn and
grading work as explicit checkpoints. One step was brought forward on
2026-10-06: checkpoint 1 of [design/generated-attacks.md](design/generated-attacks.md),
attack templates on the host, ships during M6 because it changes no case text
or result and M7 reuses it.

## Principles

These come from what went wrong in v0, the earlier Python implementation,
where trust and isolation infrastructure grew far ahead of what the tool could
detect.

1. **Detection value first.** Add infrastructure only when a feature needs it.
2. **Static triage never executes, imports or installs project code** and needs
   no network.
3. **Evidence or it did not happen.** Static findings cite file, line and
   snippet with their confidence; dynamic results identify the trial and the
   observed evidence. Missing detections or observations are reported, never
   presented as proof that a risk is absent.
4. **Measured accuracy.** Every detector and rule has a fixture corpus with
   expected results; precision and recall are reported, not assumed.
5. **Reproducible evidence.** Static scans and plans are deterministic apart
   from timing. Dynamic runs record configuration, inputs and observations;
   model responses vary, so trials are repeated with their denominators.
6. **Few dependencies.** Pinned, aged at least three days, no install scripts.
7. **Dynamic testing is explicit.** Only Start or an explicit CLI run contacts
   selected targets the user owns or is authorised to test, through a
   plenger-managed adapter and runtime. Built-in probes use synthetic data,
   canaries and test doubles for side effects.
8. **Integration work belongs to plenger.** Built-in tests work without
   application edits or user-authored harness code. Users are asked only for
   choices or access the tool cannot infer.

## Stack

Node.js 22.23.4+ (or 24.22.1+, 26.12.1+) and TypeScript (strict, erasable
syntax only), web-tree-sitter
with vendored WASM grammars for Python, JavaScript, TypeScript and TSX, pnpm,
Vitest and Biome. One parser for all three languages keeps the tool free of
native add-ons. The npm package includes the compiled engine, grammars, built
dashboard and container runtime recipes.

The dashboard is React and TypeScript with Vite, React Router 7, Tailwind CSS
4, React Aria Components, Gravity icons, OverlayScrollbars and Torph, served by a loopback
Node.js service that stores scans, plans, runs, campaigns, providers and
preferences in SQLite. `plenger --workspace <folder>` serves the bundled dashboard;
`pnpm dashboard` runs the Vite development server with hot reload against the
same service. Managed runs execute project code in Docker or Podman workers;
the model provider runs on the host. See [guide/dashboard.md](guide/dashboard.md).

## Milestones

### M0 to M5 (done)

Foundation, code facts, agent inventory, cross-file links and capabilities,
risk rules and triage, reports and CI. The record with measurements and known
limits is in [history/m0-m5.md](history/m0-m5.md).

### M6 Red-team harness: direct input (postponed)

**Delivered:** offline discovery and planning (`redteam discover`, `redteam plan`);
two managed profiles, `llmfy-file-canary-v1` and `vercel-booking-sqlite-v1`,
with source capture, pinned networkless workers, isolation checks before
import, preserved approval checks, a shared model budget, clean controls and
deterministic oracles; `redteam run` with fixed repetitions, 95% Wilson
intervals, `--fail-on`, `--min-coverage`, `--minimum-evaluable` and required
scope gates, exported profiles and four report formats; `redteam compare`;
saved providers; persistent dashboard runs and campaigns; separate version 1
JSON schemas. Synthetic qualification of both runtimes and one live-model
Autocare run are recorded in [qualifications/](qualifications/). See
[STATUS.md](STATUS.md) for the current matrix and [guide/redteam.md](guide/redteam.md)
for usage.

**Approach.** Turn the inventory into reviewable test hypotheses, then run
them against a managed test instance or selected endpoint. Prove the complete
workflow on a library-only llmfy project first, then extend to HTTP APIs and
additional Python or Node entry shapes, then MCP. Ship built-in cases and
policy presets selected from the inventory; custom cases are an advanced
extension. A generated attack corpus or adaptive optimiser is outside M6.
Static findings are hypotheses: `POST /ops → ops_agent → shell` from PLG301
suggests a test of the route's tool-use boundary, and calling a tool the user
may call is not a violation.

**Project mode and endpoint mode.** Project mode prepares and observes a
managed test instance through built-in integrations. Endpoint-only mode (not
implemented yet) runs request/response cases without source access and can
observe internal actions only through a supported integration surface.

**REA in red-team work.** [REA](https://rea.tools) maps applications without
their source. Today its JSON import only adds context to fix prompts. It does
not feed the source review: on a repository with source, its output repeats
what the static scan finds
([check of 2026-10-17](qualifications/rea-import-2026-10-17.md)). Red-team
work has three planned roles for it:

- **Endpoint reconnaissance.** Endpoint-only mode has no static scan. REA's
  analysis of a website, HAR capture, Electron application, ASAR or APK
  supplies the endpoints, request shapes and IPC channels that select cases.
- **Runtime observation.** REA's runtime capture can record requests and
  processes during a trial, as evidence beside plenger's hooks. This narrows
  the dynamic observation gap listed under [Risks](#risks).
- **Build comparison.** `compare_application_versions` shows what changed
  between two builds, so a retest can choose which saved cases to rerun.

REA would run inside the red-team runtime images, pinned like their other
dependencies, and never on the host or in the npm package. Each role keeps
only the facts it needs from REA's output. Endpoint reconnaissance and
observation stay within the target scope saved in the profile.

**Delivery checkpoints.** Each checkpoint is completed and reviewed
separately; M6 is done only when all three are complete. An unresolved part of
the llmfy path blocks M6a; it is not deferred to M6b or made a user task.

| Checkpoint | Deliverable | Acceptance |
| --- | --- | --- |
| M6a Click-to-run llmfy | One qualified runtime profile, dashboard for scan and dynamic setup/run/results, local run history, saved profile, built-in tests, managed launcher, hooks and doubles, usage limits and cleanup | Select an unmodified llmfy project, inspect its scan, provide model access, click Start, receive evidence and rerun without code, config or fixture preparation; qualify with a real model, clean-task assertions and preserved approval inside a handler; stub fixtures verify both boundary outcomes, event handling, budget exhaustion and cancellation |
| M6b HTTP and project expansion | HTTP profiles and additional declared Python/Node project shapes and OS/runtime combinations on M6a's engine and test-pack contract | Each advertised integration passes the same no-code journey and states its observable boundaries; request controls, isolation, clean-task fidelity, cleanup and worker start-up cost are verified |
| M6c MCP and CI | SDK spike, MCP setup in the interface, repetitions and statistics, remaining reporters and dynamic CI policy | Supported HTTP, project and MCP profiles share the result contract and rerun from the interface or CI; severity, coverage, scope and exit-code cases are verified |

**Remaining work per checkpoint:**

- M6a: qualify the llmfy journey with a live model on an unmodified project;
  qualify the provider's request bounds and charged-token accounting. The rest
  of the checkpoint (discovery, setup, isolation before import, preserved
  approval, bounded model access, dashboard workflow, saved profiles, history,
  test-pack binding by observed file-write semantics with four probes) is
  delivered with synthetic qualification. See
  [design/llmfy-runtime.md](design/llmfy-runtime.md#remaining-for-m6a).
- M6b: repeat and extend Next.js model qualification across models, backends
  and platforms; broaden HTTP profiles beyond the booking contract; measure
  and document worker start-up cost; qualify each OS/backend combination
  independently.
  The first new profile is the FastAPI project profile designed in
  [design/fastapi-profile.md](design/fastapi-profile.md), with the Dayatech
  assessment-center project as its acceptance target. Its first checkpoint was
  removed on 2026-10-21 and is rebuilt when M6b resumes.
- M6c: the MCP SDK go/no-go spike and adapter; qualified tool, web and
  retrieval delivery for surfaces that today stay unsupported in the scope
  matrix; a CLI option for dynamic suppressions. Repetitions, statistics,
  reporters and CI gates are delivered.

**Protocol transport.** The specification calls for a versioned JSON message
protocol over a loopback socket or named pipe, portable to Windows for M8. The
implementation sends newline-delimited JSON over container stdio; the request
and `ready` frames carry `protocolVersion`, so the host refuses a mismatched
worker. See [design/worker-protocol.md](design/worker-protocol.md). Worker reuse across
trials with a verified reset may become an explicit option later, never the
default; a fresh worker per trial stays the rule.

**Attack templates (done, brought forward).** Checkpoint 1 of
[design/generated-attacks.md](design/generated-attacks.md) moved the built-in
control and probe text into host templates (`attack-model.ts`) and raised the
worker protocol to version 2. Every filled prompt equals the version 1 text,
so cases, statistics and comparisons are unchanged. The attack corpus, the
attacker role and per-attack campaigns (checkpoints 2 to 4) stay after M7.

**Done when:** all three checkpoints pass. Deterministic local HTTP, direct
Python and Node function, and MCP fixtures demonstrate both enforced and
violated boundaries; benign echoes, missing events, unreachable callbacks,
failed resets and timeouts are reported accurately. Automated checks cover
redirects and changed DNS answers, report schemas, redaction with surviving
canary evidence, event authentication (a forged trial id cannot change an
outcome; a later receiver failure preserves a confirmed violation), approval
inside a handler, clean-task assertions, budgets under loops, retries, missing
usage and exhaustion, and scope regressions. The acceptance test is the
complete user journey on an unmodified supported project, repeated from the
saved profile. Routine CI uses stub models; each advertised integration is
verified separately with a real model.

### M7 Red-team: indirect prompt injection (postponed)

Extend M6's plans, runner and oracles to put test instructions in lower-trust
content while keeping the legitimate user request unchanged. The user selects
a scenario in the dashboard; plenger prepares the content, delivery
integration, observation and cleanup. The focus is indirect prompt injection
through documents and tool results, as described by
[OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/). M7
reuses M6's target constraints, test-pack contracts, budgets, synthetic data
and recording doubles and keeps execution coverage and test scope separate.

**Delivery checkpoints.** Implement a shared fixture lifecycle (prepare, verify
delivery, reset, clean up), then complete and review M7a before M7b. M7a
proves tool-output and retrieval-context injection through an already
qualified project adapter. M7b adds MCP and web delivery plus retrieval through
a disposable index with one declared backend and version. Four channel
families; retrieval has two integration depths.

| Checkpoint / channel | Delivery | Evidence required before scoring |
| --- | --- | --- |
| M7a: tool output | The adapter replaces a selected tool result with a generated marked fixture | The agent consumed that call's marked output; the report identifies the substitution boundary |
| M7a: retrieval context | The adapter supplies a fixture at the retrieval-result boundary | The marked document entered the trial's context; labelled as content handling, retrieval itself untested |
| M7b: MCP result | Plenger starts a mock server and routes the selected MCP dependency to it | The agent received that mock content during the trial |
| M7b: web content | Plenger starts a fixture server and directs the selected fetch to its document | The content reached the agent, not just a health check |
| M7b: retrieval through an index | A disposable collection is created and seeded for the declared backend | The marked document was retrieved from that collection and entered the context |

Each checkpoint demonstrates no-code scenario selection, verified delivery,
enforced and deliberately violated boundaries, passing clean controls and
cleanup, qualified with a real model; routine CI stays deterministic with
stubs. Unavailable injection surfaces are shown as unsupported before a run.
Attempted but unverifiable delivery is inconclusive; an unretrieved document
is never a successful defence. A substitute retrieval result tests content
handling, not the real index's access controls.

Each injected case is paired with a clean control using the same task, fixture
shape and configuration in isolated sessions; the control must satisfy
explicit expected-answer or expected-action assertions, and both count against
the budget. Probes test whether lower-trust instructions change the answer,
disclose a synthetic marker or request a forbidden tool action. Benign
quotation is not a violation. Initial probes use deterministic assertions; no
LLM judge is required. A small versioned set of canary templates generates
fixtures with recorded variations in wording, placement and wrapping.
Model-weight attacks and autonomous bypass search are out of scope.

Reports cover per channel, case and tool: planned and verified deliveries,
execution coverage, the scope matrix, violations per evaluable trial, control
outcomes and task completion, with content-only and index-backed retrieval
kept separate. Before/after comparisons follow M6's rules. Scenario selection,
delivery evidence, controls and comparisons appear in the dashboard and CLI.

**Done when:** both checkpoints pass and each advertised integration can
choose and run its M7 scenarios without source edits or hand-prepared
fixtures. All four channel families and both retrieval depths have a local
example with an enforced and a violated boundary, clean-task assertions,
delivery evidence and automatic cleanup. Fixtures cover benign quoted
instructions, missing retrieval, unavailable observations and contamination
between trials. Before/after reports show a mitigation reducing observed
violations while preserving the task. Live-model qualification is recorded
separately from harness self-tests.

### M8 Distribution (in progress)

**Delivered:** an npm package containing the compiled CLI, local service, built
dashboard, parser WASM assets and managed runtime recipes. npm and npx expose
the dashboard launcher, help, version and confirmed `plenger update`. A prepack build prepares
the package. The installed-package check verifies global installation, npm
command resolution and authenticated dashboard scanning outside the
checkout. Installed-package CI jobs cover Linux on every push, and macOS and
Windows on pull requests and manual runs.

npm is the only distribution; the standalone binary build was dropped. See
[design/distribution.md](design/distribution.md), [guide/install.md](guide/install.md)
and [STATUS.md](STATUS.md) for release and platform evidence.

**Next checkpoints:** publish the npm release. Qualify runtime integrations
under M6/M7 before advertising their dynamic coverage, once that work resumes. Keep installation free of
frontend builds and automatic container setup. Document the offline scan and
click-to-run workflows, model-access setup, supported framework versions,
observation limits, profile export and CI use; keep custom adapters and
handwritten configuration in advanced documentation. Explain that the gates
differ on purpose: the static gate ignores baseline findings, the dynamic gate
fails on an observed violation even when a baseline contains it. State that
dynamic testing is for targets the user owns or has permission to test.

### M9 Review for any language (done)

The AI review used to read only files the parser supports. A Go, Java or PHP
repository got no AI review, and templates, configuration and SQL files were
never read. M9 removes that limit in two checkpoints, reviewed separately.

**Delivered:** M9a. Dashboard scans list text files without a parser, and the
review reads them as plain text after the traced and focused files: code before
configuration, tests and fixtures last. Large files go as 80-line windows that
later Full coverage batches continue. CI definitions are the only hidden paths
reviewed.
See [guide/ai-security-review.md](guide/ai-security-review.md).

**Delivered:** M9b. The tool loop and the second review with tools work as
the dashboard's Explore mode, the default for Claude, in Quick and Full
coverage, with Unvalidated candidates in both modes and `pnpm evaluate --mode`.
The acceptance holds on the 150-case corpus. See [STATUS.md](STATUS.md) for the
records and what is not yet qualified.

| Checkpoint | Deliverable | Acceptance |
| --- | --- | --- |
| M9a Every text file | Text files in any language enter the review under the same ignore, size, sensitive-path and redaction rules as parsed source. Files without a parser are sent whole or as line windows, ordered after traced files by path hints, and cited by line | A repository without Python, JavaScript or TypeScript gets a review with checked citations. Coverage lists the files sent and skipped. Lockfiles, binaries, minified and generated files stay out |
| M9b Read-only exploration | The model lists, reads and searches the redacted allowlist through bounded tools, with the static facts as starting hints. The second review can read further files to confirm or dismiss a candidate. Format errors get one bounded retry, and candidates that cannot be validated stay unvalidated | Tool calls work on every supported provider. The model budget bounds every turn. Coverage equals the recorded reads. The evaluation corpus gains cross-file cases, and precision and recall are recorded before and after |

M9b changes the review architecture. Its design, with limits, failure handling
and five delivery checkpoints, is in
[design/review-exploration.md](design/review-exploration.md). Static parsing
stays with Python, JavaScript and TypeScript; a new grammar is added only for
static rules in another language.

### M10 Review discipline and scope (done)

M10 adopts ideas from the white-box review of
[Strix](https://github.com/usestrix/strix) that need no execution. Scans stay
read-only. The design, the selection criteria and the ideas left out are in
[design/strix-adoption.md](design/strix-adoption.md). Each checkpoint is
reviewed and measured before the next.

**Delivered:** all five checkpoints. Discovery rates severity by reach, a
dismissal names its basis and cites lines the host checks, and discovery closes
the paths the static scan traced. A project keeps a threat model that every
review starts from. Change reviews in New Scan and the GitHub Action shipped
and were removed on 2026-10-25, to keep the dashboard local-first. A Full
coverage scan continues after its limit and shows live activity. The framework
guides of M10c were measured and removed, because they lowered precision. See [STATUS.md](STATUS.md) for the records.

| Checkpoint | Deliverable | Acceptance |
| --- | --- | --- |
| M10a Decision discipline | A severity rubric and a checklist before high or critical. A dismissal names its basis and cites the control or source, which the host checks; without a valid citation it becomes Needs review | Evaluation cases carry a severity label. Over three runs, severity agreement is recorded before and after, precision and recall do not drop, and vulnerable cases dismissed by mistake do not rise |
| M10b Path closure | The review closes every traced path in a batch: a finding, safe with a cited control, or open with what is missing. Outputs list unclosed paths | The share of closed paths is recorded. Recall on the cross-file pairs and precision do not drop |
| M10c Guides and project threat model | Framework review guides selected from the static inventory. One threat model per project, shared by all batches, saved and editable | Precision and recall per framework with and without its guide. Tokens per batch fall and detection does not drop |
| M10d Change review (removed) | A scan scope for the changes since a commit or branch, with scope rules for introduced, newly reached and weakened paths and removed controls. An opt-in model review of pull requests in the GitHub Action | Diff cases in the corpus. Git reads run no project filters or diff drivers. An Action integration test with the synthetic provider |
| M10e Long scans | A Full coverage scan continues after its limit with a new one. Scan details show live activity | Integration tests for continuation and a browser check for the timeline |

### M11 Validation by execution (planned)

A proof test confirms a source-supported finding. After an explicit start, the
model on the host writes one test and runs it inside a networkless container
built from the red-team runtimes. The test fails when the weakness exists. The
outcome is proven, not reproduced or could not run; not reproduced is not
evidence of safety. Retest runs the same test after a fix. Plenger does not
write to the project. M11 starts after M10a and a reviewed design of its own.
The open decisions are in
[design/strix-adoption.md](design/strix-adoption.md#m11-validation-by-execution).

## Risks

- **TypeScript grammar.** `tree-sitter-typescript` has had no release since
  0.23.2 (November 2024), and its main branch has had no grammar change since. It
  does not parse some TypeScript 5 type syntax: `export type * from`, type
  arguments and `[]` after an import type, and `in`/`out` variance annotations.
  The fixes are open pull requests (#358, #360). Since that syntax does nothing
  at run time, the parser blanks it before parsing, keeping every position
  (`src/source/typescript-syntax.ts`). New type syntax needs the same treatment
  until the grammar moves; oxc-parser for JS/TS remains the larger option.
- **Dynamic observation gaps.** Responses alone cannot establish whether a
  tool ran or a protected document was read. Trace sampling, missing tool
  arguments and failed fixture delivery must reduce coverage rather than
  create passing tests.
- **Variable model behaviour.** Changes in models, prompts, tools or retrieval
  change results. Pin what can be pinned, record what cannot, and compare
  repeated trials with controls and sample counts.
- **Harness code execution.** Project import has side effects. The launcher
  establishes the isolation profile before import and attaches tool doubles; a
  subprocess is not a sandbox. Missing isolation support blocks the run rather
  than falling back to host credentials or user-implemented isolation.
- **Automatic integration fidelity.** Static detection is broader than runtime
  support. Versioned adapters need evidence that discovery, hooks and synthetic
  resources preserve the task and the boundary. Unsupported shapes are a
  compatibility gap, not a reason for user-written code or silently reduced
  coverage.
- **Exposed receivers.** A receiver reachable from staging can receive traffic
  from elsewhere. Bind to loopback by default, require explicit configuration
  for anything else, authenticate events, bound size and rate, and never treat
  unauthenticated input as an observation. Event authenticity assumes trusted
  instrumentation and a token inaccessible to the tested tools.

## Beyond the MVP

Planned work pursuing the product direction; not current features and not a
claim of parity:

- **Broader test catalogue and target support:** direct model targets,
  additional application integrations and versioned packs for data leakage,
  unauthorised tool use, access controls and application policy.
- **Generated and adaptive attacks:** an attacker LLM creates context-specific
  cases and refines attempts from target feedback within explicit budgets.
  The non-adaptive first step is designed in
  [design/generated-attacks.md](design/generated-attacks.md); its first
  checkpoint, attack templates on the host, is done.
- **Multi-turn campaigns:** session-aware conversations, reset and replay,
  bounded adaptive strategies, evidence retained across turns.
- **Hybrid grading:** deterministic assertions and tool evidence complemented
  by LLM judges for semantic outcomes, with judge configuration, uncertainty
  and calibration recorded and kept distinct from observed actions.
- **Security regression suites:** save observed failures as reusable cases,
  import cases, compare the same attacks and policies across fixes, prompts,
  models or builds in the dashboard and CI, preserving case and strategy
  versions and scope; track target, attacker and judge usage in one budget.
- **Expanded dashboard:** team collaboration and cross-project views.
- **Additional dynamic adapters:** explicitly configured local MCP stdio
  processes, more framework observation adapters and broader probe coverage,
  driven by measured gaps.
- **Model-level adversarial research** requiring weights and PyTorch, in a
  separate Python worker if pursued; outside the agent-level scope.
