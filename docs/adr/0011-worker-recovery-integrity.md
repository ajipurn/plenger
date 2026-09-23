# ADR 0011 — Local Docker only, owned-worker recovery and evidence integrity

Status: accepted and tested for the static worker.

Saved Docker contexts may point to remote daemons. plenger now inspects the local
context and refuses anything except an absolute Unix-socket endpoint. Every Docker
operation explicitly selects that socket. A proxy/environment or saved SSH/TCP
context cannot silently receive repository source. This is a local-daemon boundary,
not a claim about the integrity of the host or Docker installation.

Workers carry a managed static-worker label and a name derived from their run UUID.
Recovery holds the project worker lock, selects only that exact name and label,
validates the returned container ID, and removes only the matching container.
A real sleeping test container was removed by startup recovery without replay.
If cleanup cannot be verified, interrupted runs retain orphan_cleanup_pending;
new execution is blocked until cleanup succeeds. Cleanup completion is appended
to the run event sequence. No PID or arbitrary path from scanner output is used.

Report reads check snapshot manifest digest, project/capture identity, redacted
artifact digest and run/snapshot references. Missing and mismatching evidence is
explicitly flagged and the UI warns about it. These checks detect corruption and
reference errors, not a malicious host owner who can rewrite data and hashes.
Legacy v1 metadata digests remain readable; absent legacy snapshot content stays
not_available. Evidence retention expiry/purge and run-bound signed observer
ingress are implemented in later layers. They still do not provide anti-tamper
protection against a same-UID local host owner or constitute production sidecar
deployment.
