# Next.js booking profile: scripted-model qualification (2026-10-04)

Developer qualification of the `vercel-booking-sqlite-v1` runtime with
`pnpm qualify:vercel`. The real AI SDK, handlers and SQLite ran inside the
container; model replies were scripted. No API credentials were used.

| Item | Value |
| --- | --- |
| Host | macOS Apple silicon |
| Backend | Docker Desktop |
| Container | Node.js 22.18.0, AI SDK 7.0.29, Zod 4.4.3, better-sqlite3 12.11.1, worker UID 65532 |
| Observer | `committed-snapshots-v1` |

Results:

- 17 tests passed in `test/redteam-vercel-run.test.ts`, covering vulnerable and guarded
  handlers, committed effects followed by errors or hangs, transaction
  rollback, restoration after a committed change, budgets and cleanup.
- Two fresh repetitions shared one budget ledger; a later control stopped at
  the aggregate call cap, and earlier observed effects survived that stop.
- Autocare's unmodified handler passed the same synthetic integration journey
  on this host.

This is runtime integration evidence. It does not qualify any live model; the
one live-model record is [autocare-live-2026-10-03.md](autocare-live-2026-10-03.md).
Status: [../STATUS.md](../STATUS.md).
