# plenger — development checkpoint

Local-first security tooling under development. This checkpoint provides a working,
limited Python/FastAPI definition/route map, lexical `eval`/`exec` review candidates,
and a bounded local/staging fixed-suite active runner with CLI/API/dashboard controls. It is **not the complete MVP**, a
general agent analyzer, or a security certification.

## Setup

Requires Python 3.12.4 or a newer 3.12 patch release, and uv. Docker is also required for the pinned parser worker
and for the explicit container scanner worker on non-macOS hosts. UI assets are
already included in `src/plenger/ui`; Node is needed only when changing the UI.

```sh
uv sync --locked
```

Provision the pinned parser image separately if it is not already present. This is
an explicit network/setup action; init and scan never pull images:

```sh
docker pull python@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea
```

The image was already cached on the development host and ran successfully. Attempts
to pull the mutable `python:3.12-slim` tag failed due to registry connectivity;
clean image provisioning from another host has not been verified.

On macOS, the default scanner setup uses explicitly provisioned host binaries
inside the default-deny Seatbelt worker. On Linux and other platforms, provision
the digest-pinned scanner images explicitly; scans use `--pull=never` and never
fall back to host binaries:

```sh
docker pull semgrep/semgrep@sha256:e5ea1a270ca5557a114ae7a30a8f860cc16a924f8df85cd975688f17c7c97731
docker pull ghcr.io/google/osv-scanner@sha256:afd838850ac1a0fcc15ff4a041dc9ba11123c3f0d2666217a5f0fcf9222b55fa
docker pull aquasec/trivy@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969
uv run --locked plenger provision-scanners --project fixtures/python --container
uv run --locked plenger provision-osv-db --project fixtures/python
```

Jika project memiliki manifest atau lockfile npm (`package.json`, `package-lock.json`,
`pnpm-lock.yaml`, atau `yarn.lock`), langkah provisioning yang sama juga
menyiapkan database npm lokal; scan berikutnya tetap offline. Database npm lebih
besar daripada arsip PyPI, sehingga ukuran `.plenger/scanners/osv` dapat
bertambah sekitar 215 MB pada setup pertama.

Sebagai alternatif, aksi provisioning eksplisit dapat menarik image yang belum ada
melalui Docker context lokal yang tervalidasi:

```sh
uv run --locked plenger provision-scanners --project fixtures/python --container --pull
uv run --locked plenger provision-osv-db --project fixtures/python
```

`--pull` hanya berlaku untuk digest image yang di-allowlist dan hanya dijalankan
ketika diminta; init, doctor, dan scan tidak pernah menarik image. Status
`osv_database_not_provisioned` dari langkah pertama adalah pending setup yang
diharapkan, bukan baseline yang siap dijalankan.

The recorded image identities are the immutable Semgrep, OSV-Scanner, and Trivy
digests in `src/plenger/adapters/scanners.py`. A missing Docker daemon or image
leaves the engine unavailable; it does not execute a target scanner on the host.

## Run the synthetic fixture

```sh
uv run --locked plenger init fixtures/python
uv run --locked plenger doctor --project fixtures/python
uv run --locked plenger scan --project fixtures/python --profile deterministic --fixture
uv run --locked plenger serve --project fixtures/python
```

Untuk baseline penuh, pin binary yang sudah tersedia lalu provision database OSV
secara eksplisit. Perintah kedua adalah satu-satunya langkah yang menghubungi
upstream advisory database; scan berikutnya selalu offline dan menolak database
yang hilang, berubah, atau lebih tua dari tujuh hari:

```sh
uv run --locked plenger provision-scanners --project fixtures/python
uv run --locked plenger provision-osv-db --project fixtures/python
uv run --locked plenger scan --project fixtures/python --profile baseline
```

Open http://127.0.0.1:7331 and enter the terminal pairing code within 60 seconds.
The dashboard shows real stored results. After a code expires, is used, or reaches
five failed attempts, the next pairing attempt prints a fresh code in the `serve`
terminal (at most once every 10 seconds); restarting `serve` is not required. Use
`serve --port PORT` to run the dashboard on another loopback port; Host and Origin
checks follow that port. A session lasts 30 minutes. Use **Jalankan scan statis** to queue a real isolated scan. The UI shows progress
and a new report when complete. Keep the synthetic-fixture checkbox enabled for
this demo. Reports are capped at 100 items per section; JSON download is complete.

Copy `run_id` from scan output to export:

```sh
uv run --locked plenger export RUN_ID --project fixtures/python --format json
uv run --locked plenger export RUN_ID --project fixtures/python --format html
```

`RUN_ID` is a placeholder, not a runnable literal. Reports are emitted to stdout.
For another repository, substitute its directory and omit `--fixture`. Run the
installed CLI from this product environment; do not install target dependencies.
Review the target exclusions and add `.plenger/` to its `.gitignore` yourself.
Init does not edit existing configuration or `.gitignore`.

`scan` uses the `profile` from `plenger.yaml` unless `--profile` is given. Files
larger than `max_file_bytes` (default 2 MiB, configurable up to 16 MiB) and
hardlinked files are not read; they are listed in the report's `skipped` section
with a reason instead of aborting the scan. A baseline scan that had to skip a
dependency manifest or lockfile is reported as `completed_with_errors`, because
OSV coverage would otherwise be silently incomplete.

The project identity is stored in `.plenger/project-id`, so renaming or moving the
project directory keeps its database, backups, and `project_id`. A store created
before this file existed adopts its original identity on first open.

Before upgrading a project that has local scan data, stop its dashboard, active
workers, and concurrent CLI commands. Make an owner-only database backup and save
the returned `backup_id` and `project_id` outside the upgrade session:

```sh
uv run --locked plenger doctor --project PATH_TO_PROJECT
uv run --locked plenger backup --project PATH_TO_PROJECT
```

If the upgrade must be rolled back, use the rollback-capable CLI to restore the
matching snapshot before starting the previous release:

```sh
uv run --locked plenger restore BACKUP_ID --project PATH_TO_PROJECT \
  --confirm-project-id PROJECT_ID
```

Restore checks the project identity and database integrity, does not run
migrations, and revokes persisted active-test approvals and hosted-assessment
consents from the snapshot. Stop all Plenger commands before restore. Alembic
destructive downgrades remain disabled. Keep the backup until the upgraded
release is accepted. Backups contain evidence, so plenger deletes managed backups
older than the 30-day evidence retention window when the store is opened; copy a
backup elsewhere yourself if a longer rollback window is required.

Projects created by an earlier release continue to work with their existing
`.Wonderkit/` data directory and `Wonderkit.yaml` configuration. New projects use
`.plenger/` and `plenger.yaml`.

To remove local plenger metadata and evidence for a project, stop its dashboard
and workers first, then copy `project_id` from `doctor` and confirm the exact
value. The command is bounded to `.plenger`; source files, configuration, and
other project paths remain untouched:

```sh
uv run --locked plenger doctor --project fixtures/python
uv run --locked plenger delete-storage --project fixtures/python \
  --confirm-project-id PROJECT_ID
```

The experimental active workflow requires an explicit immutable plan, one-use
approval, and either a local loopback HTTP target or an HTTPS staging target. The
CLI, API, and paired React dashboard expose the same ten-category fixed suite;
the plan preview shows the canonical DNS IP set bound to the approval, and a DNS
set change forces re-planning; they cannot dispatch to production or discover
paths automatically.
Until a trusted target-side cost limit/telemetry adapter is available, CLI plans
must explicitly use `--cost-guard request_only --cost-acknowledged`; strict plans
are rejected when the plan is created (`strict_cost_guard_requires_target_control`),
before anyone reviews or approves them. Request-only reports show target cost as
unknown. If an approval expires unused, the same plan can be approved again; a plan
never has more than one live approval. `run` exits 1 when any fixed case fails
(forbidden marker or unauthorized effect observed), following the same 0/1/2/3/130
precedence as `scan --ci`.
The dashboard shows per-case active results, cancellation state, and the consent
preview before execution. It also exposes deterministic/manual evidence assessment
and an explicit Jev hosted-consent control; assessment output is review context only
and cannot change finding authority.
Observer-backed claims are bound to each run/attempt; local native replay and the
bounded HMAC-signed observer ingress reject mismatched or replayed evidence. Active
runs use a separate per-job broker process with a capability-protected Unix
socket for dispatch, cancel, and stats. The separate observer socket remains
opt-in for an approved sidecar and is wired through the API/background runner:
provide an owner-only (mode `0400` or `0600`) key file of at least 32 bytes when
starting the server:

```sh
uv run --locked plenger serve --project fixtures/python \
  --observer-secret-file /path/to/observer.key
```

The server prints a short-lived socket path and capability for the sidecar; the
socket and capability are removed when the server exits. Production signer,
sidecar approval/deployment, and live verification remain release gates.
On a host without the required POSIX Unix-process capability, active queueing is
rejected before the one-use approval is consumed.

The synchronous CLI runner accepts the same `--observer-secret-file` and optional
`--observer-socket` flags; it prints the endpoint metadata to stderr and removes
the temporary socket when the run finishes.

Promptfoo output can be imported as bounded, redacted evidence without executing
providers or repository config:

```sh
uv run --locked plenger import-promptfoo promptfoo-results.json
```

`--profile baseline` is **incomplete (exit 2)** when any managed engine or the
OSV database is unavailable. The scanner adapters require explicit version/hash
or image-digest pins, stage only captured text inputs in owner-only temporary
directories, and never load repository scanner configuration. On macOS each
managed host scanner is wrapped in a default-deny Seatbelt profile with network
denied; other platforms require the explicit digest-pinned container worker,
with scan network access disabled. By default `--ci --fail-on SEVERITY` fails only
on supported/confirmed findings; static parser and scanner results are review
candidates, so add `--fail-on-candidates` when the pipeline must stop on them.
Without that flag, candidates at or above the threshold produce a
`candidate_findings_not_gated` warning on stderr. Suppressed and resolved findings
never fail the gate. Acknowledgments and active suppressions carry over to the same
finding fingerprint in later scans; a resolved finding that reappears is reopened.
Missing Docker/image blocks scanning (exit 3); parser/input errors return exit 2.
No fallback executes the target on the host.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the repository layout, and the
quality gates. The common entry points are `make install`, `make lint`,
`make typecheck`, `make test` and `make check`.

See [implementation status](docs/IMPLEMENTATION_STATUS.md),
[test evidence](docs/TEST_RESULTS.md), and [architecture decisions](docs/adr/0001-local-first.md).
There is no publishing or deployment workflow. The local working name is unverified.
