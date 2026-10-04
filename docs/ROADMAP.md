# Roadmap

Current capabilities, qualifications and pending work are in [STATUS.md](STATUS.md).
The completed milestones M0 to M5 are recorded in [history/m0-m5.md](history/m0-m5.md).
The normative M6 contracts are in [design/redteam-contracts.md](design/redteam-contracts.md).
This page keeps the goal, principles, stack, the remaining M6 checkpoints, M7,
M8, risks and the work beyond the MVP.

## Goal

For an agentic AI project in Python, JavaScript or TypeScript, help a developer
or security reviewer answer four questions quickly:

1. **What can the agent do?** Its models, tools, MCP servers, retrievers and
   what each tool can reach (shell, files, network, databases, messages).
2. **What can reach it?** HTTP routes, chat inputs, retrieved documents and
   tool outputs that end up in a prompt or a tool call.
3. **What should I look at first?** Findings ranked by severity and confidence,
   each pointing at the code that justifies it.
4. **Can adversarial input cross the application's security boundary?** Run
   scoped tests, inspect observed effects and rerun the same cases after a fix.

The MVP combines static triage with red-teaming of the running agent. Triage
comes first; [M6](#m6-red-team-harness-direct-input-in-progress) builds the
red-team harness and tests direct input against a running target, and
[M7](#m7-red-team-indirect-prompt-injection-planned) extends it to indirect
prompt injection through content the agent reads. Both are adversarial tests at
the agent level; model-level adversarial attacks are outside the MVP.
Distribution is [M8](#m8-distribution-in-progress).

**Product direction: capability and usability parity with promptfoo's
red-teaming workflow.** The scope is adversarial security testing of AI
applications and agents. Promptfoo is the primary reference; garak and Strix
are additional references. The capability target includes connecting models
and applications, a broader test catalogue, LLM-generated and adaptive
attacks, multi-turn sessions, deterministic checks plus LLM judges, saved
regression suites, comparisons and CI. M6 and M7 establish the initial
harness; completing them alone does not establish parity. Progress is measured
by setup effort, validated findings, false positives, evidence quality and
execution cost on common target applications.

Static triage and inventory support target discovery, attack selection and
source evidence. They remain available on their own, but delivery priorities
centre on the red-team journey. General prompt-quality evaluation, model
benchmarking and non-security A/B experiments are outside this direction.
Comparing models, prompts or builds stays in scope when rerunning the same
security cases to assess a boundary or verify a fix.

**Product goal: choose a project, click Start, get evidence.** For supported
integrations, users do not write wrappers, change application code, copy
event helpers, prepare mock tools or author configuration files. Plenger owns
discovery, integration, test setup, observation and cleanup. Users select a
project or endpoint, provide missing access when needed, and choose the test
scope and budget in the dashboard. Saved profiles make repeat runs a single
action; the CLI remains available for automation and CI. The no-code workflow
is a release criterion for each supported integration, not a promise that
every project shape can be instrumented. Runtime compatibility is published
independently of static detection coverage. An unsupported integration is
explained, never turned into an adapter-writing task or labelled as coverage.

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
| Security regression | Save a failure as a reusable case, rerun against a fix, compare across builds, gate CI | Saved campaigns and before/after comparisons exist; reusable custom suites are planned |

Target, attacker and judge models are distinct roles; choosing a provider
today configures the target model only. The sequence is: qualify M6a, broaden
M6b, complete M6c, then M7, then the generated, adaptive, multi-turn and
grading work as explicit checkpoints.

## Principles

These come from what went wrong in v0 (on `feat/backup`), where trust and
isolation infrastructure grew far ahead of what the tool could detect.

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

Node.js 22.18+ and TypeScript (strict, erasable syntax only), web-tree-sitter
with vendored WASM grammars for Python, JavaScript, TypeScript and TSX, pnpm,
Vitest and Biome. One parser for all three languages keeps the tool free of
native add-ons. The primary npm package includes the compiled engine, grammars,
built dashboard and container runtime recipes. The optional standalone binary
also embeds Node.js through single executable applications.

The dashboard is React and TypeScript with Vite, React Router 7, Tailwind CSS
4, Base UI, Gravity icons, OverlayScrollbars and Torph, served by a loopback
Node.js service that stores scans, plans, runs, campaigns, providers and
preferences in SQLite. `plenger serve [path]` serves the bundled dashboard;
`pnpm dashboard` runs the Vite development server with hot reload against the
same service. Managed runs execute project code in Docker or Podman workers;
the model provider runs on the host. See [guide/dashboard.md](guide/dashboard.md).

## Milestones

### M0 to M5 (done)

Foundation, code facts, agent inventory, cross-file links and capabilities,
risk rules and triage, reports and CI. The record with measurements and known
limits is in [history/m0-m5.md](history/m0-m5.md).

### M6 Red-team harness: direct input (in progress)

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
  qualify the provider's request bounds and charged-token accounting; broaden
  test-pack binding beyond the three file-canary cases; cover abrupt host
  death and Docker cleanup. The rest of the
  checkpoint (discovery, setup, isolation before import, preserved approval,
  bounded model access, dashboard workflow, saved profiles, history) is
  delivered with synthetic qualification. See
  [design/llmfy-runtime.md](design/llmfy-runtime.md#remaining-for-m6a).
- M6b: repeat and extend Next.js model qualification across models, backends
  and platforms; broaden HTTP profiles beyond the booking contract; measure
  and document worker start-up cost; qualify each OS/backend combination
  independently.
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

### M7 Red-team: indirect prompt injection (planned)

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
`plenger scan`, `serve` and `redteam` through one CLI. A prepack build prepares
the package. The installed-package check verifies global installation, npm
command resolution, scanning, offline planning and the dashboard outside the
checkout. Installed-package CI jobs cover Linux, macOS and Windows.

The optional standalone build bundles Node.js and produces native archives
with SHA-256 checksums. npm is the primary user installation. See
[design/distribution.md](design/distribution.md), [guide/install.md](guide/install.md)
and [STATUS.md](STATUS.md) for release and platform evidence.

**Next checkpoints:** publish the npm release. Qualify runtime integrations
under M6/M7 before advertising their dynamic coverage. Keep installation free of
frontend builds and automatic container setup. Document the offline scan and
click-to-run workflows, model-access setup, supported framework versions,
observation limits, profile export and CI use; keep custom adapters and
handwritten configuration in advanced documentation. Explain that the gates
differ on purpose: the static gate ignores baseline findings, the dynamic gate
fails on an observed violation even when a baseline contains it. State that
dynamic testing is for targets the user owns or has permission to test.

## Risks

- **TypeScript grammar.** `tree-sitter-typescript` has had no release since
  0.23.2 (November 2024) and does not parse some TypeScript 5 type syntax
  (`export type * from`, `import("x").T[]` in type positions, `in`/`out`
  variance annotations). tree-sitter recovers around these, so runtime facts
  are unaffected so far, but the gap will grow. Options: oxc-parser for JS/TS,
  or building the grammar from a maintained fork.
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
