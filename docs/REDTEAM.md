# Red-team implementation status

M6a starts with llmfy discovery. The goal remains a React + Vite dashboard where
the user selects an unmodified project, provides model access and a budget, then
clicks Start. plenger must prepare the supported runtime, test cases and
instrumentation itself. This initial CLI command exposes the discovery module
while the rest of that workflow is built; it does not require users to write a
wrapper or fixtures.

## Available: offline discovery

```sh
pnpm dev redteam discover path/to/project
pnpm dev redteam discover path/to/project --json --output discovery.json
```

The command reuses the static scanner and its cross-file inventory. It identifies
functions containing known llmfy invocations and factories directly returning an
agent or a FlowEngine build result. A public, undecorated module function with one
parameter, or a zero-argument factory, can be a **candidate**. These signatures are
hints, not proof that an argument accepts text or that the output can be graded.

Methods, nested/private/decorated functions, ambiguous symbols or factory returns,
functions requiring input mapping and source syntax errors are retained with
reasons. Agents without a discovered callable are reported as unresolved. This
uses the scanner's bounded static facts; it does not infer every possible wrapper,
dynamic import or application call chain. Candidates may require further choices
in the future interface or may prove unsupported during qualification.

Discovery never imports or executes project code, installs packages, starts a
worker or contacts a model. It checks root `pyproject.toml`, `requirements.txt`,
`uv.lock` and `poetry.lock` presence without reading their contents or following
manifest symlinks. Versions, dependencies and runtime compatibility have not been
resolved. `.env` credentials are not loaded.

The report records skipped files, parser errors, excluded directories and whether
the file limit truncated discovery. It respects `.gitignore`; `--no-gitignore`
uses the scanner's existing override. Other detected frameworks are listed but
do not receive executable adapters.

Terminal and JSON output are supported, including `--output`. The JSON object has
`schemaVersion: 1`, `kind: "redteam-discovery"`, `mode: "offline"` and
`executionReady: false`. It is distinct from the static scan report contract.
`candidate` and `unsupported` describe discovery only; neither is an attack
verdict. Exit 0 means discovery completed, including a report with no candidates
or incomplete scan coverage; 1 means an I/O/scan error; 2 means invalid arguments.
Static finding gates, baselines and SARIF output do not apply to this command.

The engine entry point is `discoverProject()` in `src/redteam/discover.ts`. The
CLI formats its result; future planning and dashboard code can call the same
module. Existing `scan`, `facts`, report and gate contracts remain unchanged.

## Available: offline project preparation

```sh
pnpm dev redteam plan path/to/project
pnpm dev redteam plan path/to/project --target llmfy:<candidate-id> --json
```

Use a project directory. One candidate is selected automatically; multiple
candidates remain visible and require an explicit choice. An absent or
unsupported target is rejected. This selection will become a dashboard control;
it does not require a user-written wrapper or config file.

`planProject()` creates a private temporary snapshot and runs discovery against
those captured bytes. It removes the snapshot before returning the report. The
internal `withPreparedProject()` interface retains an eligible snapshot for a
callback and removes it on success or failure. It can require the digest of a
previously reviewed plan, rejecting source or manifest changes before invoking
the callback. These functions do not execute application code; the callback is a
seam for the future isolated runner.

The source policy `python-only-v1` copies regular `.py` files that respect the
scanner's exclusions and `.gitignore`. It excludes hidden/sensitive source paths,
symlinks, multiply linked files, invalid text and recognised embedded credentials.
Excluded application source is retained as a preparation gap rather than silently
rewritten. Detected credentials are neither copied nor printed. Detection is
not exhaustive: a prepared snapshot is not certified credential-free and cannot
be executed until managed access and isolation are qualified.

Files have mode 0400 and private directories 0700 where supported. Reads are
bounded, check canonical paths and file identity, and reject changes observed
during a read. This is not an atomic filesystem snapshot or a guarantee against
a concurrent hostile filesystem writer. Defaults are 2,000 source files, 1 MiB
per file and 16 MiB of captured Python data. Reaching a limit blocks preparation.
Non-Python resources such as JSON data, prompt templates and configuration are
not collected or enumerated by this source policy; their availability is an
explicit pending runtime check. The digest covers captured Python content and
reviewed manifest bytes, not those undiscovered resources or `.env` files.

The metadata reader handles root `requirements.txt` declarations and PEP 621
`[project].dependencies`/`requires-python` in `pyproject.toml`. It retains package
names, extras and simple version constraints, checks for conflicting declarations,
and compares an exact llmfy pin with the synthetic baseline 0.11.0. This is
declaration review only: no dependency resolution, installation, build hooks or
network requests. A matching pin is not evidence of runtime compatibility.

Requirement includes, URLs, environment markers, custom dependency sources,
dynamic dependencies and Poetry metadata currently need further support and are
reported with reasons. Lockfiles, optional dependency groups, transitive packages
and Python-version compatibility are not resolved. Unsupported or missing metadata
is visible in the plan; plenger does not ask the user to author an adapter.

The JSON contract is `schemaVersion: 1`, `kind: "redteam-project-plan"` and
`executionReady: false`. `preparation.status: "ready"` means that the source
snapshot passed this preparation policy and a target was selected; it does not
mean tests can run. The plan contains no executable cases, provider credentials
or model budget authorization yet. Other states list selection, dependency or
source gaps. Terminal and JSON output, `--output`, `--target` and `--no-gitignore`
are supported. Exit 0 means a plan was produced, even when preparation is blocked;
invalid options or target choices exit 2, and root I/O failures exit 1.

## Available: shared model-budget controller

`ModelBudget` in `src/redteam/budget.ts` is an internal engine component, verified
with synthetic provider dispatches. It is not exposed as a runnable CLI command
or a new setup task for users. The future managed runner will create one controller
per run and share it across setup, clean controls, probes, agent loops and retries.

Admission reserves a model call and the full input/output/additional-token bound
before dispatch. Concurrent calls share those reservations. The transport receives
the run's abort signal and maximum output allowance; every retry must be admitted
separately. Calls are never refunded. Complete, validated usage releases unused
tokens; missing usage, transport failures and invalid usage retain the reservation.
Exceeding any reserved token category stops admission, even when the total happens
to fit, because the provider profile's bound has failed. A reported overrun retains
at least the original reservation and records the observed usage where representable.
Malformed responses or usage, including unsafe integer totals, stop the controller.

Call/token exhaustion, cancellation and the single monotonic deadline stop active
callers without depending on provider cooperation. The controller broadcasts
`AbortSignal`; the runner still has to stop and clean its workers. Late provider
replies can reconcile usage but cannot turn an interrupted call into a successful
one. Completed call records remain available. `providersUnsettled` distinguishes
remote operations without a final response from callers already interrupted locally.
Cancellation alone does not establish that remote computation or billing stopped.

`finish()` closes admission and clears the timer/listener. It refuses to complete
an open controller with active calls. Reaching the exact cap after all required
work completes is allowed; requesting further work that cannot fit stops the run.
A completed budget controller is not a successful trial or a security verdict:
the future runner must evaluate controls and evidence, preserve confirmed violations,
and mark interrupted or unstarted trials unevaluable.

Snapshots have `kind: "redteam-model-budget"`, schema version 1 and explicit
`enforcementScope: "submitted-dispatches"`. They include limits, admitted calls,
observed tokens, outstanding reservations, accounted totals and stop reasons, without
model inputs, responses, credentials or provider error text. Observed usage plus
outstanding reservations equals accounted tokens; outstanding reservations include
headroom retained after a profile overrun. Provider errors propagate to the engine,
which must redact them before displaying or persisting them.

**Still pending:** the trusted provider profile that computes bounds from the entire
request, enforces output allowances and accounts for all charged token categories;
the gateway and network policy that prevent a worker from bypassing admission; and
worker/trial integration. This controller is not an enforced cost cap on arbitrary
project traffic. No live provider was contacted during these tests, and
`redteam plan` still reports `executionReady: false`.

## Remaining M6a stages

The bundled runtime now has an executable synthetic qualification recipe:
`pnpm qualify:llmfy`. It exercises real llmfy in a Podman container, verifies the
isolation configuration before fixture import, preserves handler approval, and
tests observations, call-limit outcomes and worker lifecycle. See
[LLMFY_RUNTIME.md](LLMFY_RUNTIME.md) for the exact configuration and limitations.
This is a developer check, separate from the planned click-to-run project flow.

1. **Qualify a runtime.** Use an unmodified representative project and record exact
   llmfy/Python versions, provider, dependency setup, OS and isolation backend.
   Prove isolation before project import, preserved approval checks in tool
   handlers, and bounded model access. The fixture in `test/fixtures/redteam/llmfy`
   currently tests static discovery only; its dependency pin is not a qualified
   runtime profile. The executable fixture in `runtimes/llmfy/project` now covers
   the synthetic path, but no live-model path has been validated yet.
2. **Build test plans and the managed runner.** The source-preparation plan is
   available; executable cases and the project runner are not. Resolve supported input/output
   mappings, bind compatible built-in test packs and prepare the managed instance.
   Implement recording doubles and evidence events; connect the shared budget
   controller to qualified model access, worker cancellation and cleanup. Qualify
   both normal-task success and forbidden-boundary outcomes.
   Missing access or ambiguous targets become interface choices, not user code.
3. **Deliver the React + Vite workflow.** Expose static scan/inventory/findings and
   dynamic target selection, access/budget setup, progress, cancellation, evidence,
   saved profiles, local history and reruns through a local service using the same
   engine. Complete the real-model no-code acceptance journey before closing M6a.

HTTP/project expansion follows in M6b, MCP/CI in M6c, and indirect prompt injection
in M7. Their acceptance criteria remain in [ROADMAP.md](ROADMAP.md).
