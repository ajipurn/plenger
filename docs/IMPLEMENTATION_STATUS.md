# Implementation status

Checkpoint: 23 September 2026, local working tree. No Git repository existed at
start, so there is no product commit identifier. This is a substantial local
implementation checkpoint, but it is **not a completed MVP**: managed third-party
scanner provisioning is now explicit, while live staging verification, live Jev
verification, platform isolation coverage, and the full acceptance matrix remain
unavailable.

## Milestones

| Milestone | Status | Evidence / outstanding gate |
|---|---|---|
| M0 foundation | berjalan | Strict config, owner-only storage, pairing/CSRF, state ledger, fourteen Alembic migrations, normalized finding/evidence/graph/consent tables, HMAC manifests, project metadata, 30-day evidence expiry, 90-day terminal metadata/audit purge, explicit project-ID-confirmed private-storage deletion, active-attempt ledger, descriptor-relative path checks, deterministic file/directory swap rejection between metadata observation and open, same-UID concurrent replacement stress, post-open directory-entry identity revalidation, stable child-directory/file device-inode binding, and SQLite inode/device identity revalidation before first connection, on connect, and on pool checkout are tested locally on macOS and a Linux container subset. The complete cross-platform path-race matrix remains open. |
| M1 vertical slice | berjalan | Init → doctor → isolated parser → persisted normalized graph/finding → paired React dashboard → JSON/HTML export works. Explicit agent/model inventory, its 11-case expected-node/edge corpus, the 55-case Python/FastAPI tuning corpus plus 12-case authored holdout corpus, read-only Git commit/dirty capture when available, and a disposable-project Playwright browser smoke—including inert HTML payload rendering in finding/evidence/graph views—are tested. Hostile-browser/full E2E remains open. |
| M2 scanners | berjalan (real local engines) | Semgrep/OSV/Trivy have strict normalizers, managed argv planning, binary or immutable image pin checks, explicit allowlisted-digest pull provisioning, bounded process-group execution, macOS default-deny Seatbelt isolation, an explicit non-macOS Docker worker, owner-only staging, path mapping, manifests, capability probes, baseline wiring, and explicit OSV database provisioning for PyPI plus detected npm, Cargo, Go, Ruby, Composer, and Maven inputs. A fresh pinned-container OSV setup completed on 23 September with a 291,671,377-byte database covering seven ecosystems; vulnerable/fixed, unresolved/ranged, fingerprint, freshness, and offline-scan controls pass. A separate host-native provisioning attempt timed out, but the supported container path succeeded. Manifest uncertainty is suppressed only by a structurally usable npm lockfile. Real host and container fixtures plus pinned Linux arm64 and amd64 Semgrep/Trivy production-source smoke pass; broader clean-host, platform, licensing, and freshness matrices remain. |
| M3 authorized LLM testing | berjalan (local + staging transport contract) | Immutable plan, canonical plan-bound DNS IP set with per-dispatch revalidation, preview, one-use approval, fixed local/staging suite, loopback/public-HTTPS DNS-pinned broker, active `execute_active_run` dispatch through a separate per-job broker process over bounded Unix IPC, bounded job-scoped contract for dispatch/cancel/stats, request/concurrency/wall-time budgets, fail-closed strict cost guard, explicit request-only acknowledgment with unknown-cost accounting, cancellation, lease heartbeat, API/CLI lifecycle, paired dashboard controls, ten-category vulnerable/fixed response matrix, explicit planned/blocked/executed/skipped/inconclusive/error/not-tested coverage semantics with profile digest and selected-case denominator, four observer-backed fixture families, run/attempt/sequence-bound fixture evidence, an independent bounded fixture observer, a bounded HMAC-signed observer ingress contract, and an opt-in capability-protected observer Unix socket transport wired through the API background runner and `serve` CLI are implemented. Promptfoo import/native replay is bounded and non-executable. Live staging verification, target-side cost telemetry, approved production sidecar deployment, and broader category-effectiveness evidence remain blocked. |
| M4 Jev | berjalan (mock contract) | Typed Choice/Score/Noul validation, bounded state/redaction, 10-second request/64KiB response limits, probability/confidence validation, retry/error policy, assessment persistence, and a deterministic 120-case bilingual local benchmark with tuning/holdout, confusion, abstention, latency, and synthetic-cost reporting are implemented and mocked. Live key/provider verification and independent evaluation remain. |
| M5 developer workflow | berjalan | Normalized lifecycle/revision/audit, run-scoped recurring finding IDs, suppression expiry, 30-day evidence expiry/purge, 90-day terminal metadata/audit purge, explicit project-ID-confirmed private-storage deletion, conservative diff that rejects changed analysis identities, CI gate helper, full normalized assessment hydration for export, bounded run-history and assessment-history pagination, persisted report-overview assessment mirrors bounded to 100 with normalized total counts, project/config/provider/data-class-bound consent ledger with preview/grant/revoke, and a project-scoped semantic assessment cache keyed by stable artifact-content digest plus finding-claim identity, rubric, model, and redaction identity whose reused results are explicitly marked non-fresh are implemented. Dashboard now exposes all normalized finding filters and explicitly marks partial/unknown coverage and cached assessment results; hostile-browser/full E2E remains open. |
| M6 hardening | berjalan (checkpoint) | Current macOS Python suite: 441 passed, 0 skipped, 2 dependency warnings in 73.34s; this includes a runtime test proving the managed Seatbelt scanner cannot connect to an active loopback listener. Ruff check and format check pass, and mypy passes across 54 source files. Vitest 2/2 and Playwright E2E 1/1 pass, including project-scoped Jev consent preview details. The UI build and a fresh macOS Python 3.12 install of the rebuilt `plenger==0.1.0` wheel passed at the previous checkpoint. Pinned Linux arm64 and emulated amd64 container suites each passed 394 with 13 capability skips before the latest changes. The full `scripts/check.sh` run has not been repeated after the standalone fresh OSV container smoke succeeded. AC01–AC24 are not all closed; see `docs/TEST_RESULTS.md` and `docs/acceptance-results.json`. |

## Requirement tracking

| Requirement | Status | Evidence and remaining work |
|---|---|---|
| FR01 config/init/doctor | berjalan | Workspace, strict YAML, path, pairing, doctor, descriptor-relative capture, read-only Git commit/dirty metadata when available, post-open directory-entry revalidation, stable child-directory/file inode binding, owner/nlink checks, and database replacement detection before first connection, on connection, and on checkout pass locally; the cross-platform path-race matrix remains. |
| FR02 graph | berjalan | Python/FastAPI graph, normalized graph entity persistence/SQL pagination, node-kind/source-path filters in API and dashboard, keyboard-selectable edge detail with source location/provenance, explicit import-aware agent/tool/LLM/retriever inventory, 55 tuning plus 12 authored holdout definition/route cases, and an 11-case inventory expected-node/edge corpus are tested; dynamic reachability and other languages are not inferred. |
| FR03 SAST | berjalan (local integration) | Managed Semgrep binary/rule pinning, digest-pinned container execution, bounded transient version probing, owner-only staging, macOS default-deny Seatbelt containment, non-macOS no-host-fallback behavior, positive/negative fixture execution, pinned Linux amd64 production-source smoke, bounded non-zero/empty/oversized-output/timeout failure handling, fail-closed revalidation paths, and baseline persistence are tested; broader compatibility and recall remain. |
| FR04 dependency scanning | berjalan (offline local integration) | OSV database provisioning is a separate bounded setup action; a fresh pinned-container database completed on 23 September at 291,671,377 bytes for Cargo, Composer, Go, Maven, npm, Python, and Ruby. Scan argv is offline-only, database age/change is checked, lockfile capture and deterministic advisory alias canonicalization are supported, vulnerable packages without a version and ranged requirements/npm specs remain visible as unknown candidates, and manifest uncertainty is suppressed only by a structurally usable `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, or `yarn.lock`. Targeted vulnerable/fixed controls pass for Python, uv.lock, npm, Cargo, Go, Ruby, Composer, and Maven, plus unpinned/ranged controls. Clean-host, full lockfile/advisory recall, and cross-platform freshness matrices remain. |
| FR05 secrets | berjalan (local integration) | Managed Trivy secret-only execution through the macOS host worker and the digest-pinned container worker, including the pinned Linux amd64 production-source smoke, positive/negative filesystem fixtures, field-aware redaction, temporary staging, and persistent-artifact checks pass; broader secret formats and platform matrix remain. |
| FR06 normalization | berjalan | Stable fingerprints, normalized findings/evidence, source attribution, signed keyset findings cursors, explicit advisory aliasing, conservative cross-engine correlation with preserved member evidence, and default baseline scanner wiring are tested. |
| FR07 approval | lulus acceptance lokal | Plan/scope digest mengikat rubric canonical. Preview menampilkan project, target revision dan IP, profile/case/rubric digest, snapshot, auth identity, data classes, seluruh budget, approver, dan TTL. AC07 test matrix lulus untuk perubahan scope, tanpa approval, expiry/revocation, paralel satu pemenang, dan idempotency conflict. Legacy plan tanpa IP binding harus dibuat ulang; profile yang tersedia saat ini hanya core. |
| FR08 runner | berjalan (bounded local/staging) | Broker enforces loopback or public-HTTPS DNS pinning, canonical plan-bound IP-set revalidation on every dispatch, direct socket/SNI preservation, path/method scope, payload/response bounds, attempts, concurrency, absolute wall-time deadlines during response reads, no redirects, cancellation, and active-run dispatch through a separate bounded job-scoped broker process over Unix IPC for dispatch/cancel/stats; independent observer requirements for effect/retrieval claims and queue-time strict cost rejection without trusted target-side control remain enforced. Request-only runs expose unknown target cost. Live staging and production integrations remain unverified. |
| FR09 OWASP coverage | berjalan (fixed subset) | Ten categories are represented and each has one bounded local fixed case; active reports expose the selected profile digest, explicit selected-case denominator, and preserve planned, blocked, executed, skipped, error, and inconclusive states, while static reports mark all categories not tested. The dashboard summarizes each state, including skipped, without turning missing ground truth into a pass. The response-marker cases are contract fixtures, not full category effectiveness or certification. |
| FR10 Jev | berjalan (mock-only) | Typed provider and assessment boundary, bounded request/response streaming, probability/confidence validation, retry/error policy, resolved-model pin validation, project-scoped semantic assessment cache keyed by stable artifact-content digest/finding-claim identity/rubric/model/redaction identity with explicit non-fresh cache labeling, the adversarial no-authority fixture, and the 120-case bilingual local benchmark are tested; live verification and independent evaluator acceptance remain. |
| FR11 dashboard | berjalan | Pairing, session, Host/Origin/CSRF/project checks, consistent security headers on success and error paths, bounded static-report overview including persisted assessment mirrors with normalized total counts, complete high/critical candidate-priority summary, selected-run normalized SQL-backed findings/graph pagination with keyboard-accessible next-page controls, graph node-kind/source-path filters, keyboard-selectable graph edge detail with location/provenance, inert HTML payload rendering in report/findings/graph views, explicit active-suite profile digest and selected-case denominator, coverage status counts for planned/blocked/executed/skipped/inconclusive/error/not-tested, severity/validation/lifecycle/kind/path finding filters, explicit partial/expired-evidence notices, engine capability details including OSV database age, run/session-bound generation guards that prevent stale report, history, consent, and polling responses from overwriting the selected view, safe unavailable handling for corrupt assessment storage, actionable stale/closed plan and approval errors, empty selector rejection without latest-resource fallback, foreign/nonexistent selected-report rejection with stale-view cleanup, project-scoped run history including terminal cancelled active runs, active-run restoration after a browser refresh, evidence view, complete normalized assessment export routes, and active plan/approval/run/cancel/per-case UI work; complete hostile-browser matrix remains. |
| FR12 lifecycle | berjalan | Revision-checked acknowledge/resolve/suppress/reopen updates, audit events, expiry-aware suppression, conservative reopened diff with worker/scanner/profile identity checks, project-scoped comparison endpoint, dashboard lifecycle/history controls, all normalized finding filters, and explicit partial/not-observed/expired-evidence messaging are implemented; hostile-browser and adversarial history matrix remains. |
| FR13 export/CI | berjalan (limited) | JSON/escaped HTML, 0/1/2/3/130 helper semantics, fail-closed error fields, case-insensitive supported/confirmed severity gates, and a 16-case CI policy matrix covering state/error/severity combinations are covered. Candidates do not fail the supported/confirmed severity gate; broader CLI/export permutation coverage remains. |
| FR14 data/connections | berjalan (limited) | A disposable full static baseline completed locally with Semgrep, OSV, and Trivy under macOS default-deny Seatbelt isolation and a pre-provisioned local OSV database. A controlled managed-scanner runtime probe confirms Seatbelt denies a TCP connection to an active loopback listener. Tests verify that Jev is not called without consent/key, project A's consent does not authorize project B, and the browser preview displays `api.typesafe.ai` plus `metadata`, `code_excerpt`, and `response` before hosted assessment is enabled. Non-macOS digest-pinned container boundaries, explicit network-enabled OSV provisioning, broker boundary, and redaction are implemented; full cross-platform egress and live provider acceptance remain open. |
| FR15 evidence | berjalan | Snapshot/evidence references, read-only Git commit/dirty metadata when available, normalized artifacts, redacted digests, run/attempt/sequence-bound fixture runtime trace requirements, run-bound `test_context.observer_context` metadata, bounded HMAC-signed JSON ingress, capability-protected Unix socket transport, API/background/CLI observer wiring, owner-only secret-file validation, replay/attempt binding checks, integrity checks, and expiry purge across normalized rows/report mirrors exist; production signer/approved sidecar deployment remains. |
| FR16 recovery | berjalan (static + lease) | Durable static/active ledger, pre-dispatch in-flight markers, recovery marking, per-case active attempts, idempotency, interruption, owned-container cleanup, worker leases, active heartbeats, dispatch-crash recovery, actual worker-process-kill recovery, and completed-attempt preservation across report-write crashes are tested. |
| FR17 contracts | berjalan (managed contract for optional engines) | Strict worker, scanner argv/output, digest-pinned container lifecycle, capability manifests (including supported modes and explicit supported patterns), broker, Promptfoo bridge, Jev contracts, and offline dependency/source/hash ledger validation are tested. Third-party version/license compatibility and live integrations are not verified. |
| FR18 validation | berjalan (limited) | Current macOS suite has 441 passing tests, 0 skips, and 2 dependency warnings; current Vitest has 2 passes and Playwright E2E 1 pass. Ruff check/format and mypy over 54 source files pass. UI build and a rebuilt plenger wheel/clean-install pass on macOS at the previous checkpoint. Pinned Linux arm64 and emulated amd64 container suites each had 394 passes and 13 capability skips before the latest changes. Dependency ledger, migration, scanner, benchmark, native-platform, legal license, and live evaluator evidence remains from earlier checkpoints or open external gates. The Linux runs are container compatibility slices, not native Linux-host release acceptance. Clean-host scanner/database verification, platform isolation, license review, and live evaluator gates remain. |

Completed-tested subcomponents are narrowly those covered by passing tests, not
whole FR/AC rows. A capability marked blocked or unavailable is not represented
as a clean scan, pass, or production guarantee.

## Exact next steps

Latest local hardening checkpoint (23 September 2026): the real Chrome E2E
now serves an adversarial page from a second loopback port and verifies that its
credentialed logout request receives HTTP 403, its response is opaque, session
data cannot be read through CORS, and the legitimate session remains usable.
It also checks HttpOnly/SameSite/host cookie attributes, JavaScript cookie
invisibility, rejection of a reused pairing code, cookie removal on logout,
server rejection of the old cookie, and the pairing screen after reload.
The same disposable-project E2E verifies the hosted Jev consent preview's exact
domain and data classes. A fresh seven-ecosystem pinned OSV database and a
disposable offline baseline with all three static scanners also completed. These
results narrow the local browser, scanner, and consent gates without claiming
cross-browser/platform, clean-host, or live-provider acceptance.

1. Run the remaining cross-platform path-race matrix and concurrent stress
   slice on clean Linux/macOS runtimes. The current Python suite passes on macOS
   and both pinned Linux architectures, but the complete isolation matrix is
   still open.
2. Repeat the scanner matrix on clean Linux/macOS runtimes using both the
   macOS host path and the digest-pinned container images, and verify
   third-party licenses without depending on this host's Homebrew installation;
   targeted vulnerable/fixed controls and advisory-alias fixtures are now in the
   pinned local smoke.
3. Connect the now-wired signed JSON ingress to an approved production sidecar
   using `test_context.observer_context`, and complete the remaining hostile/full
   browser E2E matrix beyond the local assessment-history pagination and active
   controls; the local authenticated smoke now covers deterministic assessment
   persistence, the explicit cached-result label, one-use active approval, local
   fixed-suite execution, and cancellation, while the fixture observer remains
   bound to run/attempt/sequence alongside the ten-category matrix and
   consent-aware assessment panel.
4. Run Jev live verification and an independently held-out 120-case evaluation
   only with explicit credentials and consent; the local 120-case contract
   benchmark is now recorded, but it is not a provider-accuracy claim.
5. Close the hostile-browser, Linux/macOS isolation, cross-platform packaging,
   and full benchmark acceptance matrix (browser startup, warm third-party
   scanners, cold install, and cross-platform runs) before calling the product
   MVP-complete; the current wheel clean-install probe is now repeatable, while
   clean-host image/database provisioning verification and cross-platform packaging
   remain open.

The 23 September `sh scripts/check.sh` run passed Ruff, formatting, mypy, the
local worker probe, and the pinned scanner-image smoke, then stopped at
`scripts/check_osv_scanner.py`: explicit database setup timed out after 300 seconds
with `osv_database_scanner_timeout` (approximately 21 MB staged). The later
Python suite, web build/unit/E2E, wheel build, clean-install, benchmarks, and
dependency inventory were run independently and are reported in `TEST_RESULTS.md`.

Residual risks: a same-UID local process can tamper with storage or race runtime
path checks; metadata may contain undetected sensitive identifiers; large captures
can consume host memory; report overview still loads a bounded report mirror for
summary/assessment context while the dashboard findings and graph APIs page
selected-run normalized storage; active
production remote execution and hosted evaluation remain disabled; live staging
authorization/observer integration, clean-host scanner image/database
provenance, cross-platform isolation matrix, and third-party license verification
remain open; non-macOS host-binary fallback is deliberately unavailable until the
explicit container worker is provisioned; no production-security or
OWASP-certification claim is made.

Latest local hardening also enforces field-aware redaction at the final scan
report/snapshot boundary, normalized finding metadata/evidence/graph node/edge/attempt
reads and writes, public plan payloads, assessment payload persistence and history
reads, run reason reads/writes, suppression reads, report reads/writes, assessment
return values, and approval/hosted-consent actor metadata including consumed approval
reads; duplicate plan responses also retain a decoded payload shape. Regression coverage verifies raw
values do not reach or escape SQLite through these readers. See the redaction row in
`docs/TEST_RESULTS.md` for the exact tests and source boundaries.
