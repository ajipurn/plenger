# Red-team engine internals

Notes on the engine components under `src/redteam/` that the user guide does
not cover. The user-facing behaviour is in [../guide/redteam.md](../guide/redteam.md);
the normative contracts are in [redteam-contracts.md](redteam-contracts.md);
the host to worker messages are in [worker-protocol.md](worker-protocol.md).

## Discovery and planning

`discoverProject()` in `src/redteam/discover.ts` reuses the static scanner and
its cross-file inventory. It identifies functions that contain known llmfy
invocations and factories that return an agent or a FlowEngine build result.
A public, undecorated module function with one parameter or a zero-argument
factory is a candidate. Methods, nested, private or decorated functions,
ambiguous symbols and functions that need input mapping are retained with
reasons. It checks root `pyproject.toml`, `requirements.txt`, `uv.lock` and
`poetry.lock` presence without reading their contents. The CLI, planning and
dashboard code share this module.

`planProject()` in `src/redteam/plan.ts` creates a private temporary snapshot,
runs discovery against the captured bytes and removes the snapshot before
returning. `withPreparedProject()` keeps an eligible snapshot alive for a
callback and removes it on success or failure. It can require the digest of a
previously reviewed plan and rejects source or manifest changes before the
callback runs. The managed runners (`run.ts`, `vercel-run.ts`) use this seam: the
callback reads the captured files and sends them to the worker.

Source policies:

- `python-only-v1` copies regular `.py` files that pass the scanner's
  exclusions and `.gitignore`. It excludes hidden or sensitive paths, symlinks,
  multiply linked files, invalid text and recognised embedded credentials.
  Excluded application source is retained as a preparation gap. Files get mode
  0400 in 0700 directories. Reads are bounded, check canonical paths and file
  identity, and reject changes observed during a read. Defaults are 2,000
  files, 1 MiB per file and 16 MiB in total; runs cap the captured total at
  4 MiB. Non-Python resources are not collected.
- `next-route-sqlite-v1` (`vercel-plan.ts`) captures the selected route handler's
  static import closure, up to 100 files and 4 MiB, and records the managed
  dependency versions.

The digest covers captured content and reviewed manifest bytes, not
undiscovered resources or `.env` files.

The metadata reader (`dependencies.ts`) handles root `requirements.txt`
declarations and PEP 621 `[project].dependencies` and `requires-python`. It
retains package names, extras and simple version constraints, flags conflicting
declarations and compares an exact llmfy pin with the baseline 0.11.0. There is
no resolution, installation or network access. Requirement includes, URLs,
environment markers, custom sources, dynamic dependencies, Poetry metadata,
lockfiles and optional groups are reported as unsupported with reasons.

## ModelBudget

`ModelBudget` in `src/redteam/budget.ts` is one controller per campaign, shared
across every repetition, setup step, clean control, probe and agent loop. The
dashboard and `redteam run` configure its limits.

- Admission reserves a model call and the full input, output and additional
  token bound before dispatch. Concurrent calls share the reservations. Every
  retry is admitted separately; calls are never refunded.
- The transport receives the run's abort signal and the maximum output
  allowance. Complete, validated usage releases unused tokens. Missing usage,
  transport failures and invalid usage keep the reservation.
- Exceeding any reserved token category stops admission even when the total
  fits, because the provider profile's bound has failed. An overrun keeps at
  least the original reservation and records observed usage where
  representable. Malformed usage, including unsafe integer totals, stops the
  controller.
- Call or token exhaustion, cancellation and one monotonic deadline stop active
  callers through a broadcast `AbortSignal`; the runner still stops and cleans
  its workers. Late provider replies can reconcile usage but cannot turn an
  interrupted call into a successful one. `providersUnsettled` distinguishes
  remote operations without a final response from callers interrupted locally.
- `finish()` closes admission and clears the timer. It refuses to complete a
  controller with active calls. Reaching the exact cap after all required work
  is allowed; further work that cannot fit stops the run.

Snapshots have `kind: "redteam-model-budget"`, schema version 1 and
`enforcementScope: "submitted-dispatches"`: limits, admitted calls, observed
tokens, outstanding reservations, accounted totals and stop reasons, without
model inputs, responses, credentials or provider error text. Observed usage
plus outstanding reservations equals accounted tokens. Provider errors
propagate to the engine, which redacts them before display or persistence.

The controller bounds submitted dispatches. It is not an enforced cost cap on
arbitrary project traffic, and the live-provider token accounting has not been
qualified against charged usage.

## Provider transport

`src/redteam/provider.ts` implements one chat-completions client for OpenAI,
Ollama and Gemini (through Gemini's OpenAI-compatible endpoint). It uses fixed
base URLs per provider or the saved base URL, sends `redirect: "error"`, makes
no SDK retries and never discovers credentials. OpenAI requests set
`max_completion_tokens` and `store: false`; others set `max_tokens`. Gemini
tool-call thought signatures are kept in memory only. Input admission uses a
conservative byte estimate reconciled with validated usage; an estimate overrun
stops the run. `provider-config.ts` validates saved settings: temperature 0 to
2 or null, maximum output tokens 1 to 16384.

## Runners

`executeRun()` in `run.ts` drives the llmfy profile and delegates
`vercel-booking-sqlite-v1` to `executeVercelRun()` in `vercel-run.ts`. Both:

1. prepare the snapshot through `withPreparedProject()` with the expected
   digest,
2. build or reuse the pinned image through `runtime.ts` (Docker preferred,
   Podman fallback; the image tag is derived from a digest of the recipe
   files),
3. run one worker per trial through the launcher in `worker.ts`,
   validating the `ready` frame and every event against the protocol,
4. evaluate outcomes with deterministic oracles and record budget snapshots
   after every update,
5. stop at the first probe when the clean control failed, and
6. mark the report `completed`, `stopped` (budget, deadline or cancellation) or
   `failed`, with `cleanupConfirmed` set only when the launcher confirmed the
   container is gone.

The Next.js runner also runs the backend-validation worker first and redacts
the report on every update. `evaluateDatabaseTrial()` is the SQLite oracle.

`campaign.ts` creates campaign plans from a project plan, validates imported
profiles, executes repetitions through the runners with one shared budget and
evaluates the gates. `campaign-evidence.ts` computes per-case counts and
Wilson intervals (z = 1.959963984540054, no continuity correction).
`campaign-report.ts` renders terminal, JSON, Markdown and SARIF.
`comparison.ts` implements the fixed-configuration before/after comparison.
`schema.ts` defines the version 1 JSON schemas that `pnpm schemas` writes.

## Qualification broker

`QualificationBroker` in `qualification-broker.ts` is the host-side synthetic
provider for the trusted llmfy fixture. `qualifyLlmfyBudget()` runs
`qualify.py` in budget mode; the worker sends full model requests and
tool-stage events over stdio, and the broker owns response generation, call
admission and usage accounting. Worker-supplied usage fields never affect
accounting.

The synthetic profile `synthetic-utf8-bytes-v1` counts UTF-8 bytes of the
serialised messages, tool declarations and responses as tokens. It reserves
the full input size and 1,024 output units before each response and checks the
generated response against that allowance. Inputs above 48 KiB are rejected.
This accounting is deterministic for qualification and does not estimate a live
model's usage or cost.

The suite scenario runs five trials (two clean controls, approval denied,
unguarded, proposal only) through nine model calls. Separate scenarios prove
shared call exhaustion during an agent loop, refusal when a token reservation
cannot fit, and deadline or cancellation during a blocked handler. Events
received before an interruption survive container cleanup: a confirmed
forbidden effect remains `violation_observed`; incomplete work is
`inconclusive`; unstarted cases have `started: false`.

The report has `kind: "llmfy-budget-qualification"`,
`transport: "stdio-network-none"`, `tokenAccounting: "synthetic-utf8-bytes-v1"`
and `liveModelQualified: false`. It excludes model messages and responses and
returns partial results only after successful cleanup. Sequence validation
checks the trusted fixture's path; it does not authenticate evidence from
arbitrary application code.
