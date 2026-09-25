# ADR 0013 — Bounded fixed-suite broker for local and staging targets

Status: accepted and implemented for local loopback fixtures and HTTPS staging
transport contracts; no production mode.

Active testing must establish consent and a bounded scope before any request is
sent. A `PlanSpec` records the exact target origin, paths, methods, snapshot,
identity, data classes, fixed case IDs, and budgets. An approval stores the plan
and scope digests, actor, acknowledgment, expiry, and one-use state. Consuming an
approval and creating the run happen in one transaction.

The runner is a bounded native fixed suite with one reviewed case for each
OWASP LLM 2025 category. Direct policy handling, synthetic disclosure, tool
authorization, and tenant-boundary semantics retain observer-backed fixtures;
the other categories use explicit response-marker contracts. It sends only JSON
test envelopes through `RequestBroker`; it does not execute target code, load
repository commands, or invoke arbitrary Promptfoo providers. The broker validates registered paths/methods, resolves DNS on every
dispatch, requires loopback for local mode or globally routable addresses for
staging, connects directly to the pinned literal address, preserves the
registered hostname for HTTPS SNI/Host, disables proxy inheritance, caps
request/response bytes, never follows redirects, enforces an absolute wall-time
deadline across real-socket reads including delayed headers and trickle bodies,
and reserves attempts atomically. Target response text is redacted and is never trusted as an
observer proof; trace-required cases pass only with the explicit observer marker.

Cancellation is a control-plane database update that can run while the data-plane
worker owns `worker.lock`. The worker checks the cancellation flag before each
case, and the broker rejects new dispatches after cancellation. This avoids the
deadlock where a cancel endpoint waits for the worker to finish before recording
intent. The local implementation also provides a bounded job-scoped Unix-socket
IPC contract for dispatch, cancel, and stats with a per-job capability, exact
request/response schemas, frame limits, deadline-aware responses, and
inode-checked cleanup. Each reviewed case runs in a separate OS-confined worker
process. On macOS, Seatbelt denies network access except to that job's exact
broker socket path. On Linux, bubblewrap places the worker in a network
namespace and exposes the broker socket as a read-only mount. The worker gets a
minimal environment and no target credentials; observer calls are relayed over
stdio pipes and checked against the current attempt by the trusted parent. The
broker remains a separate process with the only target-network access. Active
capability probing fails closed when the platform sandbox cannot start. The
macOS direct-egress regression passes locally. Linux bubblewrap, clean-host, and
full platform matrices remain unverified.

Arbitrary URLs, credential injection, adaptive generated cases, Promptfoo
execution, live production targets, and production-security claims remain
disabled. Live staging verification, complete DNS-rebinding, crash/recovery,
production sidecar observer deployment, and platform acceptance matrices remain
release gates; local fixture/native-replay observer binding and the bounded signed
ingress contract are implemented and tested.
