# ADR 0007 — Bound work before adding active requests

Status: static limits accepted; local active budgets implemented.

Capture defaults are 50,000 directory entries, 2 MiB per text file, 500 MiB total,
and depth 64. Oversize/racing input fails closed, while excluded and unsupported
formats are reported as skipped. Device/FIFO/socket, symlink and hardlinked input
are not read. The parser runs under container resource and wall-time bounds, and
its output is capped and validated before storage.

The local fixed-suite broker adds atomic attempt reservation, concurrency slots,
bounded request/response bodies, no redirect following, cancellation signalling,
and a strict/request-only cost guard. Strict plans fail closed at queue time until
a trusted target-side cost limit or telemetry adapter exists; request-only plans
require explicit acknowledgment and persist target cost as unknown. Cancellation is persisted in the run ledger
and is allowed to reach a worker while it owns the project worker lock. The broker
only resolves registered local loopback targets; staging/remote dispatch is not
enabled. Raw input may temporarily consume significant host memory; large-
repository benchmarking and streaming are pending.
