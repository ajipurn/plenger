# Static detection: name sanitizers, more route sinks and an advisory benchmark, 2026-10-20

This change set covers six things:

- It reads file names that a sanitizer has stripped of separators, and absolute paths
  among a program's arguments.
- It adds four web route rules (PLG804 to PLG807) and SQL sinks for Django,
  SQLAlchemy `text`, Sequelize and TypeORM.
- It reads routes in Starlette, aiohttp, Koa and NestJS.
- It reparses JSX that the JavaScript grammar rejects, and parses larger projects on
  worker threads.
- It adds `plenger-ignore` comments.
- It adds a benchmark of reviewed GitHub advisories, `scripts/advisories.ts`.

Two precision changes came from measuring on real projects:

- A database lookup's row no longer carries the values it was found by. Stored data
  is therefore not traced (second-order injection).
- A test whose block ends in `abort()` or `sys.exit()` now protects the code after
  it.

## Evaluation corpus

The corpus has 118 labeled cases in `test/fixtures/evaluation`: 60 vulnerable and 58
safe near-misses. The twelve new cases are six pairs, written alongside the change:

| Pair | Vulnerable | Safe |
| --- | --- | --- |
| Avatar folder name (CWE-22) | `os.path.basename`, which can be `..`, as a directory | `secure_filename` |
| ffmpeg input (CWE-88) | the request's value as an argument | a helper's `path.resolve` result |
| Webhook callback (CWE-918) | a callback URL from the body, through a helper | its host checked against a fixed set before `abort(400)` |
| Formula (CWE-95) | `Function` of the request's formula, through a helper | two numbers added |
| Mail template (CWE-1336) | `jinja2.Template` of the request's template | Jinja's sandboxed environment |
| Session restore (CWE-502) | `node-serialize` of a query parameter | `JSON.parse` |

| Scanner | Cases | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cba368a`, before | 106 | 47 | 0 | 7 | 52 | 1.00 | 0.87 |
| `cba368a`, before | 118 | 49 | 2 | 11 | 56 | 0.96 | 0.82 |
| This change | 118 | 53 | 0 | 7 | 58 | 1.00 | 0.88 |

On the avatar and ffmpeg pairs, the old scanner reported both safe twins. It reports
nothing on the other four pairs, which need the new rules. The same seven false negatives as
in the [2026-10-19 record](detection-static-2026-10-19.md#evaluation-corpus) remain:

- two Go and Java cases;
- five authorization cases.

## Open-source projects

The same six snapshots as the
[2026-10-17 record](detection-static-2026-10-17.md#open-source-projects) were
scanned read-only by `cba368a` and by this change.

| Project | Findings before | Findings after | Files with syntax errors, before / after |
| --- | --- | --- | --- |
| SuperAGI | 17 | 17 | 3 / 0 |
| ai-chatbot | 0 | 0 | 0 / 0 |
| anything-llm | 6 | 6 | 25 / 0 |
| crewAI-examples | 0 | 0 | 0 / 0 |
| gpt-researcher | 0 | 0 | 0 / 0 |
| openai-agents-python | 0 | 0 | 0 / 0 |

On anything-llm, all six earlier findings are gone. They were false positives,
listed in the [2026-10-20 record](detection-static-2026-10-20.md#open-source-projects).
The name sanitizers, the absolute arguments and `isWithin` now account for them:

- `slugify` with a host and a dash;
- `sanitizeFileName` on a name with fixed letters;
- `path.parse(filename).name` with `.wav`;
- the resolved input and output paths among `ffmpeg`'s arguments.

Six PLG804 findings at medium confidence replace them. They cover the two
link-processing routes, `POST /process-link` and `POST /util/get-link`, each fetching
the request's `link` in three places. The flow is real. The project documents it in
`collector/utils/url/index.js`: URL checks do not defend against SSRF, `127.0.0.1` is
allowed on purpose, and only privileged users can submit links through the signed
server-to-collector request. These are accepted risks of the product rather than
analysis errors; a `plenger-ignore PLG804` comment records that decision in the
source.

Before the database lookup change, SuperAGI gained three PLG805 findings. Each one
called `eval` on a configuration value read from the database by a request's id.
The value is stored data, not request input, so the title was wrong; they are gone.
SuperAGI's one route finding is still the upload written to
`os.path.join(save_directory, file.filename)`.

With the JSX reparsing, every file in the six snapshots now parses without syntax
errors. 28 files had errors before:

- 27 frontend components, with `<Skeleton.default>`, `in=` on SVG filters, or a bare
  `&` in JSX text or attributes;
- one build script, with `assert { type: "json" }`.

Parsing on worker threads changed no result. On scans of a whole project it cut wall
time from 3.5–4.1 s to 2.0–2.1 s on anything-llm (1,247 files), and from 7.5–7.8 s
to 4.4 s on openai-agents-python (1,034 files). These are two runs each on a laptop
with 8 cores.

## Advisory benchmark

`scripts/advisories.ts` measures the static rules on code that someone else found
vulnerable. `select` queried the GitHub advisory database on 2026-10-20 and kept every
advisory that met all of these:

- it is reviewed;
- it is for one of 52 AI and agent packages on PyPI and npm;
- its CWE is one the static rules target;
- it has exactly one fix commit on GitHub, which changes 1 to 6 Python, JavaScript or
  TypeScript source files outside tests (at most 400 lines).

The rule was fixed before any scan. 105 advisories qualified, listed in
`test/fixtures/advisories/manifest.json`. By package: mlflow 29, vllm 12, open-webui
9, gradio 8, langchain 8, flowise 6, litellm 6, langflow 5, and 22 from other
packages.

For each advisory, `run` downloads the source files in and below the directories the
fix changed, at the fix's parent and at the fix. It takes up to two levels below and
150 files. It scans both versions read-only. A version counts as reported when a rule
of the advisory's weakness family (the CWE families in `scripts/lib/evaluation.ts`)
cites the code the fix changed: the innermost function around each changed hunk,
through the finding's location or an evidence step. Nothing downloaded was run.

| Scanner | Reported before the fix | Of those, not reported after it | Reported after the fix |
| --- | --- | --- | --- |
| `cba368a` | 3 of 105 | 0 | 5 |
| This change | 4 of 105 | 2 | 4 |

| Weakness | Advisories | Reported before the fix | Reported after the fix |
| --- | --- | --- | --- |
| Path traversal | 40 | 3 | 2 |
| SSRF | 26 | 0 | 1 |
| Code injection | 21 | 1 | 1 |
| Command injection | 7 | 0 | 0 |
| Deserialization | 6 | 0 | 0 |
| SQL injection | 5 | 0 | 0 |

The advisories reported:

| Advisory | Before the fix | After the fix | What the fix does |
| --- | --- | --- | --- |
| agentscope GHSA-c4cc-w454-4634 | PLG802 | none | `endswith(".json")`, then `os.path.basename`, before a delete |
| gradio GHSA-rhq2-3vr9-6mcr | PLG802 | none | werkzeug's `safe_join` in place of the project's own `secure_filename` |
| dbgpt GHSA-j9g7-mqhh-9hxf | PLG802 | PLG802 | `basename`, then a substring check `ROOT in target_path`, which plenger does not read as confinement |
| litellm GHSA-72m8-9m7m-h278 | PLG805 | PLG805 | an admin check, a pattern blocklist and empty builtins; request code is still run with `exec` |
| langchain GHSA-gr75-jv2w-4656 | none | PLG104 | the fixed loader adds a tool path that the rule reports; not the advisory's flaw |
| langchain-community GHSA-h5gc-rm8j-5gpr | none | PLG705 | the fix adds `allow_dangerous_requests`, which the rule reports where it is set |

The two fixes that clear their findings did so after this change taught plenger
their checks: the suffix check before `basename` and werkzeug's `safe_join`. That is
the benchmark doing its job. They are also measured on the code they were written for.

The 101 advisories not reported fall into four groups:

| Why | Advisories |
| --- | --- |
| No route or tool in the scanned files: library code whose callers pass the input (langchain loaders, llama-index, vllm), or routes registered elsewhere | 60 |
| Effects traced in the changed code, but no rule of the advisory's family fired | 21 |
| Routes registered elsewhere, not reaching the changed code | 13 |
| A route in the changed file, but no effect traced from it | 7 |

Among the 21, mlflow accounts for 12, and its advisories are mostly second-order. A
request stores a source or artifact location in the registry, and a later request
reads files from it. plenger does not trace stored data. Other misses use sinks or
request parsing it does not know:

- protobuf request messages;
- a chainlit file element fetched by URL;
- bentoml's request body deserializer.

The recall on this benchmark is 4%. The rules are built for flows from a route or a
tool to an effect in the same project. Most published flaws in AI frameworks are in
library code, or are second-order, and both are outside that model. The corpus figures
above describe the patterns the rules target. This benchmark describes how much of
the published record those patterns cover.

## Gaps

- Stored data is not traced: a value read from the database is not request input,
  however it was written.
- The advisory benchmark scans the directory of each changed file and up to two
  levels below it, at most 150 source files, not the whole package. A flow that
  crosses into another directory is not seen there.
- A name sanitizer the code defines itself is read only when it is built from the
  calls listed in the [scanning guide](../guide/scanning.md#capabilities). Other
  helpers still leave a finding.
- Typed parameters are not resolved, so methods called on a FastAPI `Session`
  dependency are not known sinks unless the SQL text goes through `sqlalchemy.text`.
