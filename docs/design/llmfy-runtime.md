# llmfy runtime

The llmfy runtime is the container image and worker that run an llmfy 0.11.0
project for the `llmfy-file-canary-v1` profile, plus the synthetic
qualification suite that proves the image's isolation and the observation
design. The recipe lives in `runtimes/llmfy/` (`Dockerfile`, `requirements.in`,
`requirements.txt`, `qualify.py`, `worker.py`, `project/agent.py`) and is also
embedded in the standalone binary. Qualification records are in
[../qualifications/](../qualifications/); the current status is in
[../STATUS.md](../STATUS.md#qualified-versus-pending). The user-facing profile
is described in [../guide/redteam.md](../guide/redteam.md#llmfy-file-canary-v1)
and the message protocol in [worker-protocol.md](worker-protocol.md).

## Reproduce

With Docker Desktop or a Podman Linux backend running and Node and pnpm
installed (the launcher prefers Docker when `docker info` succeeds):

```sh
pnpm qualify:llmfy
```

The script builds the pinned image, prints the runtime and host-budget
qualification JSON reports including the immutable image id, and runs the
container integration tests, including prepared source snapshots through
`worker.py`. Image setup downloads the fixed base image and six pinned Python
packages. Only hashed wheels are accepted; no application manifests, install
scripts or `.env` files are read. The managed builder copies the five bundled
recipe files into a private temporary context. The test worker has networking
disabled and makes no live model requests.

The base image is pinned by digest in `runtimes/llmfy/Dockerfile`. The Python
lock file is generated with `uv pip compile`; the exact command is in
[../../CONTRIBUTING.md](../../CONTRIBUTING.md#regenerating-the-runtime-lockfiles).

`pnpm check` stays offline and skips the container tests. To test an already
built image, set `PLENGER_TEST_LLMFY_IMAGE` to its full `sha256:` image id for
Podman, or `docker:sha256:` for Docker, and run
`pnpm exec vitest run test/redteam-runtime.test.ts test/redteam-worker.test.ts`.
Mutable tags are rejected. The image must be built from this repository's
recipe; the variable is not an interface for arbitrary images.

## Configuration exercised

| Item | Configuration |
| --- | --- |
| Host | macOS 27.0, Apple silicon |
| Backends | Podman 6.0.2, Fedora 44 Linux VM; Docker Desktop engine 29.8.0; cgroups v2 |
| Container | Linux arm64, Python 3.12.13, worker UID/GID 65532 |
| Framework | llmfy 0.11.0, pydantic 2.13.5; all transitive packages pinned with hashes |
| Provider | Synthetic `BaseAIModel` with OpenAI chat message formatting; no provider SDK or network |
| Entry shapes | Sync text function, async text function, zero-argument LLMfy factory |
| Tool shape | Synchronous decorated Python function with string arguments and result |
| Effect substitution | Exact fixture `Path.write_text` destination intercepted after the original handler's approval check |

Other architectures, rootless Podman, Windows, FlowEngine, streaming,
asynchronous tool handlers and real provider SDKs are not qualified by this
recipe. The configured daemon runs as root inside the VM; the container runs
as a non-root user. The script changes no global Podman connection setting and
does not start or stop the user's VM.

## Isolation and process lifecycle

The launcher (`runWorker()` in `src/redteam/worker.ts`, used by
qualification and managed runs) starts the worker with no host mounts,
`--network=none`, a read-only root filesystem, all Linux capabilities dropped,
`no-new-privileges` and the engine's seccomp filter. Writable temporary space
is a private 16 MiB tmpfs mounted `noexec,nosuid,nodev`. Limits are 256 MiB
memory, no swap, 64 processes and one CPU. Proxy variables are not forwarded
(`--http-proxy=false` on Podman; emptied on Docker). The container is named,
labelled, started with `--pull=never`, `--restart=no`, `--stop-timeout=0`,
`--no-healthcheck` and `--log-driver=none`.

Before importing llmfy or the project, the worker checks its Linux and Python
version, UID/GID, effective and bounding capabilities, privilege and seccomp
flags, that loopback is the only UP interface, mounts, cgroup limits, that the
host marker file and the host environment sentinel are inaccessible, that no
container socket is present, that the image is write-denied and that the
private tmpfs is writable. These 18 checks are listed by name in
[worker-protocol.md](worker-protocol.md#ready). Failure stops before import.
They are configuration checks, not a proof against container or kernel escape
or against malicious code forging in-process evidence.

The host bounds combined stdout and stderr to 64 KiB and applies a deadline.
Timeout, `AbortSignal` cancellation and output overflow kill the CLI
connection and remove the named worker with zero stop grace. On Podman,
`--rm` and a daemon-side `--timeout` of `ceil(timeoutMs / 1000) + 10` seconds
from container start are the fallback if the host process disappears; the
host deadline also counts launch time. On Docker there is no daemon-side cap;
the launcher confirms removal by polling `docker ps`. Cleanup errors surface
with the container name and keep the original failure.

If the host process dies, nothing kills its worker. The worker then exits by
itself after 130 seconds with code 124; the timer thread holds its own
reference to `os._exit`. Each container also carries an `org.plenger.expires`
label, and preparing a runtime removes labelled containers past that time.
[The 2026-10-04 lifecycle record](../qualifications/worker-lifecycle-docker-2026-10-04.md)
verifies both on Docker.

## What the synthetic suite proves

The fixture is ordinary llmfy application code and is not rewritten by the
qualification driver. The driver substitutes only the model class and the
exact recording effect, and wraps tool registration for observation while
calling the original handler. It records three stages: model proposal, entry
into the handler and arrival at the recording effect.

| Case | Required result |
| --- | --- |
| Approved sync task | Expected synthetic update and expected final response |
| Approved async task | Same successful task through the async entry point |
| Approval denied inside handler | Handler runs, but no recording effect is reached |
| Deliberately unguarded handler | Forbidden recording effect produces `violation_observed` |
| Proposal without tool execution | `inconclusive`; a proposal alone is insufficient evidence |
| Repeated model/tool loop | Stub call limit stops the loop; incomplete work is `inconclusive` |
| Violation before a later limit | Confirmed violation remains recorded despite incomplete execution |

The Python worker asserts these seven outcomes, and the TypeScript suite also
exercises timeout, cancellation, output overflow, refusal without isolation
controls and the absence of leftover containers. Fresh fixture modules and
private container temporary storage isolate test state.

The model responses are deterministic test doubles, so these results measure
the framework path and the observation and oracle design. They do not measure
prompt-injection resistance. The per-case stub call limit does not satisfy the
run-wide budget contract by itself; the host-budget path below adds that
check. Recording an effect proves arrival at the intercepted boundary, not a
completed production write.

## Host-budget qualification

`qualifyLlmfyBudget()` uses the same image and isolation controls. The
fixture's model adapter sends the complete outgoing messages and tool
declarations to the host over stdio and waits for a correlated response. The
worker emits readiness, trial lifecycle and tool-stage events on the same
newline-delimited channel. The host validates their sequence, admits requests
through one `ModelBudget` and generates synthetic responses. Worker-provided
usage fields do not affect accounting. The broker is described in
[redteam-engine.md](redteam-engine.md#qualification-broker).

Input and output units use the test profile `synthetic-utf8-bytes-v1`: one
UTF-8 byte of the serialised payload is one synthetic token. The host reserves
the full input size and 1,024 output units before each response, then confirms
measured usage. These units do not represent a live provider's tokenizer or
billing.

The worker keeps `--network=none`, no credentials and no host mounts. Frames
are strict UTF-8 JSON, processed in order, bounded by the 64 KiB output limit
and 256 messages; model payloads have a 48 KiB limit. Messages, tool
declarations and raw model responses are excluded from the report.

| Case | Required result |
| --- | --- |
| Sync/async controls and three probes | Five trials complete through one budget; all nine model calls admitted, with no failure for reaching that call cap |
| Guarded repeating loop | Control consumes two calls; third call reaches the denied handler; fourth request exhausts the shared budget and leaves the loop inconclusive |
| Unguarded repeating loop | Same exhaustion, with an independently observed violation retained |
| Insufficient token reservation | Zero model calls admitted; active trial incomplete and later cases unstarted and unevaluable |
| Deadline during blocked handler | Streamed violation retained, handler completion never claimed, worker removed |
| Cancellation during blocked handler | Same partial-evidence and cleanup behaviour |

Budget stops abort the host connection and remove the named container before
the partial report is returned. Cleanup failures propagate and keep the
original failure. Protocol errors and unexpected worker exits also fail
qualification. The report is `kind: "llmfy-budget-qualification"` with a budget
snapshot (`enforcementScope: "submitted-dispatches"`) and
`liveModelQualified: false`. It is a developer artifact, separate from the
dynamic run contract in `schemas/redteam-run-v1.schema.json`.

This verifies the trusted fixture's path through the broker, not evidence
authenticity for hostile project code. An arbitrary worker could fabricate
in-process observations; sequence validation alone cannot establish that a
project crossed a boundary.

## Remaining for M6a

Delivered since this recipe was written: source snapshots without ambient
secrets (`python-only-v1`), built-in cases bound to the file-canary contract,
every model request admitted through the host broker with run-wide call and
token limits, correlated and sequence-checked worker events, and the shared
engine connected to planning, saved profiles and the dashboard workflow.
Request and `ready` frames carry `protocolVersion`
([worker-protocol.md](worker-protocol.md#version)), and a worker left by a host
that died stops at its own deadline and is swept at the next preparation.

Still open before M6a is complete:

- Qualify a live model on an unmodified representative llmfy project with
  access and budgets selected by the user, including cancellation and partial
  reporting. Only synthetic models have run through this runtime.
- Qualify the managed provider's request bounds, output allowances and
  charged-token accounting against a live provider.
- Broaden test-pack binding beyond the three file-canary cases, bound to
  verified semantics rather than tool names.

Framework reference: [llmfy 0.11.0](https://pypi.org/project/llmfy/0.11.0/).
Container controls follow the [Podman run options](https://docs.podman.io/en/latest/markdown/podman-run.1.html)
and the equivalent Docker flags.
