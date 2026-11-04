# Red-team contracts

The `redteam` CLI commands, report formats and campaign comparisons named below
were removed on 2026-10-21. Their clauses stay as design for a later dashboard
adapter. See [../STATUS.md](../STATUS.md) for what exists now.

These are the normative contracts for plenger's dynamic tests: what a test
pack declares, how the model budget is enforced, how severity and gates work,
how coverage and scope are reported, how repeated trials are summarised and
what isolation a managed run guarantees. They were written as the M6
specification in the roadmap and are stated here in the present tense as the
implementation follows them. Where the implementation does not yet meet a
clause, the gap is flagged. User-facing behaviour is in
[../guide/redteam.md](../guide/redteam.md); status is in [../STATUS.md](../STATUS.md).

## Test packs

Each versioned pack declares its supported runtime profiles, input, tool and
result shapes, a legitimate task with synthetic resources and deterministic
assertions for successful completion, the attack inputs, the forbidden
boundary, the required observation stages, a severity with rationale and the
oracle. A response without an error is not a completed task. Any user choice
of business policy is saved in the profile.

Packs bind only where the adapter can establish those contracts, never from
tool names or argument types alone. When no pack fits, the gap stays in the
scope report; the user is not asked to write one.

Each substitution records its interception point and the original validation
and approval path it preserves. Qualification includes an approval check inside
a tool handler: a denied operation must not reach the recording effect, and an
approved clean task must produce the expected synthetic result. A deliberately
unguarded fixture verifies that the same oracle detects the forbidden
dispatch. Proposal, dispatch and completed-effect assertions stay distinct: a
recording double proves arrival at the intercepted boundary, not a production
side effect. Each pack owns resource preparation, reset and cleanup and
verifies its clean control. A failed control blocks claims of task completion
and valid comparison; an independently confirmed violation backed by the
case's required evidence is retained.

Implemented packs: the llmfy file canary (a clean control and four probes)
and the Next.js booking checks (two backend checks, three model trials), both
with fixed versions in `src/redteam/`. The file canary binds through
`DiscoveryTarget.packs`: a target qualifies when one of its agents' tools has a
`file_write` capability that stores content (`write_text`, `write_bytes`,
`open`) at a path derived from a tool parameter, with a synchronous handler.
The reason for a failed binding is reported on the target and blocks the run.
**Gap:** packs are built in; there is no pack format for additional cases, and
M7 delivery evidence and paired controls are not yet part of the contract.

## Model-usage budget

Run-wide model-call and token limits are stored separately from trial counts
and runner HTTP limits, with a wall-clock deadline. Calls from fixture
preparation, clean controls, probes, agent loops and provider retries count
against one budget. The supported provider path admits every model request
through a budget boundary that the worker cannot bypass: the worker has no
network, and the host broker is the only route to a model.

Before dispatch the controller reserves the call, the input tokens and the
enforced maximum output allowance, and admits the request only if they fit.
The provider profile defines token accounting, including additional token
categories it charges. Unused reservations are released only with confirmed
usage; a conservative bound is kept when usage is missing. A profile that
cannot bound its calls cannot advertise enforced token limits.

The experimental ChatGPT subscription transport declares observed token
thresholds in setup, reports and `budget.tokenLimitMode`. Its API does not
accept an output-token limit. It admits calls using reservations, reconciles
completed usage and stops on an overrun. Those reservations are estimates,
not guaranteed bounds on subscription consumption. It never retries model
requests. OAuth refresh is serialized separately and makes no inference call.

Saved OpenAI connections with automatic output settings keep an enforced output
cap. Requests send the operation allowance, up to 16,384 tokens, as
`max_completion_tokens`, or as `max_output_tokens` when a request with tools goes
to the Responses API, so a completed response never exceeds its reservation.
Claude automatic settings also keep an enforced output cap, using the smaller of
model metadata and the operation allowance.
Provider model catalog requests make no inference calls and do not reserve model tokens.

Reports record configured limits, calls admitted, observed usage, outstanding
reservations and the reason execution stopped. When the budget prevents
required work, admission stops, managed workers are cancelled and partial
results are kept. Interrupted trials are inconclusive, unstarted trials remain
unevaluable and confirmed violations remain recorded. Budget exhaustion is an
execution failure, never a successful defence. Reaching the cap after all
planned work completes does not fail the run. Planned repetitions are never
reduced to make a run pass. Currency estimates, if offered, are separate from
enforced limits.

For remote endpoints, runner request and time limits apply, and target model
usage is labelled reported or unknown. Target-side limits are claimed only
when a supported integration enforces them. The enforcement scope is shown
before Start and in the report. **Gap:** live-provider charged-token
accounting has not been qualified against a provider invoice; the controller's
scope is `submitted-dispatches`. Remote endpoint targets are not implemented.

## MCP dependency decision

MCP cases use the pinned official TypeScript client SDK in a separately
installed optional adapter loaded only for MCP cases. The static CLI and the
HTTP and function adapters install and run without that dependency tree. The
SDK version is selected during M6c, its supported protocol versions recorded
and its transitive dependencies reviewed under the pinning, age and
no-install-scripts policy. No auto-installation happens during a run: setup
offers the adapter before Start, and unattended CLI runs fail configuration
validation when it is missing. SDK connections use the runner's destination,
redirect and request-budget controls, including secondary session requests.
M6c starts with a go/no-go spike confirming that the SDK's client transport
accepts an injected `fetch`; otherwise a minimal client for the Streamable HTTP
subset is used. **Gap:** none of this is implemented. MCP surfaces appear in
the scope matrix as unsupported with a reason.

OTLP support is an optional follow-up with its attribute mapping in one
adapter; the OpenTelemetry GenAI agent conventions are still in development.

## Reports and schemas

Dynamic reports reuse M5's formatting, redaction and policy concepts with
separately versioned JSON schemas (`schemas/redteam-*-v1.schema.json`); the
static `report-v1` contract and its baselines are unchanged. The interface,
terminal, Markdown and JSON show observations, execution coverage and test
scope separately. SARIF exports supported dynamic findings with real source
locations when available and never invents file or line evidence; unverified
source-to-deployment mappings are flagged. Full trial records stay in JSON.
Regression cases match by stable case id and configuration, not random
canaries.

## Severity and gate

Each case has an explicit severity (`critical`, `high`, `medium` or `low`)
and a rationale tied to the prohibited boundary and the evidence its oracle can
establish. Built-in templates supply these fields. A linked static finding can
suggest a severity for review, but its severity is not inherited and its triage
score is not a dynamic score. The observation stage is recorded separately; a
proposed call is never described as a completed effect. Invalid severity or a
missing rationale fails configuration validation before the target is
contacted.

`--fail-on critical|high|medium|low|none` on `redteam run` gates any
unsuppressed `violation_observed` at or above the threshold, even if a
comparison baseline already contains it. The CLI default is `none`; dashboard
campaigns use `high` and display the active coverage and scope policies. One
qualifying observation fails the gate; a low rate or a wide interval does not
erase it. Suppressions require a case id and reason, preserve results and
never waive execution coverage or required scope. Refreshing a comparison
baseline does not suppress findings. The static gate semantics are unchanged.
**Gap:** suppressions exist in the campaign policy structure only; there is no
CLI option or policy file to supply them.

## Execution coverage and test scope

Execution coverage is evaluable trials divided by planned trials per selected
case. Errors, skipped, unstarted and inconclusive trials are unevaluable; an
empty selection is invalid. `--min-coverage` controls only this measure: a
fraction in `(0, 1]`, default `1`. Each plan declares a minimum evaluable
count (`--minimum-evaluable`, default 1; 20 per case for a before/after
live-model comparison), and planned repetitions are validated against it.
Completing all selected trials is not full agent coverage.

A separate scope matrix lists discovered input, tool, MCP, web and retrieval
surfaces with stable ids and applicable scenario families. For each, the plan
and report record support, selection, execution or delivery and the required
evidence obtained, and retain unsupported, unselected and unverified entries
with reasons. Reports summarise surfaces exercised with required evidence
against surfaces discovered, beside execution coverage, for example
"10/10 evaluable trials; 1/4 discovered surfaces exercised, 3 unsupported".
Per-scenario detail is kept so one case does not imply every boundary on a
surface was tested. Unknown surfaces and opaque remote internals are labelled
unknown, never counted as covered.

Saved profiles and CI exports declare required surface and scenario ids before
unsupported cases are filtered from the executable plan. Requirements come from
the selected scope in the interface. A required surface that disappears, loses
adapter support or lacks the case's required evidence fails the scope gate.
Requirements never shrink silently on rerun; changing them is an explicit
profile update. CI evaluates required scope independently of `--min-coverage`.

`--fail-on none` disables only the finding gate. Execution errors,
cancellation, budget exhaustion and failed coverage, minimum-count or scope
checks still fail the run. Partial reports are written whenever possible with
every failure reason. Exit codes: 0 completed and all enabled gates passed;
1 execution, I/O, cancellation, budget, coverage or scope failure; 2 invalid
arguments or configuration; 3 finding gate failed. When execution, coverage or
scope failures coexist with a finding failure, the exit is 3. The static Action
never starts dynamic tests.

## Repeated-trial statistics

Each case reports a two-sided 95% Wilson score interval without continuity
correction for its violation rate when the evaluable count is nonzero
([NIST formula](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm)).
JSON records the method, confidence level, numerator and denominator. Zero
evaluable trials has no rate or interval. Smoke runs may use one trial;
comparison campaigns plan at least 20 per case per build, with higher counts
configurable in advance. Fewer than 20 evaluable trials is labelled
insufficient for a comparison even though the interval is shown. This minimum
is a product policy, not a guarantee of statistical power. Trials are assumed
independent under a fixed configuration; shared state and drift are flagged,
and different variants, models or builds are never pooled into one interval.
Intervals describe each run, not the significance of the difference between
runs. Fixed trial budgets avoid stopping or retrying until a desired result
appears. Tests check the interval at zero, all and some observed violations.

## Isolation and artifacts

The runner's allow-list constrains its own connections, not the target agent's
tools or network. Project mode therefore owns a managed test workspace,
recording tool doubles, synthetic resources and reset and cleanup. Filesystem,
environment and network boundaries are established before project import,
including import-time side effects; copying code or starting a subprocess is
insufficient. Ambient `.env` files, home-directory credentials and production
resources stay out of the execution profile. Only the model access selected in
setup is enabled, with configured budgets. A project that cannot run under a
supported profile is reported as unsupported rather than executed on the host.
Each isolation backend and OS/runtime combination is qualified independently;
a scanner binary for an OS does not establish managed-runtime support there.

Endpoint-only mode cannot apply local process isolation to a remote service
and offers only checks whose effects and observations the selected profile
supports. **Gap:** endpoint-only mode is not implemented.

Canary matches are evaluated before redaction; evidence is persisted redacted,
including requests, authentication headers, responses and tool events.

Artifacts: the dashboard stores run artifacts in plenger's application-data
SQLite database, outside the project checkout, with explicit export. The CLI
always writes private atomic JSON evidence to `<project>/.plenger/runs/<id>.json`
with owner-only permissions, in addition to the `--output` report; users are
asked to add `.plenger/` to `.gitignore`. **Gap:** the roadmap allowed the CLI
location to be overridden; there is no option for that. Artifacts can still
contain sensitive data after redaction; exports, CI uploads and retention are
explicit user choices.
