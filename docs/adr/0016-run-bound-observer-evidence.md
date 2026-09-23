# ADR 0016 — Run-bound observer evidence

Status: accepted; bounded local fixture transport and signed ingress contract
implemented; production deployment remains a release gate.

Response bodies and model-written trace fields are untrusted. An observer event
must not be reusable across runs or attempts, because that could turn evidence
from another execution into evidence for the current target request.

The active runner starts each attempt with `run_id`, `attempt_id`, and a positive
sequence number. The local fixture observer stores events by the tuple
`(case_id, run_id, attempt_id)`, adds a bounded timestamp, and only returns an
event when the requested binding matches. The runner validates the binding again
before applying an observer-backed oracle; a missing or mismatched event is
`inconclusive`, never a pass.

Run-bound requests carry the same three values under
`test_context.observer_context` so an approved sidecar can construct a signed
event for the exact attempt. That metadata is context only; response JSON and
model-written trace fields remain untrusted.

The observer keeps only the allowlisted, bounded fields in memory. Active attempt
storage retains the redacted result and observer evidence digest, not raw trace
content. A production observer may replace the fixture implementation only when
it supplies the same binding and an independently authenticated or signed event
transport. The local signed ingress contract uses a canonical JSON envelope with
`event_id`, `case_id`, `run_id`, `attempt_id`, `sequence`, timezone-aware
`timestamp`, and an allowlisted `trace`; HMAC-SHA256 signatures require a
32-byte key. It rejects unknown/missing fields, invalid signatures, replayed or
duplicate events, mismatched attempts, malformed timestamps, and events beyond
the bounded in-memory capacity/size limits. The JSON-body adapter rejects
non-standard constants and oversized bodies before verification. No
unauthenticated trace endpoint is exposed by the default API. An opt-in Unix
socket adapter adds a per-instance capability, owner-checked parent, `0600`
socket, one-frame bounded protocol, and inode-checked cleanup. The API
background runner, synchronous `run` CLI, and `serve` CLI now accept this
observer explicitly; the CLI loads only an owner-only `0400`/`0600` key file and
uses a short-lived owner-only runtime directory by default. Approved production
sidecar deployment, signer provisioning, and live verification remain
unverified.
