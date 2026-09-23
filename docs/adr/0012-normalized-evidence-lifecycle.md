# ADR 0012 — Normalized findings, evidence, and lifecycle

Status: accepted and implemented as a compatibility layer over report JSON.

The original report payload remains the export and read-model boundary, but a
single JSON blob is insufficient for project-scoped finding history, evidence
references, optimistic lifecycle updates, or suppression expiry. Migration 0003
therefore adds `evidence_artifacts`, `finding_records`, and `finding_evidence`.
Migrations 0005 and 0006 add suppression and assessment records.

Each normalized finding is bound to a project and run, uses a run-scoped row ID,
keeps its stable fingerprint/source reference, and links to a redacted evidence
artifact. Evidence row IDs are likewise scoped to the run, so recurring findings
can be persisted across snapshots without primary-key collisions. The link table
stores an explicit evidence ordinal so the primary artifact remains distinguishable
from additional scanner/runtime evidence. Lifecycle
changes use a caller-supplied revision and append a run event with actor/reason;
stale revisions are rejected. Suppression is separate from resolution and is
time-bounded, so an expired suppression becomes visible again. The API mirrors the
new lifecycle state into the report for existing dashboard/export consumers.

Diff calculation is conservative: a finding absent from a partial or
non-comparable run is `not_observed`, never silently `resolved`. CI gates count
only `supported` or `confirmed` findings; candidates remain review warnings.

This schema detects broken references and accidental corruption but is not
tamper-proof against a same-UID local owner. Retention expiry/purge and the
conservative correlation contract are implemented as adjacent layers; signed
runtime evidence and a complete lifecycle UI remain separate follow-up work.
