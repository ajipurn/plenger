# Implementation status

Review hardening checkpoint: 26 September 2026, local uncommitted working tree.
A code review found and this checkpoint fixed: active fixed cases evaluated on a
redacted, 2,000-character excerpt (false passes); `git status` running filter
drivers from the target's `.git/config` outside any sandbox; CI gates that could
never fail on static candidates or failed active cases; captures aborted by one
oversized or hardlinked file; redaction that rewrote paths and rule IDs; hosted
payloads ignoring the requested consent classes and inline consent without
acknowledgment; staging address checks that trusted `ipaddress` on Python 3.12.1;
triage lost on every rescan; stores broken by moving the project; a Linux worker
that could reach every host Unix socket; plus per-request probe hashing, report
mirror rewrites, N+1 suppression reads, unbatched parser input, stranded expired
approvals, unrunnable strict plans, an ignored config `profile`, a fixed port,
permanent pairing lockout, backups outliving evidence retention, mislabeled active
coverage, and an unstructured dashboard source file. Results for this checkpoint:
ruff, format and mypy (61 source files) pass; `pytest` 516 passed in 77s; Vitest
2 passed; UI production build and Chrome E2E 1/1 pass; clean wheel install
passes; mapping, inventory and Jev local benchmarks are unchanged. Native Linux
bubblewrap execution, WebKit, the performance benchmark, and the network-enabled
OSV/scanner-image smokes were not rerun for this checkpoint.

Previous checkpoint: 24 September 2026, local working tree. Earlier evidence predates
creation of this Git repository; the latest full gate ran on the
current uncommitted working tree, so there is no commit-only product identifier.
This is a substantial local implementation checkpoint, but it is **not a
completed MVP**: live staging verification, live Jev verification, platform
isolation coverage, and the remaining acceptance matrix are still open.

The acceptance ledger records **19 pass and 5 blocked**: AC01, AC11, AC19,
AC23, and AC24. AC01/AC23 need a clean native cross-platform isolation and
packaging matrix; AC11/AC24 need live Jev access and independent evaluator
evidence; AC19 needs an independent license review and clean release
verification. Live staging, approved observer-sidecar deployment, target-side
cost telemetry, and broader OWASP effectiveness evidence are also outstanding
release gates.

## Milestones

| Milestone | Status | Evidence / outstanding gate |
|---|---|---|
| M0 foundation | berjalan | Strict config, owner-only storage, pairing/CSRF, state ledger, fifteen Alembic migrations, normalized finding/evidence/graph/consent tables, HMAC manifests, project metadata, 30-day evidence expiry, 90-day terminal metadata/audit purge, explicit project-ID-confirmed private-storage deletion, active-attempt ledger, descriptor-relative path checks, deterministic file/directory swap rejection between metadata observation and open, same-UID concurrent replacement stress, post-open directory-entry identity revalidation, stable child-directory/file device-inode binding, and SQLite inode/device identity revalidation before first connection, on connect, and on pool checkout are tested locally on macOS and a Linux container subset. The complete cross-platform path-race matrix remains open. |
| M1 vertical slice | berjalan | Init → doctor → isolated parser → persisted normalized graph/finding → paired React dashboard → JSON/HTML export works. Explicit agent/model inventory, its 11-case expected-node/edge corpus, the 55-case Python/FastAPI tuning corpus plus 12-case authored holdout corpus, read-only Git commit/dirty capture when available, and a disposable-project Playwright browser smoke—including inert HTML payload rendering in finding/evidence/graph views—are tested. The local AC13 Chrome/WebKit browser acceptance now passes; Firefox and native cross-platform browser coverage remain open. |
| M2 scanners | berjalan (real local engines) | Semgrep/OSV/Trivy have strict normalizers, managed argv planning, binary or immutable image pin checks, explicit allowlisted-digest pull provisioning, bounded process-group execution, macOS default-deny Seatbelt isolation, an explicit non-macOS Docker worker, owner-only staging, path mapping, manifests, capability probes, baseline wiring, and explicit OSV database provisioning for PyPI plus detected npm, Cargo, Go, Ruby, Composer, and Maven inputs. The full gate freshly provisioned a pinned-container OSV database on 24 September at 291,813,642 bytes covering seven ecosystems; vulnerable/fixed, unresolved/ranged, fingerprint, freshness, and offline-scan controls pass. A separate host-native provisioning attempt timed out, but the supported container path succeeded. Manifest uncertainty is suppressed only by a structurally usable npm lockfile. Real host and container fixtures plus pinned Linux arm64 and amd64 Semgrep/Trivy production-source smoke pass; broader clean-host, platform, licensing, and freshness matrices remain. |
| M3 authorized LLM testing | berjalan (local + staging transport contract) | Immutable plan, canonical plan-bound DNS IP set with per-dispatch revalidation, preview, one-use approval, fixed local/staging suite, loopback/public-HTTPS DNS-pinned broker, active `execute_active_run` execution in per-case OS-confined workers that can reach targets only through a separate per-job broker process over bounded Unix IPC, bounded job-scoped contract for dispatch/cancel/stats, request/concurrency/wall-time budgets, fail-closed strict cost guard, explicit request-only acknowledgment with unknown-cost accounting, cancellation, lease heartbeat, API/CLI lifecycle, paired dashboard controls, ten-category vulnerable/fixed response matrix, explicit planned/blocked/executed/skipped/inconclusive/error/not-tested coverage semantics with profile digest and selected-case denominator, four observer-backed fixture families, run/attempt/sequence-bound fixture evidence, an independent bounded fixture observer, a bounded HMAC-signed observer ingress contract, and an opt-in capability-protected observer Unix socket transport wired through the API background runner and `serve` CLI are implemented. Promptfoo import/native replay is bounded and non-executable. Live staging verification, target-side cost telemetry, approved production sidecar deployment, and broader category-effectiveness evidence remain blocked. |
| M4 Jev | berjalan (mock contract) | Typed Choice/Score/Noul validation, bounded state/redaction, 10-second request/64KiB response limits, probability/confidence validation, retry/error policy, assessment persistence, and a deterministic 120-case bilingual local benchmark with tuning/holdout, confusion, abstention, latency, and synthetic-cost reporting are implemented and mocked. Live key/provider verification and independent evaluation remain. |
| M5 developer workflow | berjalan | Normalized lifecycle/revision/audit, run-scoped recurring finding IDs, suppression expiry, 30-day evidence expiry/purge, 90-day terminal metadata/audit purge, explicit project-ID-confirmed private-storage deletion, conservative diff that rejects changed analysis identities, CI gate helper, full normalized assessment hydration for export, bounded run-history and assessment-history pagination, persisted report-overview assessment mirrors bounded to 100 with normalized total counts, project/config/provider/data-class-bound consent ledger with preview/grant/revoke, and a project-scoped semantic assessment cache keyed by stable artifact-content digest plus finding-claim identity, rubric, model, and redaction identity whose reused results are explicitly marked non-fresh are implemented. Dashboard now exposes all normalized finding filters and explicitly marks partial/unknown coverage and cached assessment results; hostile-browser/full E2E remains open. |
| M6 hardening | berjalan (checkpoint) | Latest full Python suite: 448 passed, 0 skipped, 2 dependency warnings in 94.27s; the preceding full scripts/check.sh gate passed 447 tests. Ruff check/format and mypy pass across the current source set. Vitest 2/2; Chrome E2E 1/1 (20.5s) and the separate Playwright WebKit E2E 1/1 pass with dashboard empty/loading/error checks, foreign-project isolation, and the active-worker egress regression. The fresh wheel clean-install probe passes with the backup/restore CLI and rebuilt UI bundle. Pinned Linux arm64 and emulated amd64 container suites each passed 427 with 14 capability skips on 24 September; the latest backup/purge/API regression slice also passed 36 tests in the arm64 container with pytest networking disabled. The full `scripts/check.sh` passed on 24 September after rollback additions, including the fresh seven-ecosystem OSV database and all 18 dependency controls. The current ledger has 19 pass and 5 blocked; see `docs/TEST_RESULTS.md` and `docs/acceptance-results.json`. |

## Requirement tracking

| Requirement | Status | Evidence and remaining work |
|---|---|---|
| FR01 config/init/doctor | berjalan | Workspace, strict YAML, path, pairing, doctor, descriptor-relative capture, read-only Git commit/dirty metadata when available, post-open directory-entry revalidation, stable child-directory/file inode binding, owner/nlink checks, and database replacement detection before first connection, on connection, and on checkout pass locally; the cross-platform path-race matrix remains. |
| FR02 graph | berjalan | Python/FastAPI graph, normalized graph entity persistence/SQL pagination, node-kind/source-path filters in API and dashboard, keyboard-selectable edge detail with source location/provenance, explicit import-aware agent/tool/LLM/retriever inventory, 55 tuning plus 12 authored holdout definition/route cases, and an 11-case inventory expected-node/edge corpus are tested; dynamic reachability and other languages are not inferred. |
| FR03 SAST | berjalan (local integration) | Managed Semgrep binary/rule pinning, digest-pinned container execution, bounded transient version probing, owner-only staging, macOS default-deny Seatbelt containment, non-macOS no-host-fallback behavior, positive/negative fixture execution, pinned Linux amd64 production-source smoke, missing-engine and managed-config-override behavior, malformed/non-zero/empty/oversized-output/timeout failure handling, fail-closed revalidation paths, and baseline persistence are tested; broader compatibility and recall remain. |
| FR04 dependency scanning | berjalan (offline local integration) | OSV database provisioning is a separate bounded setup action; the full gate freshly provisioned the pinned-container database on 24 September at 291,813,642 bytes for Cargo, Composer, Go, Maven, npm, Python, and Ruby. Scan argv is offline-only, database age/change is checked, lockfile capture and deterministic advisory alias canonicalization are supported, vulnerable packages without a version and ranged requirements/npm specs remain visible as unknown candidates, and manifest uncertainty is suppressed only by a structurally usable `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, or `yarn.lock`. Targeted vulnerable/fixed controls pass for Python, uv.lock, npm, Cargo, Go, Ruby, Composer, and Maven, plus unpinned/ranged controls. Clean-host, full lockfile/advisory recall, and cross-platform freshness matrices remain. |
| FR05 secrets | lulus acceptance lokal terbatas | Managed Trivy secret-only execution through the macOS host worker and digest-pinned container worker, pinned Linux amd64 production-source smoke, positive/negative filesystem fixtures, field-aware redaction, temporary staging, and persistent-artifact checks pass locally. The full Python suite (448 passed) includes a cross-sink regression proving a synthetic value is absent from the report, API, exports, hosted request, storage, logs, stdout, and stderr; broader formats and platform, licensing, and clean-host matrices remain. |
| FR06 normalization | berjalan | Stable fingerprints, normalized findings/evidence, source attribution, signed keyset findings cursors, explicit advisory aliasing, conservative cross-engine correlation with preserved member evidence, and default baseline scanner wiring are tested. |
| FR07 approval | lulus acceptance lokal | Plan/scope digest mengikat rubric canonical. Preview menampilkan project, target revision dan IP, profile/case/rubric digest, snapshot, auth identity, data classes, seluruh budget, approver, dan TTL. AC07 test matrix lulus untuk perubahan scope, tanpa approval, expiry/revocation, paralel satu pemenang, dan idempotency conflict. Legacy plan tanpa IP binding harus dibuat ulang; profile yang tersedia saat ini hanya core. |
| FR08 runner | berjalan (bounded local/staging) | Broker enforces loopback or public-HTTPS DNS pinning, canonical plan-bound IP-set revalidation on every dispatch, direct socket/SNI preservation, path/method scope, payload/response bounds, attempts, concurrency, absolute wall-time deadlines during response reads, no redirects, cancellation, and per-case macOS Seatbelt or Linux bubblewrap active workers restricted to a job-scoped broker Unix socket for dispatch/cancel/stats; the current macOS runtime regression proves direct loopback TCP is denied while broker-socket access works; native Linux bubblewrap acceptance remains open; independent observer requirements for effect/retrieval claims and queue-time strict cost rejection without trusted target-side control remain enforced. Request-only runs expose unknown target cost. Live staging and production integrations remain unverified. |
| FR09 OWASP coverage | berjalan (fixed subset) | Ten categories are represented and each has one bounded local fixed case; active reports expose the selected profile digest, explicit selected-case denominator, and preserve planned, blocked, executed, skipped, error, and inconclusive states, while static reports mark all categories not tested. The dashboard summarizes each state, including skipped, without turning missing ground truth into a pass. The response-marker cases are contract fixtures, not full category effectiveness or certification. |
| FR10 Jev | berjalan (mock-only) | Typed provider and assessment boundary, bounded request/response streaming, probability/confidence validation, retry/error policy, resolved-model pin validation, project-scoped semantic assessment cache keyed by stable artifact-content digest/finding-claim identity/rubric/model/redaction identity with explicit non-fresh cache labeling, the adversarial no-authority fixture, and the 120-case bilingual local benchmark are tested; live verification and independent evaluator acceptance remain. |
| FR11 dashboard | berjalan | Pairing, session, Host/Origin/CSRF/project checks, consistent security headers on success and error paths, bounded static-report overview including persisted assessment mirrors with normalized total counts, complete high/critical candidate-priority summary, selected-run normalized SQL-backed findings/graph pagination with keyboard-accessible next-page controls, graph node-kind/source-path filters, keyboard-selectable graph edge detail with location/provenance, inert HTML payload rendering in report/findings/graph views, explicit active-suite profile digest and selected-case denominator, coverage status counts for planned/blocked/executed/skipped/inconclusive/error/not-tested, severity/validation/lifecycle/kind/path finding filters, explicit partial/expired-evidence notices, engine capability details including OSV database age, run/session-bound generation guards that prevent stale report, history, consent, and polling responses from overwriting the selected view, safe unavailable handling for corrupt assessment storage, actionable stale/closed plan and approval errors, empty selector rejection without latest-resource fallback, foreign/nonexistent selected-report rejection with stale-view cleanup, project-scoped run history including terminal cancelled active runs, active-run restoration after a browser refresh, evidence view, complete normalized assessment export routes, and active plan/approval/run/cancel/per-case UI work; full Chrome and Playwright WebKit E2E pass locally, while Firefox cannot launch on macOS 27.0 and native cross-platform browser acceptance remains open. |
| FR12 lifecycle | berjalan | Revision-checked acknowledge/resolve/suppress/reopen updates, audit events, expiry-aware suppression, conservative reopened diff with worker/scanner/profile identity checks, project-scoped comparison endpoint, dashboard lifecycle/history controls, all normalized finding filters, and explicit partial/not-observed/expired-evidence messaging are implemented; hostile-browser and adversarial history matrix remains. |
| FR13 export/CI | berjalan (limited) | JSON/escaped HTML, 0/1/2/3/130 helper semantics, fail-closed error fields, case-insensitive supported/confirmed severity gates, and a 16-case CI policy matrix covering state/error/severity combinations are covered. Candidates do not fail the supported/confirmed severity gate; broader CLI/export permutation coverage remains. |
| FR14 data/connections | berjalan (limited) | A disposable full static baseline completed locally with Semgrep, OSV, and Trivy under macOS default-deny Seatbelt isolation and a pre-provisioned local OSV database. A controlled managed-scanner runtime probe confirms Seatbelt denies a TCP connection to an active loopback listener. Tests verify that Jev is not called without consent/key, project A's consent does not authorize project B, and the browser preview displays `api.typesafe.ai` plus `metadata`, `code_excerpt`, and `response` before hosted assessment is enabled. Non-macOS digest-pinned scanner boundaries, explicit network-enabled OSV provisioning, broker boundaries, and redaction are implemented; the active Linux worker sandbox uses bubblewrap but lacks native-host acceptance. Full cross-platform egress and live provider acceptance remain open. |
| FR15 evidence | berjalan | Snapshot/evidence references, read-only Git commit/dirty metadata when available, normalized artifacts, redacted digests, run/attempt/sequence-bound fixture runtime trace requirements, run-bound `test_context.observer_context` metadata, bounded HMAC-signed JSON ingress, capability-protected Unix socket transport, API/background/CLI observer wiring, owner-only secret-file validation, replay/attempt binding checks, integrity checks, and expiry purge across normalized rows/report mirrors exist; production signer/approved sidecar deployment remains. |
| FR16 recovery | berjalan (static + lease) | Durable static/active ledger, pre-dispatch in-flight markers, recovery marking, per-case active attempts, idempotency, interruption, owned-container cleanup, worker leases, active heartbeats, dispatch-crash recovery, actual worker-process-kill recovery, and completed-attempt preservation across report-write crashes are tested. |
| FR17 contracts | berjalan (managed contract for optional engines) | Strict worker, scanner argv/output, digest-pinned container lifecycle, capability manifests (including supported modes and explicit supported patterns), broker, Promptfoo bridge, Jev contracts, and offline dependency/source/hash ledger validation are tested. Third-party version/license compatibility and live integrations are not verified. |
| FR18 validation | berjalan (limited) | Last full macOS suite before the latest AC03/AC09 regression additions had 448 passing tests, 0 skips, and 2 dependency warnings. Follow-up targeted runs passed 78 active-runner/broker/policy tests, 46 scanner unit/management tests, 1 real Semgrep fixture, and 6 Promptfoo tests; the full suite has not been rerun after those additions. Current Vitest has 2 passes; Chrome and Playwright WebKit E2E each pass 1 test, including explicit dashboard empty/loading/error states. Ruff check/format and mypy over 63 source files passed at the latest broad checkpoint; a focused mypy run on the changed active service also passes. The full local check script passed UI build, wheel/sdist packaging, clean install, scanner checks, fresh OSV provisioning, and 447 Python tests before the AC05 cross-sink regression; the full suite then passed 448 tests; the backup/purge/API slice also passed 36 tests in a network-disabled Linux arm64 container. Offline database backup/restore supports app rollback without destructive Alembic downgrades. Pinned Linux arm64 and emulated amd64 container suites each had 427 passes and 14 capability skips on 24 September. Dependency ledger, migration, scanner, benchmark, native-platform, legal license, and live evaluator evidence remains from earlier checkpoints or open external gates. The Linux runs are container compatibility slices, not native Linux-host release acceptance. Clean-host scanner/database verification, platform isolation, license review, and live evaluator gates remain. |

Completed-tested subcomponents are narrowly those covered by passing tests, not
whole FR/AC rows. A capability marked blocked or unavailable is not represented
as a clean scan, pass, or production guarantee.

## Exact next steps

Latest local hardening checkpoint (24 September 2026): the real Chrome E2E
now serves an adversarial page from a second loopback port and verifies that its
credentialed logout request receives HTTP 403, its response is opaque, session
data cannot be read through CORS, and the legitimate session remains usable.
It also checks HttpOnly/SameSite/host cookie attributes, JavaScript cookie
invisibility, rejection of a reused pairing code, cookie removal on logout,
server rejection of the old cookie, and the pairing screen after reload.
The Chrome disposable-project E2E verifies the hosted Jev consent preview's
exact domain and data classes; the full flow also passes on Playwright WebKit.
Firefox headless automation fails before assertions on macOS 27.0 with a profile
selection error. A fresh seven-ecosystem pinned OSV database and a disposable
offline baseline with all three static scanners also completed. These results
narrow the local browser, scanner, and consent gates without claiming platform,
clean-host, or live-provider acceptance.

1. Run the remaining cross-platform path-race matrix and concurrent stress
   slice on clean Linux/macOS runtimes. The current Python suite passes on macOS
   and both pinned Linux architectures, but the complete isolation matrix is
   still open.
2. Repeat the scanner matrix on clean Linux/macOS runtimes using both the
   macOS host path and the digest-pinned container images, and verify
   third-party licenses without depending on this host's Homebrew installation;
   targeted vulnerable/fixed controls and advisory-alias fixtures are now in the
   pinned local smoke.
3. Connect the signed JSON ingress to an approved production sidecar using
   `test_context.observer_context`. The local AC13 browser/API acceptance now
   covers the listed empty/loading/error states, hostile Origin/Host, cross-project
   resource IDs, XSS, assessment history, consent, active execution, cancellation,
   export, and logout on Chrome and WebKit. Firefox startup on macOS 27.0 and
   native cross-platform browser coverage remain open.
4. Run Jev live verification and an independently held-out 120-case evaluation
   only with explicit credentials and consent; the local 120-case contract
   benchmark is now recorded, but it is not a provider-accuracy claim.
5. Close Firefox/native cross-platform browser coverage, the Linux/macOS
   isolation matrix, cross-platform packaging, and the full benchmark matrix
   (browser startup, warm third-party scanners, cold install, and cross-platform
   runs) before calling the product MVP-complete. The wheel clean-install probe
   is repeatable; clean-host image/database provisioning and packaging verification
   remain open.

On 23 September, `sh scripts/check.sh` stopped at OSV database setup after a
300-second timeout. That result was superseded on 24 September: the full script
then completed successfully with a fresh digest-pinned seven-ecosystem database,
all 18 dependency controls, the 447-test Python suite before the AC05 regression addition, active-worker sandbox checks, browser checks, packaging,
and clean install. The earlier timeout remains only as historical context.

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
