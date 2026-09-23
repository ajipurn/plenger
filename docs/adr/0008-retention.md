# ADR 0008 — Private minimized local storage

Status: checkpoint storage accepted; normalized entities and bounded evidence/metadata retention implemented.

Store reports in owner-only .plenger (0700), SQLite file 0600, with WAL, foreign
keys and busy timeout. Check pre-existing database paths for symlinks, ownership
and hardlinks. Alembic creates the initial append-only report table and reopening
preserves reports. Destructive downgrade is explicitly unsupported; preserve a
backup and write an explicit data migration instead.

No raw source or literals are stored. Metadata passes pattern redaction before
persistence and again on retrieval/export. HTML export escapes values; React
renders text, with same-origin CSP and no remote assets. Redaction is not a universal
secret detector, especially for secrets embedded in identifiers or filenames.
Credential-prefix patterns such as `sk` and `ghp` match only at the start of a
value or after a non-alphanumeric delimiter. This avoids classifying product names
and ordinary identifiers such as `PLENGER_SYNTHETIC_DISCLOSURE_MARKER` as secrets;
it does not expand the detector's coverage of secrets embedded inside identifiers.

Migration 0003 adds evidence artifacts, normalized finding records, and finding-
evidence links. Lifecycle revisions, audit events, suppression expiry checks,
assessment records, and evidence retention expiry/purge are stored separately
from the original report payload. The dashboard exposes the retention deadline
and expiry is scrubbed in normalized rows and report mirrors. On store open,
terminal run metadata and audit rows older than the 90-day window are deleted
transactionally; active runs, active hosted consent, and unexpired suppressions
remain. Suppression references to purged evidence are cleared before the evidence
row is removed. A complete crash
matrix and migration rollback remain explicitly unsupported. A same-UID process can tamper
with local data or race runtime directory checks; no tamper-proof or encrypted-
storage claim is made.
Manual project cleanup is an explicit CLI operation: the operator must confirm the
exact project identity shown by `doctor`, and the implementation holds both
runtime locks from the same already-open private-directory descriptor used to
remove entries beneath `.plenger`. Lock files remain so the lock protocol
cannot be recreated mid-operation; source files and project configuration are
outside the deletion boundary.
The full path-race acceptance gate remains open pending stronger runtime storage
anchoring. Exported metadata may still contain business-sensitive information.
