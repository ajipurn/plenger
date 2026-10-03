# llmfy runtime qualification

This is the first executable M6a feasibility check. It runs a bundled, unmodified
llmfy fixture inside a constrained Podman container using synthetic model
responses. It does **not** run arbitrary user projects or establish support for
live providers. M6a remains incomplete.

## Reproduce

With an active Podman Linux backend and Node/pnpm installed:

```sh
pnpm qualify:llmfy
```

This developer command builds the pinned image, prints both runtime and host-budget
qualification JSON reports including the immutable image ID, and runs the container
integration tests.
Image setup downloads the fixed base image and six pinned Python packages. Only
hashed wheels are accepted; no application manifests, install scripts or `.env`
files are read. The build context is restricted by `runtimes/llmfy/.dockerignore`.
The test worker has networking disabled and makes no live model requests.

The base image is pinned by digest in `runtimes/llmfy/Dockerfile`. The Python lock
file was generated with:

```sh
uv pip compile runtimes/llmfy/requirements.in --python-version 3.12 \
  --python-platform aarch64-unknown-linux-gnu --only-binary :all: \
  --exclude-newer 2026-09-29 --generate-hashes --no-header --no-annotate \
  --output-file runtimes/llmfy/requirements.txt
```

The regular `pnpm check` remains offline and skips the container integration
tests. To test an already built qualification image, set
`PLENGER_TEST_LLMFY_IMAGE` to its full `sha256:` image ID and run
`pnpm exec vitest run test/redteam-runtime.test.ts`. Mutable tags are rejected.
The image must be built from this repository's trusted qualification recipe;
this interface is not an API for accepting arbitrary images or reports.

## Configuration exercised

| Item | Configuration |
| --- | --- |
| Host | macOS 27.0, Apple silicon |
| Backend | Podman 6.0.2, Fedora 44 Linux VM, cgroups v2; rootful daemon |
| Container | Linux arm64, Python 3.12.13, worker UID/GID 65532 |
| Framework | llmfy 0.11.0, pydantic 2.13.5; all transitive packages pinned with hashes |
| Provider | Synthetic `BaseAIModel` with OpenAI chat message formatting; no provider SDK/network |
| Entry shapes | Sync text function, async text function, zero-argument LLMfy factory |
| Tool shape | Synchronous decorated Python function with string arguments and result |
| Effect substitution | Exact fixture `Path.write_text` destination intercepted after the original handler's approval check |

Other architectures, rootless Podman, Docker, Windows, FlowEngine, streaming,
asynchronous tool handlers and real provider SDKs have not been qualified by this
recipe. The configured daemon runs as root within the VM; the test container
itself runs as a non-root user. No global Podman connection setting is changed by
the script, and it does not start or stop the user's VM.

## Isolation and process lifecycle

`qualifyLlmfy()` in `src/redteam/qualification.ts` launches the fixed worker with
no host mounts, network disabled, a read-only root filesystem, all Linux
capabilities removed, no-new-privileges and the backend's seccomp filter. Writable
temporary space is a private 16 MiB tmpfs. Limits are 256 MiB memory, no swap,
64 processes and one CPU. Host proxy variables are not forwarded.

Before importing llmfy or the fixture, the worker checks its Linux/Python version,
UID/GID, effective/bounding capabilities, privilege/seccomp flags, network
interfaces, mounts and cgroup limits. It also verifies that a real host marker
file and a host environment sentinel are inaccessible. Failure stops before
fixture import. These are concrete configuration checks, not a proof against
container/kernel escape or malicious code forging in-process evidence.

The host bounds combined stdout/stderr to 64 KiB and applies a deadline. Timeout,
AbortSignal cancellation and output overflow kill the CLI connection and remove
the specifically named worker with zero stop grace. Automatic removal and a
daemon-side lifetime limit provide a fallback if the host process disappears;
that limit is `ceil(timeoutMs / 1000) + 10` seconds from container startup, whereas
the host deadline also counts launch time. Cleanup
errors are surfaced with the container name and preserve the original failure.
Abrupt host-process death is not covered by the integration tests yet.

Verified on 2026-10-02: 18 worker environment checks, the seven original synthetic
llmfy cases, the additional host-budget scenarios below, and all 13 TypeScript
qualification tests passed. Container-dependent tests are exercised separately
by `pnpm qualify:llmfy`; the regular suite stays offline. The tested image ID was
`sha256:ac57f68b02ce4fbd9a9f571633f653d96fa01e17580e795b964f243ae28c668c`.
Rebuilding may produce a different image ID; every qualification report records
the image actually tested.

## What the synthetic suite proves

The fixture is ordinary llmfy application code and is not rewritten by the
qualification driver. The driver substitutes only the model class and the exact
recording effect, and wraps tool registration for observation while calling the
original handler. It records three distinct stages: model proposal, entry into
the handler, and arrival at the recording effect.

| Case | Required result |
| --- | --- |
| Approved sync task | Expected synthetic update and expected final response |
| Approved async task | Same successful task through the async entry point |
| Approval denied inside handler | Handler runs, but no recording effect is reached |
| Deliberately unguarded handler | Forbidden recording effect produces `violation_observed` |
| Proposal without tool execution | `inconclusive`; proposal alone is insufficient evidence |
| Repeated model/tool loop | Stub call limit stops the loop; incomplete work is `inconclusive` |
| Violation before a later limit | Confirmed violation remains recorded despite incomplete execution |

The Python worker asserts these seven outcomes, and the TypeScript integration
suite also exercises timeout, cancellation, output overflow, refusal without
isolation controls, and absence of leftover qualification containers. Fresh
fixture modules and private container temporary storage isolate test state.

The model responses are deterministic test doubles, so these results measure the
framework path and the observation/oracle design. They do not measure prompt
injection resistance. The per-case stub call limit does not satisfy the roadmap's
run-wide provider call/token budget contract by itself. The host-budget path below
adds a separate integration check. Recording an effect proves arrival at that
intercepted boundary, not a completed production write.

## Host-budget qualification

`qualifyLlmfyBudget()` uses the same image and isolation controls. The fixture's
model adapter sends the complete outgoing messages and tool declarations to the
host through stdio and waits for a correlated response. The worker emits readiness,
trial lifecycle and tool-stage events on the same newline-delimited JSON channel.
The host validates their sequence, admits requests using one `ModelBudget` and
generates synthetic responses. Worker-provided usage fields do not affect accounting.

Input and output units use the explicit test profile `synthetic-utf8-bytes-v1`:
one UTF-8 byte of the serialized model payload/response is one synthetic token.
The host reserves the full input size and 1,024 output units before generating
each response, then confirms its measured usage. These units are deterministic
for qualification and do not represent a live provider's tokenizer or billing.

The worker still has `--network=none`, no credentials and no host mounts. Stdio
frames are decoded as strict UTF-8/JSON, processed in order and bounded by the
64 KiB combined output limit and 256 messages. Model payloads have a 48 KiB limit.
Messages, tool declarations and raw model responses are excluded from the report;
only the fixed fixture's accepted event fields and usage totals are retained.

| Case | Required result |
| --- | --- |
| Sync/async controls and three probes | Five trials complete through one budget; all nine model calls admitted, with no failure merely for reaching that call cap |
| Guarded repeating loop | Control consumes two calls; third call reaches the denied handler; fourth request exhausts the shared budget and leaves the loop inconclusive |
| Unguarded repeating loop | Same exhaustion, with an independently observed violation retained |
| Insufficient token reservation | Zero model calls admitted; active trial incomplete and later cases unstarted/unevaluable |
| Deadline during blocked handler | Streamed violation retained, handler completion never claimed, worker removed |
| Cancellation during blocked handler | Same partial-evidence and cleanup behavior |

Budget stops abort the host connection and explicitly remove the named container
before returning the partial report. Cleanup failures propagate, preserving the
original failure. Protocol errors and unexpected worker exits also fail qualification.
The report is `kind: "llmfy-budget-qualification"`, includes a budget snapshot with
`enforcementScope: "submitted-dispatches"`, and keeps `liveModelQualified: false`.
It is a developer qualification artifact, separate from the future dynamic-run schema.

This verifies the trusted fixture's path through the broker, not evidence authenticity
for hostile project code. An arbitrary worker could fabricate in-process observations;
sequence validation alone cannot establish that a project actually crossed a boundary.

## Still required before project execution

- Resolve project dependencies and supported entry/input/output shapes without
  importing application code; prepare a clean snapshot without ambient secrets.
- Bind built-in test packs from verified semantics, not tool names alone, and
  preserve project-specific approval logic at supported effect interceptions.
- Enforce every live provider request through a network path with run-wide call
  and token admission limits, including retries, controls and agent loops.
- Qualify real-model behavior on a representative unmodified project using access
  and budgets selected by the user, then test cancellation and partial reporting.
- Authenticate and correlate observations from managed workers before treating
  them as dynamic-run evidence; the current trusted fixture report is separate.
- Connect the shared engine to offline planning, saved profiles and the React +
  Vite setup/run/results workflow. No user-written wrapper is part of acceptance.

Framework reference: [llmfy 0.11.0](https://pypi.org/project/llmfy/0.11.0/).
Container controls follow the [Podman run options](https://docs.podman.io/en/latest/markdown/podman-run.1.html).
