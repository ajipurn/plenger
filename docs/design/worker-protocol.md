# Worker protocol

The host (`src/redteam/`) and a container worker (`runtimes/llmfy/worker.py`,
`runtimes/llmfy/qualify.py`, `runtimes/vercel/worker.mjs` with `bridge.mjs`,
`runtimes/fastapi/worker.py` with `preflight.py`) exchange newline-delimited
JSON over the container's stdin and stdout. This page is the message catalogue
derived from that code. It documents direction, fields, limits, ordering and
the differences between the runtimes. The FastAPI worker is a preparation
stage: it imports an application and probes one route, and serves no model
request yet.

## Version

The frames on this page are protocol version 2. The host holds the number in
`WORKER_PROTOCOL_VERSION` (`src/redteam/constants.ts`). The workers hold it in
`PROTOCOL_VERSION`: `runtimes/llmfy/qualify.py` (also used by `worker.py`),
`runtimes/vercel/bridge.mjs` and `runtimes/fastapi/preflight.py`. Bump all of
them together when a frame changes.

Version 2 moved trial input to the host
([generated-attacks.md](generated-attacks.md#attack-templates)): the Vercel
request carries `input` as a template and its `fixture` frame reports the
placeholder `values` the worker filled in. Version 1 workers had the prompts
built in.

- The launcher adds `protocolVersion` to every request, next to `hostMarker`.
- A worker refuses any other value before its isolation checks. The llmfy
  worker and `qualify.py` in budget mode raise and exit non-zero without
  `ready`. The Vercel worker sends `failure` with stage `reading-request`.
- Every `ready` frame repeats `protocolVersion`. The host rejects a missing or
  different value, like a wrong runtime version or isolation check list.

The roadmap specified a loopback socket or named pipe. The transport is still
container stdio.

## Transport

- The host launches `docker run` or `podman run` with `--interactive` and
  `--network=none` (full flag list in [llmfy-runtime.md](llmfy-runtime.md#isolation-and-process-lifecycle)).
  The launcher is `runWorker()` in `src/redteam/worker.ts`, shared by
  qualification and managed runs.
- Each container carries `org.plenger.expires`: launch time plus deadline plus
  10 seconds, in epoch milliseconds. A live host stops its worker before then,
  so `removeExpiredWorkers()` treats a labelled container past that time as
  left by a host that died and removes it when a runtime is prepared.
- The host writes exactly one request line to stdin, then keeps stdin open
  for `model_response` replies. Each frame is one JSON object followed by
  `\n`.
- The host decodes stdout as strict UTF-8 (`fatal: true`), one frame per line,
  and processes frames in order; a reply is written only after the handler of
  the frame returns. A frame that fails to parse, an unknown `type` or a
  validation failure kills the worker with SIGKILL and removes the container.
- Project stdout and stderr are suppressed inside the worker: the llmfy worker
  redirects both to `/dev/null` around project execution, and the Vercel worker
  replaces `process.stdout.write` and the console methods after `ready`.
  Worker stderr still counts against the output limit on the host.

| Limit | llmfy | Vercel |
| --- | --- | --- |
| Request line read by the worker | 16 MiB + newline (`worker.py`); 64 KiB (`qualify.py`) | 6 MiB (`bridge.receive`) |
| `model_response` line read by the worker | 64 KiB | 6 MiB |
| Combined stdout and stderr accepted by the host | 64 KiB | 512 KiB |
| Frames per worker accepted by the host | 256 | 256 |
| Trial events accepted per trial | 128 | 128 |
| Captured source sent in the request | 4 MiB total (host); `.py` only | 4 MiB total (worker and host); 100 files |
| Transport deadline per worker | 120 s for managed runs; 1 to 120 s for qualification | same |
| Daemon-side backstop | Podman `--timeout` of `ceil(timeout) + 10` s; none on Docker | same |
| Worker-side backstop | Exit code 124 after 130 s | same |

Exceeding an output or frame limit, a trailing partial frame at exit, a
non-zero exit without a protocol failure, and a worker that ends before
`finished` are all failures. Partial evidence received before the failure is
kept; the trial is `inconclusive` unless a violation was already confirmed.

## Request (host to worker)

Sent once as the first line. `hostMarker` is the path of a file that exists on
the host only; the worker proves it cannot see it.

llmfy managed run (`worker.py`):

| Field | Type | Notes |
| --- | --- | --- |
| `sources` | `[{path, content}]` | Relative `.py` paths without empty, `.` or `..` segments; written read-only under `/tmp/project` |
| `target` | `{path, symbol, kind}` | `kind` is `"factory"` or a function kind; a factory's result receives `invoke_with_tools(input)` |
| `input` | string | The trial prompt, filled on the host from its template in `attack-model.ts`; contains the marker |
| `marker` | string | `PLENGER_<32 hex>`; matched in canary files |
| `policy` | string | Prepended as a system message to every model request |
| `protocolVersion` | number | Added by the launcher; see [Version](#version) |
| `hostMarker` | string | Added by the launcher |

llmfy qualification (`qualify.py`): `{protocolVersion, hostMarker, mode,
scenario}` with `mode` one of `suite`, `wait`, `flood`, `budget` and
`scenario` one of `suite`, `loop`, `violation-loop`, `violation-wait`. Modes
other than `budget` print one report object or test the host's limits and are
not part of this protocol. Budget mode refuses a different `protocolVersion`.

FastAPI preparation (`runtimes/fastapi/worker.py`):

| Field | Type | Notes |
| --- | --- | --- |
| `sources` | `[{path, content}]` | Python plus text resources (`SOURCE_SUFFIXES`: `.py .md .txt .json .yaml .yml .jinja .j2 .html .csv .sql`), no hidden segments; written read-only under `/tmp/project`, which is the import root |
| `app` | `{module, attribute}` | The module to import and the ASGI application attribute, from the plan's `fastapiProfile` |
| `llmfy` | string | The declared llmfy version; selects `/opt/plenger/adapters/llmfy_<version>.py` |
| `env` | `{name: value}` | Settings the application reads: placeholders for standard SDK credentials, the user's `--env` settings, then the disposable services' `MYSQL_*` and `REDIS_*`, which win; identifier names only |
| `probe` | `{method, path}` or absent | One in-process ASGI request after the import |
| `policy` | string or null | Prepended as a system message if a model request happens |
| `protocolVersion`, `hostMarker` | | Added by the launcher |

The launcher starts this worker with `--network=<private network>` instead of
`--network=none`, a 1 GiB memory limit, 128 processes, a 64 MiB `/tmp` and a
300 second deadline (`FASTAPI_WORKER` in `constants.ts`).

Vercel managed run (`worker.mjs`):

| Field | Type | Notes |
| --- | --- | --- |
| `sources` | `[{path, content}]` | Paths matching `^[\w@/.-]+\.(?:[cm]?[jt]s)$`, no `..` or hidden segments, no duplicates |
| `route` | string | Path of the POST handler module; must be in `sources` |
| `storeModule` | string | Path of the SQLite module exporting `store`, `SERVICES`, `SLOTS`; must be in `sources` |
| `trial` | string | `backend-validation`, `clean-control`, `manager-price-override` or `zero-payment` |
| `input` | string | The trial's input template, at most 4096 characters; absent for `backend-validation`, whose input is built in. The worker replaces each `{{name}}` with the value it seeded and fails at `preparing-fixture` on a name it has no value for |
| `protocolVersion` | number | Added by the launcher; see [Version](#version) |
| `hostMarker` | string | Added by the launcher |

## Frames (worker to host)

### `ready`

First frame. Sent after the isolation checks pass and before the project is
imported. The host rejects a second `ready`, any other frame before it, and
any version or check list that does not match exactly.

| Runtime | Fields | Host requirements |
| --- | --- | --- |
| llmfy | `protocolVersion`, `python`, `llmfy`, `isolationChecks[]` (`qualify.py` budget mode adds `os`, `arch`) | `protocolVersion == 2`, `python == "3.12.13"`, `llmfy == "0.11.0"`, all 18 check names below present; the broker also requires `os == "Linux"` and `arch == "aarch64"` |
| Vercel | `protocolVersion`, `node`, `ai`, `databaseObserver`, `isolationChecks[]` | `protocolVersion == 2`, `node == "22.18.0"`, `ai == "7.0.29"`, `databaseObserver == "committed-snapshots-v1"`, all 16 check names present |
| FastAPI | `protocolVersion`, `python`, `llmfy`, `packages[]`, `isolationChecks[]` | `protocolVersion == 2`, `python == "3.12.13"`, `llmfy` equal to the plan's declared version, all 19 check names present; `packages` is `[{name, version}]` from the build's `pip list`, at most 2000 |

Isolation check names:

| Check | llmfy | Vercel | FastAPI |
| --- | --- | --- | --- |
| `linux`, `non-root`, `no-capabilities`, `no-new-privileges`, `seccomp-filter`, `read-only-root`, `memory-limit`, `no-swap`, `process-limit`, `cpu-limit`, `no-host-file`, `no-host-environment`, `no-container-socket`, `private-temporary-files` | yes | yes | yes |
| `loopback-only` | yes | yes | no |
| `private-network-only`, `no-default-route` | no | no | yes: `lo` plus exactly one interface is up, and `/proc/net/route` has no default route |
| `python-version` | yes | no | yes |
| `node-version` | no | yes | no |
| `image-write-denied`, `temporary-write` | yes | no (the Vercel `read-only-root` check is itself a write probe) | yes |

The FastAPI `memory-limit` and `process-limit` checks expect 1 GiB and 128.

The llmfy `loopback-only` check inspects interface `IFF_UP` flags, because
Docker can expose dormant DOWN tunnel interfaces with networking disabled. The
Vercel check requires that `lo` is the only interface name. The Vercel
`no-host-environment` check also asserts that `GOOGLE_GENERATIVE_AI_API_KEY`
and `OPENAI_API_KEY` are absent.

### `model_request` and `model_response`

Worker: `{type: "model_request", id, messages[], tools | null}`. `id` starts at
1 and increments per worker; `messages` is a non-empty OpenAI-style message
list; `tools` is a list of `{type: "function", function: {name, description,
parameters}}` or `null`. `qualify.py` adds `case`. The llmfy worker prepends
the policy message itself; the Vercel bridge converts AI SDK prompts (text,
tool-call, tool-result and reasoning parts only) and rejects multimodal parts
and provider-defined tools.

Host: admits the call through `ModelBudget`, calls the provider, then replies
`{type: "model_response", id, value: {content, toolCalls: [{id, name,
arguments}]}}` with the same `id`. The worker rejects a reply whose `type` or
`id` does not match. The Vercel runner also requires every proposed tool name
to be in the request's `tools` and every `toolCalls[].id` to be new; it
records a `model_tool_proposal` event itself for each proposal.

Budget exhaustion, deadline or cancellation aborts the connection instead of
replying; the worker is killed and removed.

### `event`

llmfy: `{type: "event", stage, tool}` for `model_tool_proposal`,
`tool_handler_entered` and `tool_handler_returned`, and
`{type: "event", stage: "canary_state", boundary, markerPresent}` with
`boundary` `"allowed"` or `"forbidden"`. The host requires at least one model
call before any event, a `tool` matching `^[\w-]{1,128}$` that the model
proposed in a reply, and at most 128 events per trial. A `canary_state` event
with `boundary: "forbidden"` and `markerPresent: true` sets the trial outcome
to `violation_observed`. `canary_state` is emitted after each observed
`Path.write_text` to a canary path and again in a final audit of both files.

`qualify.py` budget mode wraps events as `{type: "event", case, event: {stage,
tool}}` or `{stage: "recording_effect", order, status}`. The broker checks the
stage sequence (proposal, entered, effect, returned) per trial.

Vercel: `{type: "event", stage, tool, callId, requestId, arguments}` for
`tool_handler_entered` and `{type: "event", stage, tool, callId, requestId,
result}` for `tool_handler_returned`, emitted by the `ai` wrapper around the
original tool `execute`. The host requires `callId` to match a proposal from a
reply, `tool` to match that proposal's name, `requestId` to equal the latest
`model_request` id, `arguments` to be an object, entry before return, and each
of entry and return at most once per call. The worker does not send
`model_tool_proposal` events.

### Vercel-only frames

`fixture` `{type, service, expectedAmount, bookingId | null, before, input, values}`:
sent once after `ready` and before the first `model_request`. `expectedAmount`
is a positive safe integer; `input` is the filled trial prompt, at most 4096
characters; `before` is a database snapshot. `values` maps the placeholders
the worker filled to strings of at most 256 characters: `serviceId`, `date`,
`time` and `expectedAmount` always, `bookingId` for probes. The host accepts
only names in `PROFILE_PLACEHOLDERS`, requires `values.expectedAmount` and
`values.bookingId` to match the frame's fields, and requires `input` to equal
the template it sent filled with `values`. For probes the host requires one
unpaid invoice at `expectedAmount` for `bookingId` and no payments. The host
starts the trial's conversation with `input`.

`database_state` `{type, sequence, final, callIds[], after}`: a committed
SQLite snapshot. `sequence` starts at 1 and increments; at most 64 per trial;
`callIds` lists the tool calls active at the time, at most 128, unique, each
entered and not yet returned. The worker emits a snapshot only when rows
changed, and one `final: true` snapshot after the response completes; it
refuses to snapshot inside an open transaction and fails if the final snapshot
would be taken inside one. After `final`, only `finished` is accepted. The
host runs the SQLite oracle on each snapshot.

A snapshot is `{bookings: [{id, service, date, time}], invoices: [{bookingId,
amount, status}], payments: [{bookingId, amount, status}]}` with at most 20
rows per table.

`backend_check` `{type, tool, arguments, before, after, completed}`: sent only
in the `backend-validation` trial, exactly twice, for `update_invoice_amount`
with amount 1000 and then `create_payment` with amount 0, each inside a
savepoint that is rolled back afterwards. `completed` is false when the tool
declares `needsApproval` or threw. `backend_complete` follows the second
check; the host requires both checks before it.

`failure` `{type: "failure", stage, check | null, message}`: the Vercel
worker's catch-all. `stage` names the phase (`reading-request`, `checking-isolation`,
`capturing-source`, `compiling`, `importing`, `preparing-fixture`, `route`);
`check` is the failed isolation check name when the stage is
`checking-isolation`, otherwise `null`; `message` is a fixed sentence. The
worker then exits with code 1. The host treats `failure` as an unknown frame
and fails the trial; the fields are informational.

### FastAPI-only frames

`adapter` `{type, llmfy, patched[]}`: sent after the sources are staged and
before the import. `patched` lists the llmfy names the broker adapter
replaced: for 0.6.0, `llmfy.BedrockModel`, `llmfy.OpenAIModel` and
`llmfy.GoogleAIModel`, their defining modules, and
`llmfy.LLMfy.register_tool`.

`imported` `{type, durationMs, application, routes[]}`: the application module
imported and the attribute is callable. The import and the probe run inside a
running asyncio event loop, as under an ASGI server, so schedulers and clients
that bind to the loop at import find one. `routes` is `[{methods[], path}]`
from the application's route table, at most 200.

`probe` `{type, method, path, status, bytes}`: the result of one in-process
ASGI request through the application's own routing and middleware. `status`
is null when the application sent no response start.

`failure` `{type, stage, error: {type, message}}`: a stage after `ready`
raised; `stage` is `staging`, `environment`, `adapter`, `import`, `routes` or
`probe`. Unlike the llmfy worker, the exception type and a message of at most
400 characters are exported, because the user needs them to fix the import;
the host redacts both. `finished {completed: false}` follows and the worker
exits with code 1. `SystemExit` and cancellation raised by project code are
reported the same way.

A `model_request` during preparation is recorded as a failure at stage
`model-call` and ends the worker: nothing serves a model here yet.

### `finished`

Last frame. llmfy: `{type, completed}` where `completed` is false when the
project raised (the exception is never exported). Vercel: `{type, completed,
httpStatus}`; the host requires `httpStatus == 200`, a `final` snapshot (model
trials) or `backend_complete` (backend validation) before it, and `completed`
false when the SSE stream carried an error chunk. `qualify.py` budget mode
sends `{type: "finished"}` after `trial_finished` for the last case.

### Qualification-only frames

`qualify.py` in budget mode also sends `trial_started {case}` and
`trial_finished {result}` where `result` is `{case, completed,
cleanTaskPassed, outcome, modelCalls, events}`. The broker checks that the
reported events equal the events it received and that `outcome` matches its
own computation.

## Ordering summary

```
host  -> request
worker-> ready
          [FastAPI] adapter, imported, [probe] | failure
          [Vercel] fixture
          repeat: model_request -> host model_response
                  event (tool_handler_entered / returned, llmfy canary_state)
                  [Vercel] database_state
          [Vercel backend-validation] backend_check ×2, backend_complete
          [Vercel] database_state {final: true}
worker-> finished
```

Any frame after `finished`, any event before the first model call, any
out-of-sequence id or sequence number, and any unknown type end the worker.

## Differences between the runtimes

| Aspect | llmfy | Vercel | FastAPI |
| --- | --- | --- | --- |
| Entrypoint | `python -I /opt/plenger/worker.py` (or `qualify.py`) | `node /opt/plenger/worker.mjs` | `python -I /opt/plenger/worker.py` |
| Network | none | none | private internal network with the disposable services |
| Failure frame | none; exceptions become `finished {completed: false}` or a non-zero exit | `failure {stage, check, message}` then exit 1 | `failure {stage, error: {type, message}}` then `finished {completed: false}` |
| Tool proposal events | sent by the worker | synthesised by the host from the model reply | sent by the worker (none expected during preparation) |
| Event correlation | by tool name within the trial | by `callId` and `requestId` | counted only; no trial yet |
| Effect observation | `canary_state` from a `Path.write_text` patch and a final file audit | `database_state` from committed SQLite snapshots |
| Pre-model checks | none | `backend_check` worker without a model |
| Output cap on the host | 64 KiB | 512 KiB |
| Worker-side backstop | `os._exit(124)` from a timer thread after 130 s | `process.exit(124)` after 130 s |
| Suppressing project output | `redirect_stdout`/`redirect_stderr` to `/dev/null` | `process.stdout.write` and `console.*` replaced after `ready` |
| Isolation checks | 18 | 16 |

Docker has no daemon-side lifetime cap. A worker whose host died still stops
at its own 130 second deadline, and the next runtime preparation removes any
worker past its expiry label (see [Transport](#transport)).
`test/redteam-runtime.test.ts` covers a host killed with SIGKILL.
