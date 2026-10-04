# llmfy runtime: synthetic qualification on Docker (2026-10-04)

Developer qualification of the bundled llmfy runtime with `pnpm qualify:llmfy`
using Docker Desktop as the engine. No live model was contacted. See
[../design/llmfy-runtime.md](../design/llmfy-runtime.md).

| Item | Value |
| --- | --- |
| Host | macOS 27.0, Apple silicon |
| Backend | Docker Desktop engine 29.8.0, cgroups v2 |
| Container | Linux arm64, Python 3.12.13, worker UID/GID 65532 |
| Framework | llmfy 0.11.0 |
| Image | `docker:sha256:df2f478ae89e354e791a24cb4eeea0038ccace38e49fccdf9cc6fc9dde6ec47a` |
| Provider | Synthetic; worker networking disabled |

Results:

- All 19 runtime and worker integration tests passed, including prepared
  guarded and unguarded project handlers through `worker.py`, budgets,
  cancellation and cleanup.
- The `loopback-only` check now inspects interface `IFF_UP` flags, because
  Docker exposes dormant DOWN tunnel interfaces with networking disabled. Only
  loopback may be UP, and all capabilities remain dropped so those interfaces
  cannot be activated.

Not covered: abrupt host-process death and Docker cleanup after it. Docker has
no daemon-side lifetime cap in this launcher. Status: [../STATUS.md](../STATUS.md).
