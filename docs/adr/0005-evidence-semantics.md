# ADR 0005 — Metadata-only static evidence

Status: accepted for checkpoint, incomplete versus full snapshot contract.

The worker parses an in-memory capture without imports. Only definitions and lexical
eval/exec calls are supported. Every graph edge has a path, line and observed_static
provenance. Shadowing, data flow, call reachability, FastAPI routes and agent patterns
remain unknown. Source literals/excerpts are omitted. Strict typed worker output
rejects unknown fields, forged confirmed states, escaping paths and dangling edges.

Findings retain candidate/open/needs_review independently. Severity high is the
local rule's review priority, not CVSS or a verified exploit. Redacted evidence is
hashed and linked to a run and capture UUID. Captures now include file-manifest
metadata and read-only commit/dirty probes when Git is available; unavailable
fields remain unknown. The target's own `.git/config` is untrusted: Git runs
without system/global configuration, with fsmonitor, hooks, submodule recursion
and the global attributes file disabled, and every repository-declared filter
driver is overridden with an empty command before `git status` runs. If the
declared drivers cannot be enumerated safely, the dirty state stays unknown. The UUID is still not a content-addressed snapshot, and
content comparison remains unfinished.

Static reports do not execute the active OWASP suite; active reports expose the
selected fixed-case coverage separately. Deterministic completion refers only to
the stated parser profile. Baseline returns incomplete while required engines are
missing. Synthetic fixture mode must be explicitly selected with `--fixture`.
