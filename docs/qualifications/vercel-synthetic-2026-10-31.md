# Next.js booking profile: scripted-model qualification (2026-10-31)

Developer qualification of the `vercel-booking-sqlite-v1` runtime with
`pnpm qualify:vercel`, after the base image moved from Node.js 22.18.0 to
22.23.4. That patch fixes the Brotli flaw CVE-2026-111497. The real AI SDK,
handlers and SQLite ran inside the container; model replies were scripted. No
API credentials were used.

| Item | Value |
| --- | --- |
| Host | macOS Apple silicon |
| Backend | Podman 6.0.2 (libkrun machine) |
| Base image | `node:22.23.4-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd` |
| Container | Node.js 22.23.4, AI SDK 7.0.29, Zod 4.4.3, better-sqlite3 12.11.1, worker UID 65532 |
| Observer | `committed-snapshots-v1` |

Results:

- 22 tests passed in `test/redteam-vercel-run.test.ts`, including the
  `node-version` isolation check and the reported runtime versions.

This is runtime integration evidence. It does not qualify any live model.
The previous record is [vercel-synthetic-2026-10-04.md](vercel-synthetic-2026-10-04.md).
Status: [../STATUS.md](../STATUS.md).
