# FastAPI profile, checkpoint 1: build and import of a team project

This records the first complete `plenger redteam prepare` on an unmodified
team project, the acceptance target of the FastAPI project profile
([design/fastapi-profile.md](../design/fastapi-profile.md)). The stage
builds the project's dependencies, starts disposable services, imports the
application in an isolated worker and probes one route. It makes no model
call and runs no attack; it establishes that the profile can host this
application.

- Project: Dayatech `py-new-assessment-center`, FastAPI 0.115.14 with llmfy
  0.6.0, 69 HTTP routes and 23 llmfy agents declared, MySQL, Redis, S3,
  Bedrock, LiveKit and LlamaIndex in its dependencies.
- Report: `4bec8c30-3d69-4b67-9320-50e1d2169a5a`; started
  `2026-10-06T06:42:10.542Z`, finished `2026-10-06T06:42:44.541Z`.
- Snapshot: policy `python-resources-v1`, 635 files (442 Python, 193 text
  resources under the application's packages), source digest
  `8809e9155497ef2d6289146d50245743c7e53d35836b155ae432c1f4dbf3227a`.
  Target `fastapi:063462206212985a`, the `app.main:app` object, selected
  automatically.
- Runtime: Docker Desktop 29.8.0 on macOS Apple Silicon; image
  `sha256:ed8e3002929e8a1e23682e7ffa03c7e3e5354560477832ca4507363819229984`
  built for `linux/amd64` after the native build found no arm64 wheel for
  `html-to-markdown` 2.8.3; Python 3.12.13; 119 packages installed from wheels
  only. Resolved versions recorded in the report include `llama-index 0.14.3`,
  `websocket-client 1.9.2` and `pytz 2026.5` for the three unpinned
  declarations.
- Services: `mysql:8.4` and `redis:7.4-alpine`, pinned by digest, on an
  internal network with no route out; both answered before the worker
  started.
- Settings: two supplied by the operator (`KNOWLEDGE_S3_BUCKET`,
  `KNOWLEDGE_PREFIX`), nine placeholders for SDK credentials and regions,
  eight service settings. Values are not in the report.
- Worker: all 19 isolation checks passed, including `private-network-only`
  and `no-default-route`; the llmfy 0.6.0 adapter replaced `BedrockModel`,
  `OpenAIModel` and `GoogleAIModel` at the package and module level and
  wrapped `LLMfy.register_tool` (seven names).
- Import: `FastAPI` application in 4,721 ms with 73 routes, 23 of them POST;
  the application's scheduler started against the disposable Redis inside the
  worker's event loop.
- Probe: `GET /` answered HTTP 200 with 144 bytes.
- Model calls: 0. Tool handlers observed: 0. Cleanup confirmed; no container
  or network remained afterwards. Wall time 38 seconds with the dependency
  layer cached; the first build took about eight minutes.

## What the earlier attempts taught

Eight attempts failed before the first completed one, each for a reason that
is now part of the profile. The ninth completed but its adapter had missed
llmfy 0.6.0's `OpenAIModel` class (0.11 calls it `OpenAIChatModel`); the
recorded run is the tenth, after that fix.

| Attempt | Failure | Change |
| --- | --- | --- |
| 1 | MySQL never became ready | Its entrypoint needs `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID` and `SETUID`; all other capabilities stay dropped |
| 2 | Redis never became ready | Its entrypoint drops privileges with `setpriv`; the container now starts as the redis user with no capabilities |
| 3 | Worker exited without `finished` | The worker now reports the failing stage and exits non-zero; `os._exit(0)` had hidden the error |
| 4 | `PermissionError` on the adapter file | `COPY --chmod=0444` had applied the mode to the created directory; the recipe creates it with 0755 first |
| 5 | Prompt file `bars_assessor_prompt.md` missing | Snapshot policy `python-resources-v1`: text resources under captured Python packages travel with the code |
| 6 | Plan blocked: a markdown template flagged as a credential | The detector no longer treats `key=value` examples in quoted text as secrets |
| 7 | `KNOWLEDGE_S3_BUCKET` missing at import | Operator settings through `--env` and placeholders for SDK credentials |
| 8 | `no running event loop` from `AsyncIOScheduler.start()` | The import and the probe run inside a running event loop, as under uvicorn |

Earlier, before any worker ran, the credential detector had excluded seven
Python files (an ORM model, test files and services) over `password =
Column(...)`, `call_`/`tooluse_` ids and compound identifiers; those rules
were corrected in the same change.

## What this establishes and what it does not

Established: this application, unmodified, imports and serves a route inside
the profile's isolation with disposable services, every llmfy model class
routed to the broker, no network route out, and bounded resources. The build
is reproducible from the recipe, the requirements text and the platform.

Not established: no attack, case or model call ran; the Podman engine, other
hosts and other platforms are untested; the knowledge and report routes that
need S3 were not exercised; settings were supplied by hand rather than saved
in a profile. Checkpoints 2 to 4 in the design cover these.

Current qualification status is in [../STATUS.md](../STATUS.md#qualified-versus-pending).
