# Proof test harness: handwritten tests (2026-11-04)

Developer qualification of M11a, the proof test harness
([design/proof-tests.md](../design/proof-tests.md)), with `pnpm qualify:proof`.
Each test was written by hand; no model was called and no API credentials were
used. Project code and tests ran only inside the networkless proof containers.

| Item | Value |
| --- | --- |
| Host | macOS Apple silicon |
| Backend | Podman 6.0.2 (libkrun machine), `linux/arm64` |
| Python image | `sha256:f8ed0073b2304ea5f070436300672f1de7af2a0475ed5d7694b2beb8cea2344c`, base `python:3.12.13-slim-bookworm@sha256:3f9c7f75b916e8279e24136d7a57769aba9e193715be52570417698c52d6eed0` |
| Node image | `sha256:2674a6985d0690680e0c15b252586acb90d596e88ed3ca867aed0d2a64f2eaf6`, base `node:22.23.4-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd` |
| Python packages | fastapi 0.162.0, flask 3.1.3, httpx 0.28.1, jinja2 3.1.6, langchain-core 1.7.4, numpy 2.5.4, openai 3.45.0, pydantic 2.14.2, pyyaml 6.0.3, requests 2.34.2, sqlalchemy 2.1.8, werkzeug 3.1.9, itsdangerous 2.2.0 (wheels resolved with `--exclude-newer 2026-11-04`) |
| Node packages | ai 7.0.29, express 5.3.0, zod 4.4.3 |
| Isolation checks | The 18 of the llmfy worker (Python) and the 16 of the Vercel worker (Node), all reported |

Results, 27 tests passed in `test/proof-runtime.test.ts`:

| Pair | Weakness | Family | Vulnerable twin | Safe twin |
| --- | --- | --- | --- | --- |
| `py-path-tool-pathlib`, `py-path-tool-confined` | CWE-22 | Python | Proven | Not reproduced |
| `py-route-send-file-joined`, `py-route-send-file-directory` | CWE-22 | Python | Proven | Not reproduced |
| `ts-route-report-read`, `ts-route-report-read-confined` | CWE-22 | TypeScript | Proven | Not reproduced |
| `ts-route-doc-unpacked-query`, `ts-route-doc-unpacked-checked` | CWE-22 | TypeScript | Proven | Not reproduced |
| `py-shell-tool`, `py-shell-tool-allowlist` | CWE-78 | Python | Proven | Not reproduced |
| `py-route-ping-shell`, `py-route-ping-allowlist` | CWE-78 | Python | Proven | Not reproduced |
| `py-route-host-helper-shell`, `py-route-host-helper-lookup` | CWE-78 | Python | Proven | Not reproduced |
| `ts-route-git-log-exec`, `ts-route-git-log-allowlist` | CWE-78 | TypeScript | Proven | Not reproduced |

Ten tests that try to fake a proof were never Proven:

| Attempt | Outcome |
| --- | --- |
| The test reads the canary itself | Not reproduced; the harness refused the read |
| The test passes a callback that reads the canary, in Python and in Node | Not reproduced; the harness refused the read |
| The test replaces a project setting (`tools.CHECKS`) | Could not run |
| The test replaces `pathlib.PurePath.is_relative_to` | Could not run |
| The test points an environment variable outside its folder | Could not run |
| The test writes the command canary or starts a shell itself | Not reproduced; the harness refused both |
| The test replaces `String.prototype.startsWith` | Could not run |
| The test replaces `os.path.realpath`, and `String.prototype.startsWith`, and restores each before the case ends | Could not run |

Each run took 0.5 to 1.8 seconds. Building the images took a few minutes the
first time; later runs reuse them.

Two things the harness got wrong were found and fixed during this work, before
the run above. A Python test could assign a project attribute at its top level
before the harness recorded the modules; the host now allows only plain names
there. And a changed `String.prototype.startsWith` also changed the harness's own
path checks; the harness now uses functions it saved before the test loaded.

This is harness evidence on 16 corpus cases and 4 small fixtures. It does not
measure a model writing tests, which is M11b, and it does not cover tests written
to defeat the harness; see the threats in the design.
Status: [../STATUS.md](../STATUS.md).
