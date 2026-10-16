# Mixed agent fixture

A small Python and TypeScript project with intentional findings and one file
with a syntax error (`app/broken.py`). It is the shared end-to-end fixture for:

- `test/cli.test.ts` and `test/reports.test.ts` (command line, report formats,
  baselines, gates)
- `test/inventory.test.ts` (inventory and capabilities)
- `test/dashboard-server.test.ts` and `test/dashboard-persistence.test.ts`
  (dashboard scans, SQLite history and clearing)
- `scripts/smoke-package.ts` (the installed npm package outside the checkout)

Keep it small and deterministic. Expected counts in those tests change when
files are added here.
