# ADR 0009 — Durable static jobs and per-project content identity

Status: accepted for static runs; active ledger extensions are implemented locally.
Supplements ADR 0005/0008 and does not authorize production active runs.

Migration 0002 adds projects, runs, monotonic run events and snapshots. SQLite
transactions make idempotency lookup/create atomic. A request key reused with a
different body or config hash conflicts. At most two queued/running jobs are
accepted per project; the API executes through one worker thread. An OS advisory
lock prevents a second process running a worker concurrently for the same project.
Schema migration also uses a local lock. Configuration is checked again before
execution; drift blocks the queued run.

Report, snapshot and final run state commit atomically. Exceptions persist a safe
reason, without exception text/source. Startup marks stale queued/running jobs
interrupted only while holding the project worker lock. Nothing is replayed
automatically. Migration 0008 adds owner-bound leases/heartbeats, and migration
0009 adds a bounded redacted `active_attempts` ledger. Active cases are marked
`in_flight` before dispatch and converted to an explicit `process_interrupted`
error during startup recovery; completed cases survive a pre-report crash. The
dispatch crash, report-write crash, and an actual killed worker-process path are
covered by integration tests; broader multi-process and platform recovery cases
remain outside the local checkpoint.

Capture manifests contain relative paths, UTF-8 size, per-file HMAC-SHA256 and a
manifest digest. The random per-project key stays in private SQLite and is never
included in browser responses or exports. This is deliberately stricter than
unkeyed content hashes for low-entropy secrets. Commit/dirty are probed when Git
is available using fixed argv, no shell, bounded output and a timeout; unavailable
fields remain null with an explicit limitation. A symlinked `.git` is treated as
unknown, and target code or Git hooks are not executed.

The browser has authenticated static scan/run/graph/finding/export routes. Scan
requires CSRF and Idempotency-Key. Summary arrays are capped at 100; separate graph
and findings endpoints paginate, while authenticated exports contain the full
stored report. Migration 0007 extends the ledger with plan/approval references,
bounded attempt accounting and cancellation state for the local fixed suite; the
later attempt table exposes that accounting through an authenticated API route.
The active API supports only the reviewed fixed suite through the bounded local or
HTTPS staging broker; it has no production target path or hosted evaluator
execution route.
