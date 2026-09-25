# ADR 0018 — Project identity travels with the private directory

Status: accepted and implemented.

## Context

The project identity keyed every table, the SQLite `application_id` marker, backup
confirmation and storage deletion, and it was derived from the absolute project
path. Renaming or moving a project therefore produced a new identity: the store
failed to open with a misleading `database_path_race`, and existing rows and
backups no longer matched the project.

## Decision

The identity is persisted in `.plenger/project-id` (owner-only, regular file,
64 hexadecimal characters) and read descriptor-relative like other private state.

- A new project still starts from the SHA-256 of its resolved path, so identities
  of existing projects do not change.
- A store created before the file existed adopts the identity recorded in its
  single `projects` row on first open, which also repairs stores already moved.
- The SQLite `application_id` marker is derived from this identity instead of the
  current path, preserving the replacement-detection check across moves.
- `delete-storage` removes the file together with the rest of `.plenger`.

## Consequences

Copying a project directory, including `.plenger`, copies its identity. That is
harmless because every store is local to its own directory and there is no shared
registry. A same-UID process can still edit the file, consistent with the local
threat model in ADR 0008.
