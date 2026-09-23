# ADR 0003 — Engine and rule identities

Status: accepted; license release gate still open.

The deterministic parser has a pinned Python image and `python-ast-v1` identity.
WK-PY-001 is original project logic matching lexical calls to eval/exec. Its output
is candidate only. No third-party scanner rules have been copied or executed.
Python dependency versions and distribution hashes live in uv.lock; web integrity
hashes live in package-lock.json. Built UI ships with the wheel.

Semgrep, OSV, and Trivy have managed argv/output contracts and are available only
after a separately provisioned macOS binary (exact version and binary hash) or an
allowlisted digest-pinned container image (exact version and image digest) is
recorded. This checkpoint has run real positive/negative local fixtures through
both host and container paths and an offline OSV database control. Promptfoo is
limited to bounded output import and plenger-native fixed replay; arbitrary
providers/configuration are never executed. Clean-host, cross-platform, upstream
license, and live integration verification remain open. Engine and rule licenses
remain separate metadata. Product/rule licensing remains undecided, so publication
is not allowed. The dependency inventory is evidence of installed metadata, not a
legal clearance or complete transitive container license review.
