# llmfy runtime: synthetic qualification on Podman (2026-10-02)

Developer qualification of the bundled llmfy runtime with `pnpm qualify:llmfy`.
No live model was contacted. See [../design/llmfy-runtime.md](../design/llmfy-runtime.md)
for the recipe and the suite.

| Item | Value |
| --- | --- |
| Host | macOS 27.0, Apple silicon |
| Backend | Podman 6.0.2, Fedora 44 Linux VM, cgroups v2 |
| Container | Linux arm64, Python 3.12.13, worker UID/GID 65532 |
| Framework | llmfy 0.11.0, pydantic 2.13.5; all transitive packages pinned with hashes |
| Image | `sha256:ac57f68b02ce4fbd9a9f571633f653d96fa01e17580e795b964f243ae28c668c` |
| Provider | Synthetic `BaseAIModel`; no provider SDK or network |

Results:

- 18 worker environment checks passed before fixture import.
- The seven synthetic llmfy cases passed (approved sync and async tasks,
  approval denied, unguarded handler, proposal only, loop call limit, violation
  before a later limit).
- The host-budget scenarios passed (shared calls across five trials, guarded and
  unguarded loop exhaustion, insufficient token reservation, deadline and
  cancellation during a blocked handler).
- All 13 TypeScript qualification tests passed.

Rebuilding may produce a different image id; every qualification report records
the image actually tested. This qualifies the trusted fixture's path, not
arbitrary projects or a live provider. Status: [../STATUS.md](../STATUS.md).
