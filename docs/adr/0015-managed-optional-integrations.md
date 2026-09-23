# ADR 0015 — Managed optional integrations

Status: accepted; real-engine and hosted verification gates remain open.

Optional scanner integrations are treated as managed executions, not as project
configuration. An explicit `provision-scanners` action records a fixed engine
name, version pin, and either a matching binary hash or an allowlisted immutable
container-image digest, together with a packaged plenger rule/config identity in
the owner-only `.plenger/scanner-manifest.json`. A scan revalidates those values;
changing the manifest after queueing also changes the run config hash and blocks the
run. Execution uses an argument array, a reduced environment, no shell, no automatic
update, a timeout, bounded stdout/stderr, and process-group cleanup.

When an image is absent, `provision-scanners --container --pull` may explicitly pull
only the configured digest through a local Docker context. The flag is never implied
by init, doctor, or scan; a missing image remains unavailable unless this setup action
is requested.

On macOS, host binaries run under `sandbox-exec` with a default-deny Seatbelt
profile: only system runtime paths, the pinned engine installation, the packaged
Semgrep rule, the owner-only staging tree, and the ephemeral runtime home are
readable; only the runtime home is writable and network operations are denied. The
profile is constructed from resolved paths, not project configuration. On Linux
and other platforms, managed scanners run only in the explicit container worker:
the image is digest-pinned, pulled outside scan execution, run with a read-only
root, dropped capabilities, no-new-privileges, a non-root caller UID/GID, bounded
resources, and `--network=none`. A host-binary manifest is unavailable on those
platforms rather than being used as a fallback.

Baseline scanners read an owner-only temporary staging copy of captured text inputs,
not the live repository. Semgrep and Trivy use ephemeral runtime homes. OSV uses a
project-private cache only after an explicit `provision-osv-db` action; normal scan
argv contains `--offline` and `--offline-vulnerabilities`, and database fingerprint,
owner/regular-file identity, size, and seven-day freshness are checked before use.
Missing or changed state is an engine error/unavailable capability, never an empty
successful baseline.
Malformed output, nonzero execution failure, timeout, and overflow become visible
engine errors; they never become an empty successful scan.

Promptfoo output follows the same trust boundary in reverse: plenger imports
bounded JSON as redacted evidence and retains provider references as data. Replay
uses only the reviewed native fixed suite through the plenger broker. Imported
config, `file://` providers, plugins, and repository scripts are not executed.

The container worker's network-enabled modes are limited to explicit image-pull
and OSV database provisioning actions; normal scans remain offline. The macOS Seatbelt and
digest-pinned container paths are platform capabilities, not a claim that every
clean host has the required runtime or images. The local dashboard may expose only
the implemented loopback fixed suite. Staging, production, remote generation, and
live Jev calls remain explicit capabilities and are not enabled by a project file
or by an imported result.
