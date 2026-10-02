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

This developer command builds the pinned image, prints a qualification JSON report
including its immutable image ID, and runs the container integration tests.
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

Verified on 2026-10-02: 18 worker environment checks, seven synthetic llmfy cases,
and all seven TypeScript qualification tests passed. The regular suite passed
273 tests, with the six container-dependent tests skipped in that offline run;
they were exercised separately by `pnpm qualify:llmfy`. Typecheck, lint and build
also passed. The tested image ID was
`sha256:7e673220288b280db8480c6a073d40495305e98a77a6139b737733cb6f1b2ba0`.
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
run-wide provider call/token budget contract. Recording an effect proves arrival
at that intercepted boundary, not a completed production write.

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
