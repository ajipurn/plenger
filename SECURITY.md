# Security

## Execution policy

- `plenger scan`, `facts`, `rules`, `redteam discover` and `redteam plan` read
  source files only. They never execute, import or install the project, never
  read its `.env` files and need no network access.
- Dynamic red-team tests run only after an explicit Start in the dashboard or an
  explicit `plenger redteam run`. Project code executes inside a fresh container
  per trial with networking disabled, a read-only root filesystem, no host
  mounts, no forwarded credentials, all Linux capabilities dropped and memory,
  process and CPU limits. The worker verifies these controls before it imports
  the project and refuses to continue when a check fails.
- Model requests leave the container only through the host broker, which admits
  each call against the run's budget. API keys stay on the host. Keys saved in
  the dashboard are encrypted at rest with AES-256-GCM in a local SQLite
  database; keys entered for one run stay in memory.
- `plenger serve` binds to `127.0.0.1`, checks the request Host and Origin,
  requires a per-launch session token for state-changing requests and serves
  the page with a Content Security Policy. It enables no CORS access.
- Reports redact recognised secrets. Redaction is not exhaustive; review
  exports before sharing them.

In-process observations qualify ordinary project integrations. They are not an
authenticity boundary against deliberately malicious project code, and a
container is not a proof against kernel escape.

## Reporting an issue

There is no public disclosure process yet and no security contact address.
Until one exists, report a problem to the maintainers through the repository's
private channels. Do not open a public issue for a vulnerability in plenger
itself.
