# Worker protocol version and host-death cleanup on Docker (2026-10-04)

Developer qualification of both managed runtimes after the worker frames gained
`protocolVersion` 1 and the llmfy worker gained its own 130 second deadline.
Synthetic or scripted models only; no live model was contacted. See
[../design/worker-protocol.md](../design/worker-protocol.md).

| Item | Value |
| --- | --- |
| Host | macOS 27.0, Apple silicon |
| Backend | Docker Desktop engine 29.8.0 |
| llmfy image | `docker:sha256:5713b04289dd7dd29575c3cf92e252af9b49afb5926ac2d2bde932c158184197` |
| Vercel image | `docker:sha256:13301760618dc1909f383f55339ccdc18fca228ba634c512762bec49ac7f56e3` |
| Provider | Synthetic (llmfy) and scripted (Vercel); worker networking disabled |

Results:

- `pnpm qualify:llmfy` passed the suite, the budget qualification and all 20
  runtime and worker integration tests.
- Host death: a host process killed with SIGKILL left its worker running. The
  expiry sweep kept that container before its `org.plenger.expires` time and
  removed it afterwards (`test/redteam-runtime.test.ts`).
- Worker deadline: inside the llmfy image, `start_deadline()` ended a sleeping
  process after 131 seconds with exit code 124, although the process had
  replaced `os._exit`.
- For comparison, with the previous llmfy image a worker and its `docker run`
  client were still running 26 seconds after their host was killed.
- `pnpm qualify:vercel` passed all 17 tests in
  `test/redteam-vercel-run.test.ts`.
- Both real workers refused a request without `protocolVersion` 1: the llmfy
  worker exited 1 before `ready`, the Vercel worker sent `failure` with stage
  `reading-request`.

Not covered: Podman on this host, and any live model. Status:
[../STATUS.md](../STATUS.md).
