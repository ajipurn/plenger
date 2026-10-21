# Red-team engine

The public CLI starts the dashboard and manages package updates. It does not
expose red-team commands. The dashboard's red-team page is a placeholder.
Current capabilities and qualifications are in [../STATUS.md](../STATUS.md).

The engine and recipes remain in the codebase. The llmfy file-canary profile
observes file writes. The Vercel booking profile observes changes to a disposable
SQLite database. FastAPI preparation builds project dependencies, starts private
backing services, imports the application and probes a route.

The dashboard backend retains its existing red-team API. Removing CLI adapters
does not remove that API or its engine. Model transport, authentication, budgets
and pricing under src/redteam also serve the AI source review.

Engine details are in [../ARCHITECTURE.md](../ARCHITECTURE.md),
[../design/redteam-engine.md](../design/redteam-engine.md) and
[../design/worker-protocol.md](../design/worker-protocol.md).
Contributors run the synthetic qualification suites through
`pnpm qualify:llmfy` and `pnpm qualify:vercel`.
