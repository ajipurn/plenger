# Static detection with web route rules, 2026-10-19

The change adds three rules for request input in web routes, with no model in
between, and reads path checks inside project helpers:

- PLG801: request input in a command, as the shell command, the program or its
  arguments.
- PLG802: request input in a file path.
- PLG803: request input in SQL text.

The rules follow the route handler into project functions in other files, as the
tool rules do. Request input is a handler parameter or a request global
(`flask.request`). These do not count:

- FastAPI parameters filled by `Depends` or `Security`;
- FastAPI parameters typed as a number, boolean, UUID or date, which FastAPI
  validates before the handler runs;
- response parameters (`res`, `response`, `next`).

A path that a project function returns now counts as checked when the function
resolves it and checks it stays inside a base. This applies to tools too.

## Evaluation corpus

The corpus has 102 labeled cases in `test/fixtures/evaluation`: 52 vulnerable and
50 safe near-misses. The ten new cases are five pairs:

- a FastAPI shell command whose binary comes from a `Depends` settings object;
- Flask SQL in a repository module;
- an Express file read through a helper;
- an Express command through a helper;
- Express SQL with `pg` in a repository module.

Each safe twin differs in one deciding check: a fixed allowlist, a placeholder or
a confining helper. A finding counts for a case when it overlaps the labeled lines.
The corpus is small and synthetic, and these cases were written alongside the rules.

| Scanner | Cases | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `d3fd5f2`, before | 92 | 38 | 0 | 9 | 45 | 1.00 | 0.81 |
| `d3fd5f2`, before | 102 | 38 | 0 | 14 | 50 | 1.00 | 0.73 |
| This change | 102 | 45 | 0 | 7 | 50 | 1.00 | 0.87 |

The old scanner reports nothing on any of the ten new cases.

| Rule | Vulnerable cases | Safe cases | Precision |
| --- | --- | --- | --- |
| PLG801 | 2 | 0 | 1.00 |
| PLG802 | 3 | 0 | 1.00 |
| PLG803 | 2 | 0 | 1.00 |

Two earlier path cases now get PLG802:

- `py-path-helper-unconfined`;
- `py-ticket-file-path-unconfined`, whose deciding helper is three packages away
  from the route.

Their confined twins stay clean because the helper's own check is read.

Seven false negatives remain:

- Two are in Go and Java, which have no parser.
- Five are authorization weaknesses, which no static rule covers:
  - `py-invoice-number-unscoped`;
  - `py-tenant-unscoped-repository`;
  - `ts-exports-mount-no-role`;
  - `ts-idor-route`;
  - `ts-route-missing-auth`.

## Open-source projects

The same six snapshots as the
[2026-10-17 record](detection-static-2026-10-17.md#open-source-projects) were
scanned read-only by `d3fd5f2` and by this change. Nothing was installed or run.
No earlier finding changed. New findings:

| Project | Finding | Verdict |
| --- | --- | --- |
| SuperAGI | PLG802 high/high, `POST /add/{agent_id}` writes `os.path.join(save_directory, file.filename)` | True positive. The upload's client-supplied file name is joined unchecked; only the separate `name` form field is checked for an extension. The route needs a JWT where `check_auth` enforces one |
| anything-llm | PLG802 high/medium, `POST /util/convert-audio-to-wav` creates the output directory | False positive. The path is built from `path.parse(filename).name`, and the input path is checked with the project's own `isWithin`. The `basename` check lowered confidence; the project's check is not read |
| anything-llm | PLG801 medium/medium, the same route passes the input path to `ffmpeg` arguments | False positive. The argument is that checked, absolute path, so it cannot start with `-` |

Before the scalar and program fixes, the run also reported three false
positives:

- SuperAGI paths read from a database row looked up by an `int` id;
- anything-llm, where `ffmpeg` was reported as "a program named by request
  input".

So on these snapshots, one of the three new findings is real.

## Gaps

- Data flow over-approximates call results: a value returned by a call is taken to
  depend on every argument, so a row looked up by a request id counts as request
  input unless the id is a typed FastAPI scalar.
- Checks in project functions are read only for returned paths. A function that
  returns a boolean (`isWithin(base, path)`) is not read as a check.
- Typed parameters are not resolved, so `session.execute(...)` on a FastAPI
  `Session` dependency is not a known SQL sink.
- Authorization and Go or Java code stay with the AI review.
